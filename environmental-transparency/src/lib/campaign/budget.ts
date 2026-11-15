/**
 * Bright Data budget accounting for an indexing campaign. Pure logic; persistence lives in store.ts.
 *
 * Two independent counters are kept and the larger one governs:
 *  - the local write-ahead ledger (incremented and saved BEFORE each request is sent), and
 *  - the account's own request counts from Bright Data's zone cost API (catches usage from any other
 *    process using the same zones).
 * A request is refused if it would push either counter past the campaign cap, the current phase cap
 * (the pilot), or the USD cap.
 */
import type { BrightDataKind } from "@/lib/brightdata";

export interface BudgetConfig {
  /** Hard ceiling on Bright Data requests for the whole campaign. */
  maxRequests: number;
  /** Hard ceiling on Bright Data billable usage (USD). */
  maxUsd: number;
  /** Requests allowed in the current approved phase (the pilot, until approval). */
  phaseCap: number;
}

export interface ZoneRate {
  usdPerRequest: number;
  /** "account" when derived from billed cost ÷ billed requests; "assumed" otherwise. */
  source: "account" | "assumed";
}

export interface AccountSnapshot {
  at: string;
  /** Requests and USD per zone kind, summed over the billing months the API reports. */
  requests: Record<BrightDataKind, number>;
  usd: Record<BrightDataKind, number>;
  /** Per-month request totals, used to diff across a month rollover. */
  months: Record<string, number>;
  monthsUsd: Record<string, number>;
}

export interface Ledger {
  requests: Record<BrightDataKind, number>;
  /** Requests attempted per outcome (reserved = recorded before sending). */
  log: { at: string; kind: BrightDataKind; target: string }[];
  rates: Record<BrightDataKind, ZoneRate>;
  accountBaseline: AccountSnapshot | null;
  accountLatest: AccountSnapshot | null;
}

/** Bright Data list price for SERP API and Web Unlocker (pay-as-you-go), used only until the account reports a rate. */
export const ASSUMED_USD_PER_REQUEST = 0.0015;

export function emptyLedger(): Ledger {
  return {
    requests: { serp: 0, unlocker: 0 },
    log: [],
    rates: {
      serp: { usdPerRequest: ASSUMED_USD_PER_REQUEST, source: "assumed" },
      unlocker: { usdPerRequest: ASSUMED_USD_PER_REQUEST, source: "assumed" },
    },
    accountBaseline: null,
    accountLatest: null,
  };
}

export const localRequests = (l: Ledger) => l.requests.serp + l.requests.unlocker;
export const localUsd = (l: Ledger) => l.requests.serp * l.rates.serp.usdPerRequest + l.requests.unlocker * l.rates.unlocker.usdPerRequest;

/** Requests and USD billed to the account since the campaign baseline (month-rollover safe). */
export function accountDelta(l: Ledger): { requests: number; usd: number } | null {
  const b = l.accountBaseline;
  const c = l.accountLatest;
  if (!b || !c) return null;
  let requests = 0;
  let usd = 0;
  for (const [m, n] of Object.entries(c.months)) requests += Math.max(0, n - (b.months[m] ?? 0));
  for (const [m, n] of Object.entries(c.monthsUsd)) usd += Math.max(0, n - (b.monthsUsd[m] ?? 0));
  return { requests, usd };
}

export function spent(l: Ledger): { requests: number; usd: number; basis: "ledger" | "account" } {
  const acct = accountDelta(l);
  const loc = { requests: localRequests(l), usd: localUsd(l) };
  if (acct && acct.requests > loc.requests) return { requests: acct.requests, usd: Math.max(acct.usd, loc.usd), basis: "account" };
  return { ...loc, usd: Math.max(loc.usd, acct?.usd ?? 0), basis: "ledger" };
}

export type BudgetVerdict = { ok: true } | { ok: false; reason: "campaign_requests" | "campaign_usd" | "phase_cap"; message: string };

/** Whether `n` more requests of `kind` may be sent. */
export function canSpend(l: Ledger, cfg: BudgetConfig, kind: BrightDataKind, n = 1): BudgetVerdict {
  const s = spent(l);
  const usdNext = s.usd + n * l.rates[kind].usdPerRequest;
  if (s.requests + n > cfg.maxRequests) {
    return { ok: false, reason: "campaign_requests", message: `Campaign request cap reached (${s.requests}/${cfg.maxRequests})` };
  }
  if (usdNext > cfg.maxUsd) {
    return { ok: false, reason: "campaign_usd", message: `Campaign USD cap reached ($${s.usd.toFixed(4)} of $${cfg.maxUsd})` };
  }
  if (s.requests + n > cfg.phaseCap) {
    return { ok: false, reason: "phase_cap", message: `Approved phase cap reached (${s.requests}/${cfg.phaseCap}); awaiting approval` };
  }
  return { ok: true };
}

/** Records a request before it is sent (caller persists the ledger before issuing the request). */
export function reserve(l: Ledger, kind: BrightDataKind, target: string, at = new Date().toISOString()) {
  l.requests[kind]++;
  l.log.push({ at, kind, target: target.slice(0, 300) });
}

/** Derives the per-request rate from billed cost ÷ billed requests when the account has history. */
export function rateFromAccount(usd: number, requests: number): ZoneRate {
  if (requests >= 5 && usd > 0) return { usdPerRequest: usd / requests, source: "account" };
  return { usdPerRequest: ASSUMED_USD_PER_REQUEST, source: "assumed" };
}

/** Parses GET /zone/cost into totals for one zone. */
export function parseZoneCost(json: unknown, kind: BrightDataKind): { requests: number; usd: number; months: Record<string, number>; monthsUsd: Record<string, number> } {
  const reqKey = kind === "serp" ? "reqs_serp" : "reqs_unblocker";
  const months: Record<string, number> = {};
  const monthsUsd: Record<string, number> = {};
  let requests = 0;
  let usd = 0;
  for (const customer of Object.values((json ?? {}) as Record<string, Record<string, Record<string, unknown>>>)) {
    for (const [k, v] of Object.entries(customer ?? {})) {
      if (!/^back_m\d+$/.test(k)) continue;
      const range = (v.range as { from?: string } | undefined)?.from ?? k;
      const n = Number(v[reqKey] ?? 0) || 0;
      const c = Number(v.cost ?? 0) || 0;
      months[`${kind}:${range}`] = n;
      monthsUsd[`${kind}:${range}`] = c;
      requests += n;
      usd += c;
    }
  }
  return { requests, usd, months, monthsUsd };
}
