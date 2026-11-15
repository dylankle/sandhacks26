import "server-only";
import { accountDelta, localRequests, localUsd, spent } from "@/lib/campaign/budget";
import { loadLedger, loadState } from "@/lib/campaign/store";
import { remaining } from "@/lib/campaign/runner";

/** Campaign report: every figure is computed from the ledger, the account API, or task results. */
export async function campaignReport(id: string) {
  const s = await loadState(id);
  if (!s) throw new Error("Campaign not found");
  const l = await loadLedger(id);
  const used = spent(l);
  const acct = accountDelta(l);
  const tasks = s.tasks;
  const done = (k: string) => tasks.filter((t) => t.kind === k && t.status === "done");
  const light = done("light");
  const ceqa = done("enrich_ceqa");
  const muni = done("enrich_municipal");
  const bdBy = (k: string) => tasks.filter((t) => t.kind === k).reduce((n, t) => n + (t.brightData ?? 0), 0);

  const mapReady = light.filter((t) => t.result?.mapped === true).length;
  const enrichedOk = ceqa.filter((t) => ["created", "updated", "unchanged"].includes(String(t.result?.outcome))).length;
  const linked = muni.filter((t) => t.result?.outcome === "linked").length;
  const muniBd = bdBy("enrich_municipal");
  const perMunicipalTask = muni.length ? muniBd / muni.length : null;
  const perLinked = linked ? muniBd / linked : null;
  // A usable project has a verified map location or deep-enriched evidence from this campaign.
  const usable = new Set([...light.filter((t) => t.result?.mapped === true).map((t) => t.key), ...ceqa.filter((t) => ["created", "updated", "unchanged"].includes(String(t.result?.outcome))).map((t) => t.key)]).size;

  const reqLeft = Math.max(0, s.config.budget.maxRequests - used.requests);
  const usdLeft = Math.max(0, s.config.budget.maxUsd - used.usd);
  const rate = Math.max(l.rates.serp.usdPerRequest, l.rates.unlocker.usdPerRequest);
  const capacity = Math.min(reqLeft, Math.floor(usdLeft / rate));
  const municipalPending = tasks.filter((t) => t.kind === "enrich_municipal" && t.status === "pending").length;

  return {
    campaign: { id: s.config.id, status: s.status, statusReason: s.statusReason, phase: s.phase, window: s.config.window, createdAt: s.config.createdAt },
    budget: {
      caps: { requests: s.config.budget.maxRequests, usd: s.config.budget.maxUsd, phaseRequests: s.config.budget.phaseCap, phaseGeminiCalls: s.config.geminiPhaseCap, phaseEnrichments: s.config.enrichPhaseCap },
      consumed: {
        requests: used.requests,
        basis: used.basis,
        ledger: { serp: l.requests.serp, unlocker: l.requests.unlocker, total: localRequests(l), usd: +localUsd(l).toFixed(4) },
        account: acct ? { requests: acct.requests, usd: +acct.usd.toFixed(4), at: l.accountLatest?.at ?? null } : null,
        usd: +used.usd.toFixed(4),
        rates: l.rates,
      },
      remaining: { requests: reqLeft, usd: +usdLeft.toFixed(4) },
      accountBaselineRequests: l.accountBaseline ? l.accountBaseline.requests.serp + l.accountBaseline.requests.unlocker : null,
    },
    discovery: {
      feedWindows: tasks.filter((t) => t.kind === "feed").length,
      feedWindowsDone: done("feed").length,
      directOfficialRequests: s.counters.directRequests,
      directCacheHits: s.counters.directCacheHits,
      filings: s.counters.filings,
      uniqueProjects: s.counters.uniqueProjects,
      relevant: s.counters.relevant,
      relevantActive: s.counters.relevantActive,
    },
    lightweight: {
      indexed: light.length,
      created: s.counters.lightCreated,
      updatedExisting: s.counters.lightUpdated,
      unchanged: s.counters.lightUnchanged,
      newFilingsAttachedToExistingProjects: s.counters.newFilingsForExistingProjects,
      mapReady,
      notMapped: light.length - mapReady,
      failed: tasks.filter((t) => t.kind === "light" && t.status === "failed").length,
    },
    enrichment: {
      ceqaEnriched: enrichedOk,
      ceqaRejected: ceqa.filter((t) => t.result?.outcome === "rejected").length,
      ceqaFailed: tasks.filter((t) => t.kind === "enrich_ceqa" && t.status === "failed").length,
      municipalSearched: muni.length,
      municipalLinked: linked,
      municipalNoOfficialResults: muni.filter((t) => t.result?.outcome === "no_official_results").length,
      municipalNoIdentityMatch: muni.filter((t) => t.result?.outcome === "no_identity_match").length,
      geminiCalls: s.counters.geminiCalls,
      brightDataByTask: { enrich_ceqa: bdBy("enrich_ceqa"), enrich_municipal: muniBd },
    },
    efficiency: {
      usableProjects: usable,
      requestsPerUsableProject: usable ? +(used.requests / usable).toFixed(3) : null,
      requestsPerMunicipalSearch: perMunicipalTask !== null ? +perMunicipalTask.toFixed(2) : null,
      requestsPerLinkedMunicipalRecord: perLinked !== null ? +perLinked.toFixed(2) : null,
    },
    capacity: {
      requestsRemaining: capacity,
      estimatedMunicipalSearches: perMunicipalTask ? Math.floor(capacity / perMunicipalTask) : null,
      estimatedLinkedRecords: perLinked ? Math.floor(capacity / perLinked) : null,
      municipalSearchesQueued: municipalPending,
    },
    queue: remaining(s),
    recentSteps: s.steps.slice(-5),
  };
}
