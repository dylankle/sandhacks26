import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { LIMITS } from "@/lib/config";

export class FetchRefused extends Error {}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Resolves the host and refuses loopback / private / link-local targets (SSRF guard). */
async function assertPublicHost(url: URL) {
  if (isIP(url.hostname)) throw new FetchRefused(`IP-literal hosts are not allowed: ${url.hostname}`);
  const addrs = await lookup(url.hostname, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new FetchRefused(`Host ${url.hostname} resolves to a non-public address`);
  }
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
}

/**
 * Direct HTTPS fetch restricted to an allowlist. Redirects are followed manually and each
 * hop is re-validated against the allowlist and the private-address guard.
 */
export async function safeFetch(
  input: string,
  isAllowed: (url: URL) => boolean,
  opts: { maxBytes?: number; accept?: string } = {},
): Promise<SafeFetchResult> {
  let url = new URL(input);
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    if (url.protocol !== "https:" || !isAllowed(url)) {
      throw new FetchRefused(`URL not on the source allowlist: ${url.hostname}`);
    }
    await assertPublicHost(url);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(LIMITS.requestTimeoutMs),
      headers: {
        "User-Agent": "EnvironmentalTransparencyBot/0.1 (civic research prototype)",
        Accept: opts.accept ?? "text/html,application/pdf,application/json;q=0.9,*/*;q=0.5",
      },
      cache: "no-store",
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect without location from ${url}`);
      url = new URL(loc, url);
      continue;
    }
    const max = opts.maxBytes ?? LIMITS.maxDownloadBytes;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > max) throw new FetchRefused(`Response too large (${declared} bytes)`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > max) throw new FetchRefused(`Response too large (${body.length} bytes)`);
    return {
      finalUrl: url.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      body,
    };
  }
  throw new FetchRefused("Too many redirects");
}
