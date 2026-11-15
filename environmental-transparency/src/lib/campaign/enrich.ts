import "server-only";
import { serpSearch, type SerpResult } from "@/lib/brightdata";
import { officialHost } from "@/lib/config";
import { runIngestion, type IngestReport } from "@/lib/pipeline/ingest";
import { retrieveSource } from "@/lib/sources/retrieve";
import { getJson, putJson, sha256 } from "@/lib/storage";
import { getAdmin } from "@/lib/supabase/admin";
import { linkDocumentToProject } from "@/lib/campaign/link";
import { serpCachePath } from "@/lib/campaign/store";
import type { PlannedProject } from "@/lib/campaign/index-light";

/**
 * Level-2 (deep) enrichment of an indexed project:
 *  1. CEQAnet: the latest review document and its notices/attachments → Gemini extraction →
 *     deterministic quote/number/date validation → environmental metrics, considerations, timeline,
 *     comment periods and hearings. CEQAnet is fetched directly (Bright Data declines .ca.gov).
 *  2. Municipal / agency supplement (Bright Data): one SERP query by SCH number and title, official
 *     hosts only; a result is attached only if its text contains the project's identifiers.
 */

const CAMPAIGN_CACHE_TTL = 14 * 864e5;
const CEQA_HOSTS = /^(ceqanet\.(lci|opr)\.ca\.gov|files\.ceqanet\.(lci|opr)\.ca\.gov)$/;

async function markEnriched(projectId: string, detail: string) {
  const db = getAdmin();
  const { data } = await db.from("facts").select("id").eq("project_id", projectId).eq("field", "index.level").limit(1);
  const passage = JSON.stringify({ quote: detail, label: "Record depth" });
  if (data?.[0]) await db.from("facts").update({ value: "enriched", page_or_passage: passage }).eq("id", data[0].id);
  else await db.from("facts").insert({ project_id: projectId, field: "index.level", value: "enriched", method: "derived", page_or_passage: passage, review_status: "validated" });
}

/** The filing to deep-read: the latest review-stage document (draft EIR/MND/NOP…), else the latest filing. */
export function enrichmentTarget(p: PlannedProject): string {
  const review = [...p.filings].reverse().find((f) => /^(EIR|MND|NEG|NOP|SIR|SBE|RIR|FIN|REV|EA|JD)$/.test(f.docType));
  return (review ?? p.filings[p.filings.length - 1]).portalUrl;
}

export async function enrichFromCeqa(p: PlannedProject, projectId: string): Promise<IngestReport> {
  const report = await runIngestion({
    mode: "url",
    url: enrichmentTarget(p),
    maxDocs: 3,
    campaign: { attachToProjectId: projectId, allowLocation: p.loc.mapReady, cacheTtlMs: CAMPAIGN_CACHE_TTL },
  });
  if (report.outcome === "created" || report.outcome === "updated" || report.outcome === "unchanged") {
    await markEnriched(projectId, "Enriched: official documents were read and each figure, date and deadline was checked against its verbatim source passage.");
  }
  return report;
}

/** SERP results cached by query, so a resumed or repeated task never re-spends a request. */
async function cachedSerp(query: string): Promise<{ results: SerpResult[]; cached: boolean }> {
  const path = serpCachePath(sha256(query));
  const hit = await getJson<{ at: string; results: SerpResult[] }>(path);
  if (hit && Date.now() - Date.parse(hit.at) < CAMPAIGN_CACHE_TTL) return { results: hit.results, cached: true };
  const results = await serpSearch(query);
  await putJson(path, { at: new Date().toISOString(), query, results });
  return { results, cached: false };
}

export function municipalQuery(p: PlannedProject): string {
  const title = p.title.replace(/["“”]/g, "").slice(0, 90).trim();
  return `"${p.sch}" OR "${title}" -site:ceqanet.lci.ca.gov -site:ceqanet.opr.ca.gov`;
}

export interface MunicipalResult {
  outcome: "linked" | "no_official_results" | "no_identity_match" | "failed";
  query: string;
  serpCached: boolean;
  officialCandidates: number;
  checked: { url: string; linked: boolean; basis: string | null; error?: string }[];
  report?: IngestReport;
}

export async function enrichFromMunicipal(
  p: PlannedProject,
  projectId: string,
  opts: { maxCandidates: number; knownUrls: Set<string>; caseNumbers: string[] },
): Promise<MunicipalResult> {
  const query = municipalQuery(p);
  const { results, cached } = await cachedSerp(query);
  const candidates = results.filter((r) => {
    try {
      const u = new URL(r.link);
      return officialHost(u) !== null && !CEQA_HOSTS.test(u.hostname) && !opts.knownUrls.has(r.link);
    } catch {
      return false;
    }
  });
  const out: MunicipalResult = { outcome: "no_official_results", query, serpCached: cached, officialCandidates: candidates.length, checked: [] };
  if (!candidates.length) return out;
  const latest = p.filings[p.filings.length - 1];
  const places = [...latest.cities, ...latest.counties.map((c) => `${c} County`)];
  for (const c of candidates.slice(0, opts.maxCandidates)) {
    try {
      const doc = await retrieveSource(c.link, { cacheTtlMs: CAMPAIGN_CACHE_TTL });
      const v = linkDocumentToProject(doc.text, { sch: p.sch, title: p.title, caseNumbers: opts.caseNumbers, places });
      out.checked.push({ url: c.link, linked: v.linked, basis: v.basis });
      if (!v.linked) continue;
      const basisLabel = { sch_number: "SCH number", case_number: "case number", title_and_place: "project title and place" }[v.basis!];
      const report = await runIngestion({
        mode: "url",
        url: c.link,
        maxDocs: 2,
        campaign: {
          attachToProjectId: projectId,
          allowLocation: p.loc.mapReady,
          cacheTtlMs: CAMPAIGN_CACHE_TTL,
          extraFacts: [
            {
              docIndex: 0,
              field: "identity.cross_reference",
              value: v.basis,
              unit: null,
              method: "parsed",
              passage: {
                quote: v.quote ?? "",
                label: `Linked to SCH ${p.sch} by ${basisLabel}`,
                context: `Found by search ("${query}") and attached only because the document text contains the project's ${basisLabel}.`,
              },
              review_status: "validated",
            },
          ],
        },
      });
      out.report = report;
      out.outcome = report.outcome === "failed" || report.outcome === "rejected" ? "failed" : "linked";
      if (out.outcome === "linked") return out;
    } catch (err) {
      out.checked.push({ url: c.link, linked: false, basis: null, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }
  if (out.outcome !== "failed") out.outcome = "no_identity_match";
  return out;
}
