import "server-only";
import { BRIGHTDATA_POLICY_BLOCKED_HOSTS, LIMITS, brightDataRefusesHost, hostAllowed, publisherFor } from "@/lib/config";
import { BrightDataPolicyBlock, unlockerFetch } from "@/lib/brightdata";
import { safeFetch } from "@/lib/net/safe-fetch";
import { getJson, getObject, putJson, putObject, sha256 } from "@/lib/storage";
import { htmlTitle, htmlToText, pdfToText } from "@/lib/sources/parse";

export type RetrievalMethod =
  | "brightdata_web_unlocker"
  | "direct_official_fetch" // used when Bright Data's policy declines a government host
  | "cache";

export interface RetrievedSource {
  url: string;
  finalUrl: string;
  method: RetrievalMethod;
  /** Underlying method of the original retrieval when served from cache. */
  originalMethod: Exclude<RetrievalMethod, "cache">;
  methodNote: string | null;
  contentType: "html" | "pdf";
  rawHtml: string | null;
  text: string;
  title: string | null;
  publisher: string | null;
  contentHash: string;
  bytes: number;
  pages: number | null;
  retrievedAt: string;
}

interface CacheMeta {
  url: string;
  finalUrl: string;
  method: Exclude<RetrievalMethod, "cache">;
  methodNote: string | null;
  mime: string;
  retrievedAt: string;
}

const looksLikePdf = (mime: string, body: Buffer) =>
  /pdf/i.test(mime) || body.subarray(0, 5).toString("latin1") === "%PDF-";

export class SourceRetrievalError extends Error {}

async function fetchRaw(url: string, maxBytes: number) {
  const host = new URL(url).hostname;
  if (!brightDataRefusesHost(host)) {
    try {
      const r = await unlockerFetch(url);
      if (r.status >= 400) throw new SourceRetrievalError(`Upstream HTTP ${r.status} via Bright Data`);
      if (r.body.length > maxBytes) throw new SourceRetrievalError(`Document exceeds size limit (${r.body.length} bytes)`);
      return { ...r, finalUrl: url, method: "brightdata_web_unlocker" as const, methodNote: null };
    } catch (err) {
      if (!(err instanceof BrightDataPolicyBlock)) throw err;
      BRIGHTDATA_POLICY_BLOCKED_HOSTS.add(host);
    }
  }
  // Allowlisted official host that Bright Data declines under its government-site policy.
  const r = await safeFetch(url, hostAllowed, { maxBytes });
  if (r.status >= 400) throw new SourceRetrievalError(`Upstream HTTP ${r.status} for ${url}`);
  return {
    ...r,
    method: "direct_official_fetch" as const,
    methodNote: "Bright Data declined this government host under its network policy (KYC pending); retrieved directly from the allowlisted official source.",
  };
}

/**
 * Retrieves one official source (HTML or PDF), with a 24h raw cache in Supabase Storage so
 * re-runs and hot reloads never re-spend Bright Data credits.
 */
export async function retrieveSource(
  url: string,
  opts: { maxBytes?: number; bypassCache?: boolean; cacheTtlMs?: number } = {},
): Promise<RetrievedSource> {
  const parsed = new URL(url);
  if (!hostAllowed(parsed)) throw new SourceRetrievalError(`Source not on the official allowlist: ${parsed.hostname}`);

  const key = sha256(url);
  let meta: CacheMeta | null = null;
  let body: Buffer | null = null;
  let fromCache = false;

  if (!opts.bypassCache) {
    meta = await getJson<CacheMeta>(`raw/${key}.json`);
    if (meta && Date.now() - Date.parse(meta.retrievedAt) < (opts.cacheTtlMs ?? LIMITS.rawCacheTtlMs)) {
      body = await getObject(`raw/${key}.bin`);
      fromCache = !!body;
    }
  }

  if (!body || !meta) {
    const r = await fetchRaw(url, opts.maxBytes ?? LIMITS.maxDownloadBytes);
    body = r.body;
    meta = {
      url,
      finalUrl: r.finalUrl,
      method: r.method,
      methodNote: r.methodNote,
      mime: r.contentType,
      retrievedAt: new Date().toISOString(),
    };
    await putObject(`raw/${key}.bin`, body, "application/octet-stream");
    await putJson(`raw/${key}.json`, meta);
  }

  const isPdf = looksLikePdf(meta.mime, body);
  let text: string;
  let title: string | null = null;
  let rawHtml: string | null = null;
  let pages: number | null = null;
  if (isPdf) {
    const pdf = await pdfToText(body);
    text = pdf.text;
    pages = pdf.pages;
  } else {
    rawHtml = body.toString("utf8");
    text = htmlToText(rawHtml);
    title = htmlTitle(rawHtml);
  }
  if (text.replace(/\[page \d+\]/g, "").trim().length < 200) {
    throw new SourceRetrievalError(
      isPdf ? "PDF has no extractable text (likely scanned image)" : "Page contained too little readable text",
    );
  }

  return {
    url,
    finalUrl: meta.finalUrl,
    method: fromCache ? "cache" : meta.method,
    originalMethod: meta.method,
    methodNote: meta.methodNote,
    contentType: isPdf ? "pdf" : "html",
    rawHtml,
    text,
    title,
    publisher: publisherFor(url),
    // Hash the normalized text so cosmetic HTML changes don't look like new evidence.
    contentHash: sha256(text),
    bytes: body.length,
    pages,
    retrievedAt: meta.retrievedAt,
  };
}
