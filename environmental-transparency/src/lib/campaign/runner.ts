import "server-only";
import { setBrightDataGate, type BrightDataKind } from "@/lib/brightdata";
import { geminiUsage } from "@/lib/gemini";
import { getJson, putJson } from "@/lib/storage";
import { getAdmin } from "@/lib/supabase/admin";
import { accountSnapshot } from "@/lib/campaign/account";
import { canSpend, reserve, spent, type Ledger } from "@/lib/campaign/budget";
import { groupBySch, monthWindows, type CeqaFiling } from "@/lib/campaign/ceqa-feed";
import { classifyProject } from "@/lib/campaign/classify";
import { enrichFromCeqa, enrichFromMunicipal } from "@/lib/campaign/enrich";
import { indexLightweight, loadIndex, type KbIndex, type PlannedFiling, type PlannedProject } from "@/lib/campaign/index-light";
import { sharedCoordinates, verifyLocation } from "@/lib/campaign/locate";
import { fetchFeedWindow, loadCounties } from "@/lib/campaign/sources";
import {
  acquireLease,
  emptyCounters,
  feedPath,
  loadLedger,
  loadState,
  planPath,
  saveLedger,
  saveState,
  setCurrentCampaign,
  type CampaignConfig,
  type CampaignState,
  type Task,
} from "@/lib/campaign/store";

export class BudgetRefused extends Error {
  constructor(public reason: string, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateInput {
  from: string;
  to: string;
  maxRequests: number;
  maxUsd: number;
  pilotRequests: number;
  pilotGeminiCalls: number;
  pilotEnrichments: number;
}

export async function createCampaign(input: CreateInput): Promise<CampaignState> {
  if (input.pilotRequests > input.maxRequests) throw new Error("Pilot cap exceeds campaign cap");
  const createdAt = new Date().toISOString();
  const id = `ca-statewide-${createdAt.slice(0, 19).replace(/[-:T]/g, "")}`;
  const config: CampaignConfig = {
    id,
    createdAt,
    window: { from: input.from, to: input.to },
    budget: { maxRequests: input.maxRequests, maxUsd: input.maxUsd, phaseCap: input.pilotRequests },
    geminiPhaseCap: input.pilotGeminiCalls,
    enrichPhaseCap: input.pilotEnrichments,
    concurrency: { light: 4, brightData: 1 },
    maxAttempts: 3,
    municipal: { enabled: true, maxCandidates: 2 },
    directMinIntervalMs: 1500,
  };
  const tasks: Task[] = monthWindows(input.from, input.to).map((w, i) => ({
    id: `feed:${w.start}_${w.end}`,
    kind: "feed",
    key: `${w.start}_${w.end}`,
    priority: 1000 - i,
    status: "pending",
    attempts: 0,
  }));
  tasks.push({ id: "plan", kind: "plan", key: "plan", priority: 0, status: "pending", attempts: 0 });
  const state: CampaignState = {
    config,
    status: "running",
    phase: "pilot",
    statusReason: null,
    lease: null,
    tasks,
    counters: emptyCounters(),
    steps: [],
    approvals: [],
    phaseStart: { geminiCalls: 0, enriched: 0 },
  };
  // Baseline the account so the campaign's spend is measured against Bright Data's own counts.
  const ledger: Ledger = await loadLedger(id);
  const acct = await accountSnapshot();
  if (acct) {
    ledger.accountBaseline = acct.snapshot;
    ledger.accountLatest = acct.snapshot;
    ledger.rates = acct.rates;
  }
  await saveLedger(id, ledger);
  await saveState(state);
  await setCurrentCampaign(id);
  return state;
}

export async function approvePhase(id: string, add: { requests: number; geminiCalls: number; enrichments: number }) {
  const s = await loadState(id);
  if (!s) throw new Error("Campaign not found");
  const l = await loadLedger(id);
  const used = spent(l).requests;
  s.config.budget.phaseCap = Math.min(s.config.budget.maxRequests, used + add.requests);
  s.config.geminiPhaseCap = add.geminiCalls;
  s.config.enrichPhaseCap = add.enrichments;
  s.phaseStart = { geminiCalls: s.counters.geminiCalls, enriched: s.counters.enrichedCeqa + s.counters.enrichRejected };
  s.phase = "full";
  s.status = "running";
  s.statusReason = null;
  s.approvals.push({ at: new Date().toISOString(), phaseCap: s.config.budget.phaseCap, geminiPhaseCap: add.geminiCalls, enrichPhaseCap: add.enrichments });
  await saveState(s);
  return s;
}

// ---------------------------------------------------------------------------
// Planning: group filings by SCH number, classify, verify locations, enqueue tasks
// ---------------------------------------------------------------------------

async function plan(s: CampaignState): Promise<{ projects: PlannedProject[] }> {
  const filings: PlannedFiling[] = [];
  for (const t of s.tasks.filter((x) => x.kind === "feed" && x.status === "done")) {
    const [start, end] = t.key.split("_");
    const w = await getJson<{ url: string; retrievedAt: string; filings: CeqaFiling[] }>(feedPath(s.config.id, start, end));
    if (w) filings.push(...w.filings.map((f) => ({ ...f, feedUrl: w.url, feedRetrievedAt: w.retrievedAt })));
  }
  const counties = await loadCounties();
  const shared = sharedCoordinates(filings);
  const groups = groupBySch(filings);
  s.counters.filings = new Set(filings.map((f) => f.portalUrl)).size;
  s.counters.uniqueProjects = groups.length;
  const today = new Date().toISOString().slice(0, 10);
  const projects: PlannedProject[] = [];
  for (const g of groups) {
    const cls = classifyProject(g, today);
    if (!cls.relevant) continue;
    const primary = cls.primary as PlannedFiling;
    const title = (cls.latest.projectTitle || cls.latest.docTitle).trim();
    const loc = verifyLocation(primary, title, counties, shared);
    const { latest, primary: _p, ...rest } = cls;
    void _p;
    projects.push({ sch: g.sch, title, filings: g.filings as PlannedFiling[], cls: { ...rest, latestUrl: latest.portalUrl, primaryUrl: primary.portalUrl }, loc });
  }
  s.counters.relevant = projects.length;
  s.counters.relevantActive = projects.filter((p) => p.cls.active).length;
  s.counters.mapReadyCandidates = projects.filter((p) => p.loc.mapReady).length;
  await putJson(planPath(s.config.id), { at: new Date().toISOString(), projects });
  const have = new Set(s.tasks.map((t) => t.id));
  for (const p of projects) {
    if (!have.has(`light:${p.sch}`)) s.tasks.push({ id: `light:${p.sch}`, kind: "light", key: p.sch, priority: 500 + p.cls.score, status: "pending", attempts: 0 });
    // Deep enrichment is reserved for proposed / actively reviewed developments.
    if (p.cls.active) {
      if (!have.has(`enrich_ceqa:${p.sch}`)) s.tasks.push({ id: `enrich_ceqa:${p.sch}`, kind: "enrich_ceqa", key: p.sch, priority: p.cls.score, status: "pending", attempts: 0 });
      if (s.config.municipal.enabled && !have.has(`enrich_municipal:${p.sch}`)) {
        s.tasks.push({ id: `enrich_municipal:${p.sch}`, kind: "enrich_municipal", key: p.sch, priority: p.cls.score - 0.5, status: "pending", attempts: 0 });
      }
    }
  }
  return { projects };
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

export interface StepResult {
  status: CampaignState["status"];
  statusReason: string | null;
  tasksRun: number;
  brightDataThisStep: number;
  remainingTasks: Record<string, number>;
}

let planCache: { id: string; at: string; byKey: Map<string, PlannedProject> } | null = null;
async function planned(id: string) {
  const p = await getJson<{ at: string; projects: PlannedProject[] }>(planPath(id));
  if (!p) throw new Error("Plan not built yet");
  if (planCache?.id !== id || planCache.at !== p.at) planCache = { id, at: p.at, byKey: new Map(p.projects.map((x) => [x.sch, x])) };
  return planCache.byKey;
}

const ready = (t: Task) => t.status === "pending" && (!t.notBefore || Date.parse(t.notBefore) <= Date.now());

export async function runStep(id: string, opts: { maxMs: number }): Promise<StepResult> {
  const t0 = Date.now();
  const s = await loadState(id);
  if (!s) throw new Error("Campaign not found");
  if (s.status !== "running") {
    return { status: s.status, statusReason: s.statusReason, tasksRun: 0, brightDataThisStep: 0, remainingTasks: remaining(s) };
  }
  const leaseId = acquireLease(s, opts.maxMs + 60_000);
  await saveState(s);
  const ledger = await loadLedger(id);

  // Reconcile with the account (authoritative counts; catches any spend outside this campaign).
  const acct = await accountSnapshot();
  if (acct) {
    ledger.accountLatest = acct.snapshot;
    ledger.rates = acct.rates;
    ledger.accountBaseline ??= acct.snapshot;
    await saveLedger(id, ledger);
  }

  let budgetStop: { reason: string; message: string } | null = null;
  let bdThisStep = 0;
  let currentTask: Task | null = null;
  // Serialize the write-ahead ledger so concurrent callers can't both pass the cap check.
  let ledgerChain = Promise.resolve();
  setBrightDataGate((kind: BrightDataKind, target: string) => {
    const run = ledgerChain.then(async () => {
      const v = canSpend(ledger, s.config.budget, kind);
      if (!v.ok) {
        budgetStop ??= { reason: v.reason, message: v.message };
        throw new BudgetRefused(v.reason, v.message);
      }
      reserve(ledger, kind, target);
      bdThisStep++;
      if (currentTask) currentTask.brightData = (currentTask.brightData ?? 0) + 1;
      await saveLedger(id, ledger); // durable BEFORE the request is sent
    });
    ledgerChain = run.catch(() => undefined);
    return run;
  });

  let tasksRun = 0;
  let sinceSave = 0;
  const checkpoint = async (force = false) => {
    if (!force && ++sinceSave < 10) return;
    sinceSave = 0;
    if (s.lease?.id === leaseId) s.lease.until = new Date(Date.now() + 120_000).toISOString();
    await saveState(s);
  };
  const fail = (t: Task, err: unknown) => {
    t.lastError = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
    if (t.attempts >= s.config.maxAttempts) t.status = "failed";
    else t.notBefore = new Date(Date.now() + 30_000 * t.attempts).toISOString();
  };
  const timeLeft = () => Date.now() - t0 < opts.maxMs;
  let idx: KbIndex | null = null;

  try {
    // 1) Discovery windows (direct CEQAnet, sequential + spaced).
    for (const t of s.tasks.filter((x) => x.kind === "feed" && ready(x)).sort((a, b) => b.priority - a.priority)) {
      if (!timeLeft()) break;
      t.attempts++;
      try {
        const [start, end] = t.key.split("_");
        const r = await fetchFeedWindow(start, end, s.config.directMinIntervalMs);
        if (r.fromCache) s.counters.directCacheHits++;
        else s.counters.directRequests++;
        await putJson(feedPath(id, start, end), { url: r.url, retrievedAt: r.retrievedAt, filings: r.filings });
        t.status = "done";
        t.result = { filings: r.filings.length, bytes: r.bytes, fromCache: r.fromCache };
      } catch (err) {
        fail(t, err);
      }
      tasksRun++;
      await checkpoint(true);
    }

    // 2) Plan once every window is fetched.
    const planTask = s.tasks.find((x) => x.kind === "plan")!;
    const feedsLeft = s.tasks.some((x) => x.kind === "feed" && x.status === "pending");
    if (planTask.status === "pending" && !feedsLeft && timeLeft()) {
      planTask.attempts++;
      try {
        const { projects } = await plan(s);
        planTask.status = "done";
        planTask.result = { relevant: projects.length };
      } catch (err) {
        fail(planTask, err);
      }
      tasksRun++;
      await checkpoint(true);
    }

    // 3) Lightweight records (database only), bounded concurrency.
    const lights = s.tasks.filter((x) => x.kind === "light" && ready(x)).sort((a, b) => b.priority - a.priority);
    if (lights.length && timeLeft()) {
      const byKey = await planned(id);
      idx = await loadIndex();
      const queue = [...lights];
      const worker = async () => {
        for (let t = queue.shift(); t && timeLeft(); t = queue.shift()) {
          t.attempts++;
          try {
            const p = byKey.get(t.key);
            if (!p) throw new Error("Project missing from plan");
            const r = await indexLightweight(p, idx!);
            t.status = "done";
            t.result = { ...r };
            if (r.outcome === "created") s.counters.lightCreated++;
            else if (r.outcome === "updated") s.counters.lightUpdated++;
            else s.counters.lightUnchanged++;
            if (r.outcome === "updated" && r.newDocuments > 0) s.counters.newFilingsForExistingProjects += r.newDocuments;
          } catch (err) {
            fail(t, err);
          }
          tasksRun++;
          await checkpoint();
        }
      };
      await Promise.all(Array.from({ length: s.config.concurrency.light }, worker));
      await checkpoint(true);
    }

    // 4) Deep enrichment, highest priority first, one at a time (Gemini + Bright Data bounded).
    const lightDone = !s.tasks.some((x) => x.kind === "light" && x.status === "pending");
    const enrich = s.tasks.filter((x) => (x.kind === "enrich_ceqa" || x.kind === "enrich_municipal") && ready(x)).sort((a, b) => b.priority - a.priority);
    if (lightDone && enrich.length) {
      const byKey = await planned(id);
      const projectIdOf = new Map(s.tasks.filter((x) => x.kind === "light" && x.status === "done").map((x) => [x.key, String(x.result?.projectId ?? "")]));
      for (const t of enrich) {
        if (!timeLeft() || budgetStop) break;
        const enrichedThisPhase = s.counters.enrichedCeqa + s.counters.enrichRejected - s.phaseStart.enriched;
        const geminiThisPhase = s.counters.geminiCalls - s.phaseStart.geminiCalls;
        if (t.kind === "enrich_ceqa" && enrichedThisPhase >= s.config.enrichPhaseCap) continue;
        if (geminiThisPhase >= s.config.geminiPhaseCap) {
          budgetStop = { reason: "gemini_phase_cap", message: `Gemini phase cap reached (${geminiThisPhase}/${s.config.geminiPhaseCap})` };
          break;
        }
        // Municipal search only follows a CEQAnet enrichment of the same project, so the pilot
        // spends Bright Data on the projects it has already deep-read.
        if (t.kind === "enrich_municipal" && s.tasks.find((x) => x.id === `enrich_ceqa:${t.key}`)?.status === "pending") continue;
        const p = byKey.get(t.key);
        const pid = projectIdOf.get(t.key);
        if (!p || !pid) {
          t.status = "skipped";
          t.lastError = "No lightweight record";
          continue;
        }
        // Bright Data headroom for a municipal task: SERP + up to 2 retrievals (+retries).
        if (t.kind === "enrich_municipal") {
          const v = canSpend(ledger, s.config.budget, "serp", 1);
          if (!v.ok) {
            budgetStop = { reason: v.reason, message: v.message };
            break;
          }
        }
        currentTask = t;
        t.attempts++;
        const g0 = geminiUsage.calls;
        try {
          if (t.kind === "enrich_ceqa") {
            const r = await enrichFromCeqa(p, pid);
            t.result = { outcome: r.outcome, error: r.error, stats: r.validation?.stats, steps: r.steps.map((x) => `${x.ok ? "ok" : "x"} ${x.step}: ${x.detail}`.slice(0, 240)) };
            if (budgetStop) throw new BudgetRefused("budget", "Budget refused mid-task");
            if (r.outcome === "failed") throw new Error(r.error ?? "ingestion failed");
            if (r.outcome === "rejected") s.counters.enrichRejected++;
            else s.counters.enrichedCeqa++;
            t.status = "done";
          } else {
            s.counters.municipalSearched++;
            const { data: docs } = await getAdmin().from("documents").select("source_url").eq("project_id", pid);
            const { data: cases } = await getAdmin().from("facts").select("value").eq("project_id", pid).eq("field", "identity.case_number");
            const r = await enrichFromMunicipal(p, pid, {
              maxCandidates: s.config.municipal.maxCandidates,
              knownUrls: new Set((docs ?? []).map((d) => d.source_url)),
              caseNumbers: (cases ?? []).map((c) => c.value).filter(Boolean),
            });
            if (r.serpCached) s.counters.brightDataCacheHits++;
            t.result = { outcome: r.outcome, query: r.query, officialCandidates: r.officialCandidates, checked: r.checked, ingest: r.report ? { outcome: r.report.outcome, error: r.report.error } : undefined };
            if (budgetStop) throw new BudgetRefused("budget", "Budget refused mid-task");
            if (r.outcome === "linked") s.counters.municipalLinked++;
            else s.counters.municipalNoMatch++;
            t.status = "done";
          }
        } catch (err) {
          if (err instanceof BudgetRefused || budgetStop) {
            // Not the task's fault: return it to the queue without consuming an attempt.
            t.attempts--;
            t.status = "pending";
          } else fail(t, err);
        } finally {
          s.counters.geminiCalls += geminiUsage.calls - g0;
          currentTask = null;
        }
        tasksRun++;
        await checkpoint(true);
      }
    }
  } finally {
    setBrightDataGate(null);
    await ledgerChain;
    await saveLedger(id, ledger);
  }

  // Status transitions.
  const left = remaining(s);
  const stop = budgetStop as { reason: string; message: string } | null;
  if (stop) {
    const terminal = stop.reason === "campaign_requests" || stop.reason === "campaign_usd";
    s.status = terminal ? "paused_budget" : "awaiting_approval";
    s.statusReason = stop.message;
  } else if (Object.values(left).every((n) => n === 0)) {
    s.status = "completed";
    s.statusReason = "All tasks finished";
  } else if (!left.feed && !left.plan && !left.light && !hasRunnableEnrichment(s)) {
    s.status = "awaiting_approval";
    s.statusReason = `Phase enrichment cap reached (${s.config.enrichPhaseCap} projects)`;
  }
  s.lease = null;
  s.steps.push({ at: new Date(t0).toISOString(), ms: Date.now() - t0, tasks: tasksRun, brightData: bdThisStep, note: s.statusReason ?? "" });
  s.steps = s.steps.slice(-100);
  await saveState(s);
  return { status: s.status, statusReason: s.statusReason, tasksRun, brightDataThisStep: bdThisStep, remainingTasks: left };
}

/** Whether any pending enrichment could run within the current phase's limits. */
function hasRunnableEnrichment(s: CampaignState): boolean {
  const capLeft = s.counters.enrichedCeqa + s.counters.enrichRejected - s.phaseStart.enriched < s.config.enrichPhaseCap;
  return s.tasks.some(
    (t) =>
      t.status === "pending" &&
      ((t.kind === "enrich_ceqa" && capLeft) || (t.kind === "enrich_municipal" && s.tasks.find((x) => x.id === `enrich_ceqa:${t.key}`)?.status !== "pending")),
  );
}

export function remaining(s: CampaignState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of s.tasks) if (t.status === "pending") out[t.kind] = (out[t.kind] ?? 0) + 1;
  return out;
}

export async function pauseCampaign(id: string, reason: string) {
  const s = await loadState(id);
  if (!s) throw new Error("Campaign not found");
  s.status = "stopped";
  s.statusReason = reason;
  s.lease = null;
  await saveState(s);
  return s;
}

export async function resumeCampaign(id: string) {
  const s = await loadState(id);
  if (!s) throw new Error("Campaign not found");
  if (s.status === "paused_budget") throw new Error("Campaign budget is exhausted; it cannot be resumed");
  s.status = "running";
  s.statusReason = null;
  await saveState(s);
  return s;
}
