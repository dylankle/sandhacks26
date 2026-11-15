import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hostAllowed } from "@/lib/config";
import { safeFetch } from "@/lib/net/safe-fetch";
import { getJson, getObject, putJson, putObject, sha256 } from "@/lib/storage";
import { decodeFeed, feedUrl, parseFeed, type CeqaFiling } from "@/lib/campaign/ceqa-feed";
import type { CountyFC } from "@/lib/campaign/locate";
import { feedRawCachePath } from "@/lib/campaign/store";

/** Per-host spacing for direct official fetches (politeness; these hosts are not behind Bright Data). */
const lastHit = new Map<string, number>();
export async function politeDelay(host: string, minIntervalMs: number) {
  const wait = (lastHit.get(host) ?? 0) + minIntervalMs - Date.now();
  lastHit.set(host, Date.now() + Math.max(0, wait));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export interface FeedResult {
  filings: CeqaFiling[];
  url: string;
  retrievedAt: string;
  fromCache: boolean;
  bytes: number;
  contentHash: string;
}

/**
 * One CEQAnet search-export window, fetched directly from the State Clearinghouse (Bright Data
 * declines .ca.gov hosts). Raw CSV is cached; windows that end more than two weeks ago are stable
 * and cached for 14 days, recent windows for 12 hours.
 */
export async function fetchFeedWindow(start: string, end: string, minIntervalMs: number): Promise<FeedResult> {
  const url = feedUrl(start, end);
  const key = sha256(url);
  const recent = Date.now() - Date.parse(`${end}T00:00:00Z`) < 14 * 864e5;
  const ttl = recent ? 12 * 3600e3 : 14 * 864e5;
  const meta = await getJson<{ retrievedAt: string; bytes: number }>(`${feedRawCachePath(key)}.json`);
  let buf: Buffer | null = null;
  let retrievedAt = meta?.retrievedAt ?? "";
  let fromCache = false;
  if (meta && Date.now() - Date.parse(meta.retrievedAt) < ttl) {
    buf = await getObject(feedRawCachePath(key));
    fromCache = !!buf;
  }
  if (!buf) {
    await politeDelay("ceqanet.lci.ca.gov", minIntervalMs);
    const r = await safeFetch(url, hostAllowed, { maxBytes: 30 * 1024 * 1024, accept: "text/csv,*/*;q=0.5" });
    if (r.status >= 400) throw new Error(`CEQAnet export HTTP ${r.status}`);
    buf = r.body;
    retrievedAt = new Date().toISOString();
    await putObject(feedRawCachePath(key), buf, "text/csv");
    await putJson(`${feedRawCachePath(key)}.json`, { retrievedAt, bytes: buf.length, url });
  }
  const text = decodeFeed(buf);
  return { filings: parseFeed(text), url, retrievedAt, fromCache, bytes: buf.length, contentHash: sha256(buf) };
}

let counties: CountyFC | null = null;
/** California county boundaries (U.S. Census TIGERweb), shipped with the app by `npm run gis:fetch`. */
export async function loadCounties(): Promise<CountyFC> {
  counties ??= JSON.parse(await readFile(join(process.cwd(), "public", "gis", "ca-counties.geojson"), "utf8")) as CountyFC;
  return counties;
}
