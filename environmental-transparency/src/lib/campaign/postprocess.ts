import "server-only";
import { geminiUsage, lastModel, summarizeRecords } from "@/lib/gemini";
import { getAdmin } from "@/lib/supabase/admin";
import { decodeFeed, fixC1, groupBySch, parseFeed, type CeqaFiling } from "@/lib/campaign/ceqa-feed";
import { upsertParticipation } from "@/lib/campaign/index-light";
import { getObject } from "@/lib/storage";
import { STORAGE_BUCKET } from "@/lib/config";
import { checkSummary, cleanDescription, cleanName, developerFromTitle } from "@/lib/campaign/clean";
import { STATUS_LABELS, CATEGORY_LABELS, type ProjectCategory, type ProjectStatus } from "@/types/project";

/**
 * Post-processing of stored records (no retrieval, no Bright Data):
 *  1. cleanup: names (ALL CAPS, prefixes, whitespace, encoding artifacts), description whitespace,
 *     developer named in the official title, encoding artifacts in fact values/quotes;
 *  2. summaries: grounded plain-language summaries for records that have none, generated in small
 *     batches from the stored description and structured fields, number-checked, labeled AI-generated.
 * Idempotent: re-running only touches what still needs work.
 */

type Row = Record<string, unknown>;
async function all(build: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let a = 0; ; a += 1000) {
    const { data, error } = await build(a, a + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) return out;
  }
}

export async function cleanupRecords() {
  const db = getAdmin();
  const projects = await all((a, b) => db.from("projects").select("id, canonical_name, description, developer").order("id").range(a, b));
  const r = { names: 0, descriptions: 0, developers: 0, facts: 0, examples: [] as string[] };
  for (const p of projects) {
    const update: Row = {};
    const name = cleanName(String(p.canonical_name));
    if (name !== p.canonical_name) {
      update.canonical_name = name;
      r.names++;
      if (r.examples.length < 8) r.examples.push(`${p.canonical_name} → ${name}`);
    }
    if (typeof p.description === "string") {
      const d = cleanDescription(p.description);
      if (d !== p.description) {
        update.description = d;
        r.descriptions++;
      }
    }
    if (!p.developer) {
      const dev = developerFromTitle(String(p.canonical_name));
      if (dev) {
        update.developer = dev;
        r.developers++;
        const { data: doc } = await db.from("documents").select("id").eq("project_id", p.id).order("publication_date", { ascending: false }).limit(1);
        await db.from("facts").insert({
          project_id: p.id,
          document_id: doc?.[0]?.id ?? null,
          field: "proponent.applicant",
          value: dev,
          method: "parsed",
          page_or_passage: JSON.stringify({ quote: `Project Title: ${p.canonical_name}`, label: "Applicant named in the official project title" }),
          review_status: "validated",
        });
      }
    }
    if (Object.keys(update).length) {
      const { error } = await db.from("projects").update(update).eq("id", p.id);
      if (error) throw new Error(`project cleanup failed: ${error.message}`);
    }
  }
  // Encoding artifacts in fact values and quotes.
  const facts = await all((a, b) => db.from("facts").select("id, value, page_or_passage").order("id").range(a, b));
  for (const f of facts) {
    const v = typeof f.value === "string" ? fixC1(f.value) : f.value;
    const q = typeof f.page_or_passage === "string" ? fixC1(f.page_or_passage) : f.page_or_passage;
    if (v !== f.value || q !== f.page_or_passage) {
      await db.from("facts").update({ value: v, page_or_passage: q }).eq("id", f.id);
      r.facts++;
    }
  }
  return r;
}

function recordText(p: Row, facts: Row[]): string {
  const fv = (field: string) => (facts.filter((f) => f.field === field).at(-1)?.value as string | undefined) ?? null;
  const lines = [
    `Title: ${p.canonical_name}`,
    `Category: ${CATEGORY_LABELS[p.category as ProjectCategory] ?? p.category}`,
    `Status: ${STATUS_LABELS[p.status as ProjectStatus] ?? p.status}`,
    `Lead agency: ${fv("identity.lead_agency") ?? "not stated"}`,
    `Location: ${p.jurisdiction ?? "not stated"}`,
    fv("identity.document_type") && `Latest CEQA document: ${fv("identity.document_type")}`,
    fv("identity.development_types") && `Development types: ${fv("identity.development_types")}`,
    fv("timeline.public_review_period_end") && `Public review period ends: ${fv("timeline.public_review_period_end")}`,
    `Description: ${String(p.description ?? "").slice(0, 2200)}`,
  ];
  return lines.filter(Boolean).join("\n");
}

export async function summarizeMissing(opts: { maxMs: number; maxGeminiCalls: number; batchSize?: number }) {
  const t0 = Date.now();
  const db = getAdmin();
  const batch = opts.batchSize ?? 12;
  const r = { attempted: 0, written: 0, rejected: [] as { name: string; problems: string[] }[], nullFromModel: 0, geminiCalls: 0, remaining: 0, model: null as string | null, errors: [] as string[] };
  const missing = await all((a, b) => db.from("projects").select("id, canonical_name, category, status, jurisdiction, description").is("summary", null).order("id").range(a, b));
  const g0 = geminiUsage.calls;
  // Records already attempted this run (model returned null or the summary failed grounding) are skipped.
  const skip = new Set<string>();
  let i = 0;
  while (i < missing.length && Date.now() - t0 < opts.maxMs && geminiUsage.calls - g0 < opts.maxGeminiCalls) {
    const group = missing.slice(i, i + batch);
    i += batch;
    const ids = group.map((p) => p.id as string);
    const facts = await all((a, b) => db.from("facts").select("project_id, field, value").in("project_id", ids).order("id").range(a, b));
    const texts = new Map(group.map((p) => [p.id as string, recordText(p, facts.filter((f) => f.project_id === p.id))]));
    // Short numeric ids keep the model from mangling UUIDs.
    const keyOf = new Map(group.map((p, k) => [String(k + 1), p.id as string]));
    r.attempted += group.length;
    let out: { id: string; summary: string | null }[];
    try {
      out = await summarizeRecords([...keyOf.entries()].map(([k, id]) => ({ id: k, text: texts.get(id)! })));
    } catch (err) {
      r.errors.push(err instanceof Error ? err.message.slice(0, 300) : String(err));
      continue;
    }
    if (out.length === 0) r.errors.push("Model returned no usable entries for this batch");
    for (const s of out) {
      const id = keyOf.get(s.id);
      if (!id) continue;
      const p = group.find((x) => x.id === id)!;
      if (!s.summary) {
        r.nullFromModel++;
        skip.add(id);
        continue;
      }
      const v = checkSummary(s.summary, texts.get(id)!);
      if (!v.ok) {
        r.rejected.push({ name: String(p.canonical_name).slice(0, 80), problems: v.problems });
        skip.add(id);
        continue;
      }
      await db.from("projects").update({ summary: s.summary.trim() }).eq("id", id);
      await db.from("facts").insert({
        project_id: id,
        field: "summary.provenance",
        value: lastModel,
        method: "derived",
        page_or_passage: JSON.stringify({
          quote: "Plain-language summary generated from the stored State Clearinghouse description and structured fields only; every number it states was checked against that text.",
          label: "How the summary was made",
        }),
        review_status: "validated",
      });
      r.written++;
    }
  }
  r.geminiCalls = geminiUsage.calls - g0;
  r.model = lastModel;
  r.remaining = Math.max(0, missing.length - r.written - skip.size);
  return r;
}

/**
 * Backfills comment windows and agency contacts for every SCH-numbered project from the CEQAnet
 * exports already cached in storage (no network retrieval). Idempotent.
 */
export async function backfillParticipation() {
  const db = getAdmin();
  const { data: files, error } = await db.storage.from(STORAGE_BUCKET).list("cache/ceqanet-export", { limit: 200 });
  if (error) throw new Error(error.message);
  const filings: CeqaFiling[] = [];
  let exports = 0;
  for (const f of (files ?? []).filter((x) => x.name.endsWith(".csv"))) {
    const buf = await getObject(`cache/ceqanet-export/${f.name}`);
    if (!buf) continue;
    filings.push(...parseFeed(decodeFeed(buf)));
    exports++;
  }
  const groups = new Map(groupBySch(filings).map((g) => [g.sch, g.filings]));
  const schFacts = await all((a, b) => db.from("facts").select("project_id, value").eq("field", "identity.sch_number").order("id").range(a, b));
  const docs = await all((a, b) => db.from("documents").select("id, project_id, source_url, version").order("version").range(a, b));
  const byProject = new Map<string, string>();
  for (const f of schFacts) if (!byProject.has(String(f.project_id))) byProject.set(String(f.project_id), String(f.value));
  const r = { exports, filings: filings.length, projects: 0, eventsAdded: 0, contactsAdded: 0, noFilings: 0, failed: [] as string[] };
  for (const [pid, sch] of byProject) {
    const g = groups.get(sch);
    if (!g) {
      r.noFilings++;
      continue;
    }
    r.projects++;
    // Link to the earliest stored version of each filing URL (the record the structured fields came from).
    const docIdOf = (url: string) => (docs.find((d) => d.project_id === pid && d.source_url === url)?.id as string | undefined) ?? null;
    try {
      const out = await upsertParticipation(pid, g, docIdOf);
      r.eventsAdded += out.events;
      if (out.contact) r.contactsAdded++;
    } catch (err) {
      r.failed.push(`${sch}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
  }
  return r;
}
