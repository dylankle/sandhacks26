import "server-only";
import { LIMITS } from "@/lib/config";

const ENDPOINT = "https://api.brightdata.com/request";

export class BrightDataPolicyBlock extends Error {
  constructor(public host: string, message: string) {
    super(message);
  }
}

export class BrightDataError extends Error {}

/** Per-process request accounting, surfaced in ingestion run logs. */
export const brightDataUsage = { serp: 0, unlocker: 0, failures: 0 };

export type BrightDataKind = "serp" | "unlocker";

/**
 * Optional gate consulted before EVERY billable attempt (retries included). A budgeted job installs
 * one that durably records the request before it is sent and throws to refuse it when a cap is hit.
 */
type Gate = (kind: BrightDataKind, target: string) => Promise<void>;
let gate: Gate | null = null;
export function setBrightDataGate(g: Gate | null) {
  gate = g;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new BrightDataError(`${name} is not configured`);
  return v;
}

async function callBrightData(kind: BrightDataKind, body: Record<string, unknown>): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= LIMITS.maxRetries; attempt++) {
    // Outside the try: a refused budget must propagate, not be retried.
    if (gate) await gate(kind, String(body.url ?? ""));
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${requireEnv("BRIGHTDATA_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(LIMITS.requestTimeoutMs * 2),
      });
      // Retry only transient upstream failures.
      if (res.status >= 500 && attempt < LIMITS.maxRetries) continue;
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  brightDataUsage.failures++;
  throw new BrightDataError(`Bright Data request failed: ${String(lastErr)}`);
}

export interface SerpResult {
  rank: number;
  title: string;
  link: string;
  description: string;
  source: string | null;
}

/** Google search through the Bright Data SERP API, parsed to JSON (brd_json=1). */
export async function serpSearch(query: string): Promise<SerpResult[]> {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("brd_json", "1");
  url.searchParams.set("gl", "us");
  url.searchParams.set("hl", "en");
  url.searchParams.set("num", "10");

  brightDataUsage.serp++;
  const res = await callBrightData("serp", { zone: requireEnv("BRIGHTDATA_SERP_ZONE"), url: url.toString(), format: "json" });
  if (!res.ok) {
    brightDataUsage.failures++;
    throw new BrightDataError(`SERP request failed with HTTP ${res.status}`);
  }
  const envelope = (await res.json()) as { status_code?: number; body?: string };
  if (!envelope.body) throw new BrightDataError(`SERP returned no body (upstream ${envelope.status_code})`);
  const parsed = JSON.parse(envelope.body) as { organic?: Array<Record<string, unknown>> };
  return (parsed.organic ?? []).map((r, i) => ({
    rank: Number(r.rank ?? i + 1),
    title: String(r.title ?? ""),
    link: String(r.link ?? ""),
    description: String(r.description ?? ""),
    source: r.source ? String(r.source) : null,
  }));
}

export interface UnlockerResult {
  status: number;
  contentType: string;
  body: Buffer;
}

/** Retrieves a public page through Bright Data Web Unlocker. */
export async function unlockerFetch(target: string): Promise<UnlockerResult> {
  brightDataUsage.unlocker++;
  const res = await callBrightData("unlocker", { zone: requireEnv("BRIGHTDATA_UNLOCKER_ZONE"), url: target, format: "raw" });
  const brdError = res.headers.get("x-brd-error");
  if (brdError) {
    brightDataUsage.failures++;
    const host = new URL(target).hostname;
    if (/government|special permissions|KYC|usage policy/i.test(brdError)) {
      throw new BrightDataPolicyBlock(host, `Bright Data declined ${host}: government-site policy (account KYC required)`);
    }
    throw new BrightDataError(`Bright Data error for ${host}: ${brdError.slice(0, 200)}`);
  }
  if (!res.ok) {
    brightDataUsage.failures++;
    throw new BrightDataError(`Web Unlocker HTTP ${res.status}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > LIMITS.maxDownloadBytes) throw new BrightDataError(`Response too large (${body.length} bytes)`);
  return { status: res.status, contentType: res.headers.get("content-type") ?? "application/octet-stream", body };
}
