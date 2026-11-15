import "server-only";
import { randomUUID } from "node:crypto";
import { getJson, putJson } from "@/lib/storage";
import { emptyLedger, type BudgetConfig, type Ledger } from "@/lib/campaign/budget";

/**
 * Durable campaign state in the private Supabase Storage bucket:
 *   campaigns/<id>/state.json   queue, counters, status (checkpointed after every enrichment task
 *                               and every few lightweight tasks; all tasks are idempotent)
 *   campaigns/<id>/ledger.json  Bright Data request ledger (written BEFORE every request)
 *   campaigns/<id>/feeds/*.json parsed CEQAnet export windows
 *   campaigns/<id>/plan.json    classified project groups
 *   campaigns/current.json      pointer to the active campaign
 */

export type TaskKind = "feed" | "plan" | "light" | "enrich_ceqa" | "enrich_municipal";
export type TaskStatus = "pending" | "done" | "failed" | "skipped";

export interface Task {
  id: string;
  kind: TaskKind;
  key: string;
  priority: number;
  status: TaskStatus;
  attempts: number;
  notBefore?: string;
  lastError?: string;
  result?: Record<string, unknown>;
  /** Bright Data requests attributed to this task. */
  brightData?: number;
}

export interface CampaignConfig {
  id: string;
  createdAt: string;
  window: { from: string; to: string };
  budget: BudgetConfig;
  /** Gemini extraction calls allowed in the current phase (model calls cost money too). */
  geminiPhaseCap: number;
  /** Projects deep-enriched per phase (bounded independently of requests). */
  enrichPhaseCap: number;
  concurrency: { light: number; brightData: number };
  maxAttempts: number;
  municipal: { enabled: boolean; maxCandidates: number };
  /** Minimum gap between direct requests to the same official host (politeness). */
  directMinIntervalMs: number;
}

export type CampaignStatus = "running" | "awaiting_approval" | "paused_budget" | "completed" | "stopped";

export interface Counters {
  directRequests: number;
  directCacheHits: number;
  brightDataCacheHits: number;
  geminiCalls: number;
  filings: number;
  uniqueProjects: number;
  relevant: number;
  relevantActive: number;
  mapReadyCandidates: number;
  lightCreated: number;
  lightUpdated: number;
  lightUnchanged: number;
  enrichedCeqa: number;
  enrichRejected: number;
  municipalSearched: number;
  municipalLinked: number;
  municipalNoMatch: number;
  newFilingsForExistingProjects: number;
}

export interface StepLog {
  at: string;
  ms: number;
  tasks: number;
  brightData: number;
  note: string;
}

export interface CampaignState {
  config: CampaignConfig;
  status: CampaignStatus;
  phase: "pilot" | "full";
  statusReason: string | null;
  lease: { id: string; until: string } | null;
  tasks: Task[];
  counters: Counters;
  steps: StepLog[];
  approvals: { at: string; phaseCap: number; geminiPhaseCap: number; enrichPhaseCap: number }[];
  /** Per-phase usage baselines, so phase caps apply to Gemini/enrichment as well. */
  phaseStart: { geminiCalls: number; enriched: number };
}

export const emptyCounters = (): Counters => ({
  directRequests: 0,
  directCacheHits: 0,
  brightDataCacheHits: 0,
  geminiCalls: 0,
  filings: 0,
  uniqueProjects: 0,
  relevant: 0,
  relevantActive: 0,
  mapReadyCandidates: 0,
  lightCreated: 0,
  lightUpdated: 0,
  lightUnchanged: 0,
  enrichedCeqa: 0,
  enrichRejected: 0,
  municipalSearched: 0,
  municipalLinked: 0,
  municipalNoMatch: 0,
  newFilingsForExistingProjects: 0,
});

const base = (id: string) => `campaigns/${id}`;

export async function currentCampaignId(): Promise<string | null> {
  return (await getJson<{ id: string }>("campaigns/current.json"))?.id ?? null;
}
export async function setCurrentCampaign(id: string) {
  await putJson("campaigns/current.json", { id });
}

export const loadState = (id: string) => getJson<CampaignState>(`${base(id)}/state.json`);
export const saveState = (s: CampaignState) => putJson(`${base(s.config.id)}/state.json`, s);

export async function loadLedger(id: string): Promise<Ledger> {
  return (await getJson<Ledger>(`${base(id)}/ledger.json`)) ?? emptyLedger();
}
export const saveLedger = (id: string, l: Ledger) => putJson(`${base(id)}/ledger.json`, l);

export const feedPath = (id: string, start: string, end: string) => `${base(id)}/feeds/${start}_${end}.json`;
export const planPath = (id: string) => `${base(id)}/plan.json`;

/** Shared, campaign-independent caches (content caching across runs). */
export const serpCachePath = (key: string) => `cache/serp/${key}.json`;
export const feedRawCachePath = (key: string) => `cache/ceqanet-export/${key}.csv`;

/** Acquires the single-runner lease (or throws if another runner holds a live one). */
export function acquireLease(s: CampaignState, ms: number): string {
  const now = Date.now();
  if (s.lease && Date.parse(s.lease.until) > now) throw new Error(`Campaign is being run by another step until ${s.lease.until}`);
  const id = randomUUID();
  s.lease = { id, until: new Date(now + ms).toISOString() };
  return id;
}
