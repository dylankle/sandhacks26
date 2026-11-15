import "server-only";
import { parseZoneCost, rateFromAccount, type AccountSnapshot, type ZoneRate } from "@/lib/campaign/budget";
import type { BrightDataKind } from "@/lib/brightdata";

/**
 * Bright Data account usage from the management API (GET /zone/cost). These calls report billing
 * and are not billable scraping requests. Returns null if the API is unavailable, in which case the
 * local write-ahead ledger alone governs the budget.
 */
export async function accountSnapshot(): Promise<{ snapshot: AccountSnapshot; rates: Record<BrightDataKind, ZoneRate> } | null> {
  const key = process.env.BRIGHTDATA_API_KEY;
  const zones: Record<BrightDataKind, string | undefined> = {
    serp: process.env.BRIGHTDATA_SERP_ZONE,
    unlocker: process.env.BRIGHTDATA_UNLOCKER_ZONE,
  };
  if (!key || !zones.serp || !zones.unlocker) return null;
  try {
    const snapshot: AccountSnapshot = { at: new Date().toISOString(), requests: { serp: 0, unlocker: 0 }, usd: { serp: 0, unlocker: 0 }, months: {}, monthsUsd: {} };
    const rates = {} as Record<BrightDataKind, ZoneRate>;
    for (const kind of ["serp", "unlocker"] as const) {
      const res = await fetch(`https://api.brightdata.com/zone/cost?zone=${encodeURIComponent(zones[kind]!)}`, {
        headers: { Authorization: `Bearer ${key}` },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return null;
      const z = parseZoneCost(await res.json(), kind);
      snapshot.requests[kind] = z.requests;
      snapshot.usd[kind] = z.usd;
      Object.assign(snapshot.months, z.months);
      Object.assign(snapshot.monthsUsd, z.monthsUsd);
      rates[kind] = rateFromAccount(z.usd, z.requests);
    }
    return { snapshot, rates };
  } catch {
    return null;
  }
}
