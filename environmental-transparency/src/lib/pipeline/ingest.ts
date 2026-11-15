import "server-only";
import { LIMITS, hostAllowed, publisherFor } from "@/lib/config";
import { brightDataUsage, serpSearch } from "@/lib/brightdata";
import { extractProject, geminiUsage, lastModel } from "@/lib/gemini";
import { geocodeAddress } from "@/lib/geocode";
import { matchReportedSchools } from "@/lib/gis";
import { fitToBudget } from "@/lib/pipeline/extract";
import { existingHashes, persistRecord, type DocToPersist, type ImpactFeatureInput } from "@/lib/pipeline/persist";
import { validateExtraction, type SourceDoc, type ValidatedRecord } from "@/lib/pipeline/validate";
import { attachmentPriority, isCeqaNet, isLegistar, parseCeqaNet, parseLegistar, type CeqaPage } from "@/lib/sources/parse";
import { retrieveSource, type RetrievedSource } from "@/lib/sources/retrieve";
import { documentTextPath, putJson, putObject } from "@/lib/storage";
import { getAdmin } from "@/lib/supabase/admin";

/** Options used by the statewide indexing campaign only (never accepted from the public API). */
export interface CampaignIngestOptions {
  /** Attach to this project instead of matching by identifiers (the caller has verified the link). */
  attachToProjectId?: string;
  /** False when the project's location was judged ambiguous: no coordinates, geocoding, or site marker. */
  allowLocation?: boolean;
  /** Additional provenance facts about document 0 (e.g. how it was linked to the project). */
  extraFacts?: ValidatedRecord["facts"];
  cacheTtlMs?: number;
}

export type IngestRequest = (
  | { mode: "url"; url: string; force?: boolean; maxDocs?: number }
  | { mode: "discover"; query: string; force?: boolean; maxDocs?: number }
) & { campaign?: CampaignIngestOptions };

export interface IngestStep {
  step: "discover" | "retrieve" | "dedupe" | "extract" | "validate" | "geocode" | "persist" | "cache";
  ok: boolean;
  detail: string;
  ms: number;
  data?: unknown;
}

export interface IngestReport {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  outcome: "created" | "updated" | "unchanged" | "rejected" | "failed";
  request: IngestRequest;
  steps: IngestStep[];
  projectId?: string;
  projectName?: string;
  validation?: Pick<ValidatedRecord, "issues" | "stats">;
  usage?: { brightData: typeof brightDataUsage; gemini: typeof geminiUsage };
  error?: string;
}

let running = false;

export async function runIngestion(req: IngestRequest): Promise<IngestReport> {
  if (running) throw new Error("An ingestion is already running; try again when it finishes.");
  running = true;
  const usageBefore = { bd: { ...brightDataUsage }, gm: { ...geminiUsage } };
  const startedAt = new Date().toISOString();
  const report: IngestReport = { runId: startedAt.replace(/[:.]/g, "-"), startedAt, outcome: "failed", request: req, steps: [] };
  const time = async <T>(step: IngestStep["step"], fn: () => Promise<T>, describe: (r: T) => string, data?: (r: T) => unknown) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      report.steps.push({ step, ok: true, detail: describe(r), ms: Date.now() - t0, data: data?.(r) });
      return r;
    } catch (err) {
      report.steps.push({ step, ok: false, detail: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 });
      throw err;
    }
  };
  const maxDocs = Math.max(1, Math.min(req.maxDocs ?? LIMITS.maxDocsPerIngest, 5));

  try {
    // 1. Discovery (Bright Data SERP) -------------------------------------------------
    let targetUrl: string;
    if (req.mode === "discover") {
      targetUrl = await time(
        "discover",
        async () => {
          const results = await serpSearch(req.query);
          const candidates = results.filter((r) => {
            try {
              return hostAllowed(new URL(r.link));
            } catch {
              return false;
            }
          });
          if (candidates.length === 0) throw new Error(`No allowlisted official sources among ${results.length} results`);
          const { data } = await getAdmin().from("documents").select("source_url").in("source_url", candidates.map((c) => c.link));
          const known = new Set((data ?? []).map((d) => d.source_url));
          const fresh = candidates.find((c) => !known.has(c.link)) ?? (req.force ? candidates[0] : null);
          if (!fresh) throw new Error(`All ${candidates.length} official results are already in the knowledge base`);
          return { pick: fresh.link, results, candidates: candidates.length };
        },
        (r) => `Bright Data SERP: ${r.results.length} results, ${r.candidates} on official allowlist → ${r.pick}`,
        (r) => r.results.slice(0, 10).map((x) => ({ title: x.title, link: x.link, allowed: (() => { try { return hostAllowed(new URL(x.link)); } catch { return false; } })() })),
      ).then((r) => r.pick);
    } else {
      targetUrl = req.url;
    }

    // 2. Retrieval (Bright Data Web Unlocker, or direct for gov hosts it declines) ---
    const primary = await time(
      "retrieve",
      () => retrieveSource(targetUrl, { bypassCache: req.force, cacheTtlMs: req.campaign?.cacheTtlMs }),
      (r) => `${r.contentType.toUpperCase()} ${(r.bytes / 1024).toFixed(0)} KB via ${r.method === "cache" ? `cache (originally ${r.originalMethod})` : r.method}`,
    );
    const retrieved: RetrievedSource[] = [primary];
    let ceqa: CeqaPage | null = null;
    let attachmentQueue: { url: string; title: string; sizeKb: number | null }[] = [];
    if (primary.rawHtml && isCeqaNet(primary.url)) {
      ceqa = parseCeqaNet(primary.rawHtml, primary.url);
      attachmentQueue = ceqa.attachments;
    } else if (primary.rawHtml && isLegistar(primary.url)) {
      attachmentQueue = parseLegistar(primary.rawHtml, primary.url).attachments.map((a) => ({ ...a, sizeKb: null }));
    }
    attachmentQueue = attachmentQueue
      .filter((a) => (a.sizeKb ?? 0) * 1024 <= LIMITS.maxAttachmentBytes && attachmentPriority(a.title) >= 0)
      .sort((a, b) => attachmentPriority(b.title) - attachmentPriority(a.title) || (a.sizeKb ?? 9e9) - (b.sizeKb ?? 9e9));
    const titles = new Map<string, string>();
    for (const a of attachmentQueue) {
      if (retrieved.length >= maxDocs) break;
      try {
        const doc = await time(
          "retrieve",
          () => retrieveSource(a.url, { maxBytes: LIMITS.maxAttachmentBytes, bypassCache: req.force, cacheTtlMs: req.campaign?.cacheTtlMs }),
          (r) => `Attachment "${a.title}": ${r.pages ?? "?"} pages via ${r.method === "cache" ? `cache (originally ${r.originalMethod})` : r.method}`,
        );
        titles.set(doc.url, a.title);
        retrieved.push(doc);
      } catch {
        /* recorded in steps; continue with remaining attachments */
      }
    }

    // 3. Dedupe before spending model credits -----------------------------------------
    const known = await time(
      "dedupe",
      () => existingHashes(retrieved.map((r) => r.contentHash)),
      (m) => `${m.size}/${retrieved.length} documents already stored (content hash match)`,
    );
    if (known.size === retrieved.length && !req.force) {
      const pid = [...known.values()][0]?.project_id ?? undefined;
      if (pid) {
        const { data } = await getAdmin()
          .from("projects")
          .update({ last_checked_at: new Date().toISOString() })
          .eq("id", pid)
          .select("canonical_name")
          .single();
        report.projectName = data?.canonical_name ?? undefined;
      }
      report.outcome = "unchanged";
      report.projectId = pid;
      return report;
    }

    // 4. Extraction (Gemini, structured JSON) ------------------------------------------
    const docType = (r: RetrievedSource, i: number) =>
      i === 0 && ceqa ? ceqa.fields["Document Type"] ?? null : titles.get(r.url) ?? (isLegistar(r.url) ? "Legistar legislation record" : null);
    const sourceDocs: SourceDoc[] = retrieved.map((r, i) => ({
      url: r.url,
      title: titles.get(r.url) ?? r.title,
      text: r.text,
      documentType: docType(r, i),
    }));
    const extraction = await time(
      "extract",
      () =>
        extractProject(
          sourceDocs.map((d) => ({ url: d.url, title: d.title, text: fitToBudget(d.text, LIMITS.maxCharsPerDocForModel) })),
        ),
      (x) => {
        const env = Object.values(x.environmental_impacts).reduce((n, t) => n + t.metrics.length + t.findings.length, 0);
        return `Gemini ${lastModel}: "${x.project.name}" — ${env} environmental items, ${x.cost_estimates.length} costs, ${x.timeline.length} dates, ${x.proponents.length} proponents, ${x.government.participants.length} government participants, ${x.public_participation.hearings.length} hearings`;
      },
      (x) => x,
    );

    // 5. Deterministic validation ------------------------------------------------------
    const validated = await time(
      "validate",
      async () => validateExtraction({ extraction, docs: sourceDocs, ceqa: ceqa ? { docIndex: 0, page: ceqa } : null }),
      (v) => `${v.stats.validated} claims verified verbatim, ${v.stats.unverified} unverified, ${v.stats.dropped} dropped; ${v.issues.length} issues`,
      (v) => ({ issues: v.issues, stats: v.stats }),
    );
    report.validation = { issues: validated.issues, stats: validated.stats };
    report.projectName = validated.project.canonical_name;
    if (!validated.accepted) {
      report.outcome = "rejected";
      return report;
    }

    // 6. Geographic representation -----------------------------------------------------
    const p = validated.project;
    if (req.campaign?.extraFacts) validated.facts.push(...req.campaign.extraFacts);
    if (req.campaign?.allowLocation === false) {
      // The campaign already judged this location ambiguous; never place a marker for it.
      p.latitude = null;
      p.longitude = null;
      p.location_precision = "unlocated";
      validated.facts = validated.facts.filter((f) => f.field !== "location.coordinates");
    }
    if (p.latitude === null && p.address && req.campaign?.allowLocation !== false) {
      const addr = `${p.address}${/,\s*ca\b|california/i.test(p.address) ? "" : `, ${p.jurisdiction ?? ""}, CA`}`;
      const g = await time(
        "geocode",
        () => geocodeAddress(addr),
        (r) => (r ? `Census geocoder matched "${r.matchedAddress}"` : `No confident match for "${addr}"`),
      );
      if (g) {
        p.latitude = g.lat;
        p.longitude = g.lng;
        p.location_precision = "geocoded_address";
        validated.facts.push({
          docIndex: null,
          field: "location.coordinates",
          value: `${g.lat}, ${g.lng}`,
          unit: "decimal degrees",
          method: "derived",
          passage: { quote: `Address "${p.address}" geocoded to "${g.matchedAddress}" by ${g.source}`, label: "Geocoded street address (approximate)" },
          review_status: "validated",
        });
      }
    }
    const features: ImpactFeatureInput[] = [];
    if (p.latitude !== null && p.longitude !== null) {
      features.push({
        docIndex: p.location_precision === "reported_coordinates" ? 0 : null,
        category: "project_site",
        baseline_or_proposed: "proposed",
        geojson: { type: "Feature", geometry: { type: "Point", coordinates: [p.longitude, p.latitude] }, properties: { precision: p.location_precision } },
        spatial_meaning:
          p.location_precision === "reported_coordinates"
            ? "Site coordinates reported in the State Clearinghouse (CEQAnet) filing. A point, not a parcel boundary."
            : "Approximate point from geocoding the site address. Not a parcel boundary.",
      });
      const schoolsField = ceqa?.fields["Schools"];
      if (schoolsField) {
        const m = await matchReportedSchools(schoolsField, { lat: p.latitude, lng: p.longitude });
        for (const s of m.matched) {
          features.push({
            docIndex: 0,
            category: "reported_nearby_school",
            baseline_or_proposed: "baseline",
            geojson: { ...s.feature, properties: { ...s.feature.properties, listed_as: s.name, km_from_site: Number(s.km.toFixed(2)) } },
            spatial_meaning: `Named under "Schools" in the CEQAnet filing ("${s.name}"); location from CDE California Public Schools 2025-26. Listing indicates proximity, not measured exposure.`,
          });
        }
      }
    }

    // 7. Persistence ---------------------------------------------------------------------
    const docsToPersist: DocToPersist[] = retrieved.map((r, i) => ({
      source_url: r.url,
      title: sourceDocs[i].title ?? r.title,
      issuer: i === 0 && ceqa ? ceqa.fields["Lead Agency"] ?? publisherFor(r.url) : publisherFor(r.url),
      publication_date: i === 0 && ceqa ? ceqa.dates["Received"] ?? null : null,
      retrieved_at: r.retrievedAt,
      content_hash: r.contentHash,
      retrieval_method: r.originalMethod,
      method_note: r.methodNote,
    }));
    const saved = await time(
      "persist",
      () => persistRecord(validated, docsToPersist, features, { projectId: req.campaign?.attachToProjectId }),
      (s) =>
        `${s.createdProject ? "Created" : "Updated"} project; ${s.documents.filter((d) => !d.reused).length} new documents, ${s.factsInserted} facts, ${s.eventsInserted} participation events, ${s.featuresInserted} map features`,
      (s) => s,
    );
    report.projectId = saved.projectId;
    report.outcome = saved.createdProject ? "created" : "updated";

    // 8. Cache document text for grounded Q&A --------------------------------------------
    await time(
      "cache",
      async () => {
        await Promise.all(retrieved.map((r) => putObject(documentTextPath(r.contentHash), r.text, "text/plain; charset=utf-8")));
        return retrieved.length;
      },
      (n) => `Stored text of ${n} documents for evidence search`,
    );
    return report;
  } catch (err) {
    report.outcome = "failed";
    report.error = err instanceof Error ? err.message : String(err);
    return report;
  } finally {
    running = false;
    report.finishedAt = new Date().toISOString();
    report.usage = {
      brightData: {
        serp: brightDataUsage.serp - usageBefore.bd.serp,
        unlocker: brightDataUsage.unlocker - usageBefore.bd.unlocker,
        failures: brightDataUsage.failures - usageBefore.bd.failures,
      },
      gemini: { calls: geminiUsage.calls - usageBefore.gm.calls, failures: geminiUsage.failures - usageBefore.gm.failures },
    };
    await putJson(`runs/${report.runId}.json`, report).catch(() => undefined);
  }
}
