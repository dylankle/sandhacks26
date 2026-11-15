/**
 * Central configuration: source allowlist, request budgets, and limits.
 * Shared by server modules only (no secrets live here).
 */

/** Official sources the pipeline may retrieve. Anything else is refused. */
export const SOURCE_ALLOWLIST: Record<string, { publisher: string; kind: "state" | "city" | "agency" }> = {
  "ceqanet.lci.ca.gov": { publisher: "CEQAnet — CA Governor's Office of Land Use & Climate Innovation (State Clearinghouse)", kind: "state" },
  "ceqanet.opr.ca.gov": { publisher: "CEQAnet — State Clearinghouse", kind: "state" },
  "files.ceqanet.lci.ca.gov": { publisher: "CEQAnet — State Clearinghouse document file", kind: "state" },
  "santaclara.legistar.com": { publisher: "City of Santa Clara — Legislative Public Meetings (Legistar)", kind: "city" },
  "sanjose.legistar.com": { publisher: "City of San José — Legislative Public Meetings (Legistar)", kind: "city" },
  "www.santaclaraca.gov": { publisher: "City of Santa Clara", kind: "city" },
  "santaclaraca.gov": { publisher: "City of Santa Clara", kind: "city" },
  "www.sanjoseca.gov": { publisher: "City of San José", kind: "city" },
  "sanjoseca.gov": { publisher: "City of San José", kind: "city" },
  "www.energy.ca.gov": { publisher: "California Energy Commission", kind: "state" },
  "efiling.energy.ca.gov": { publisher: "California Energy Commission — Docket Log", kind: "state" },
  "www.baaqmd.gov": { publisher: "Bay Area Air Quality Management District", kind: "agency" },
};

/** Hosts used for supporting lookups (geocoding), never for evidence documents. */
export const LOOKUP_ALLOWLIST = new Set(["geocoding.geo.census.gov"]);

/**
 * Bright Data's network policy refuses government-classified hosts until the account
 * completes KYC. We confirmed this for these hosts; skipping the doomed request saves
 * credits. Unknown hosts are tried through Bright Data first and added at runtime if refused.
 */
export const BRIGHTDATA_POLICY_BLOCKED_HOSTS = new Set([
  "ceqanet.lci.ca.gov",
  "ceqanet.opr.ca.gov",
  "files.ceqanet.lci.ca.gov",
  "www.santaclaraca.gov",
  "santaclaraca.gov",
]);

export const LIMITS = {
  /** Max documents retrieved in one ingestion run (page + attachments). */
  maxDocsPerIngest: Number(process.env.INGEST_MAX_DOCS ?? 3),
  /** Max SERP queries per ingestion run. */
  maxSerpQueries: 1,
  requestTimeoutMs: 45_000,
  maxRetries: 1,
  maxDownloadBytes: 12 * 1024 * 1024,
  /** Attachments above this size are not fetched (large EIR volumes). */
  maxAttachmentBytes: 3 * 1024 * 1024,
  maxRedirects: 4,
  /** Characters of each document sent to Gemini. */
  maxCharsPerDocForModel: 60_000,
  rawCacheTtlMs: 24 * 60 * 60 * 1000,
} as const;

export const STORAGE_BUCKET = "source-cache";

/**
 * Statewide official sources beyond the explicit allowlist, accepted by rule. Each rule records *why*
 * the host is treated as official so the basis is shown with the document.
 *  - `.gov` is restricted by CISA to U.S. government organizations; `.ca.gov` to the State of California.
 *  - `.ca.us` is the state-delegated locality namespace used by many California cities and counties.
 *  - Meeting-record platforms host agencies' own agendas and staff reports on vendor subdomains.
 *  - A short curated list covers California agencies that publish on .org/.com domains.
 */
const MEETING_PLATFORMS = /\.(legistar\.com|granicus\.com|primegov\.com|iqm2\.com|civicclerk\.com|novusagenda\.com|boarddocs\.com|escribemeetings\.com)$/;
const CURATED_AGENCY_HOSTS: Record<string, string> = {
  "sccgov.org": "County of Santa Clara",
  "acgov.org": "Alameda County",
  "smcgov.org": "San Mateo County",
  "sfplanning.org": "San Francisco Planning",
  "sfgov.org": "City and County of San Francisco",
  "lacity.org": "City of Los Angeles",
  "planning.lacity.org": "Los Angeles City Planning",
  "ocgov.com": "County of Orange",
  "rivco.org": "County of Riverside",
  "rctlma.org": "Riverside County Planning",
  "valleyair.org": "San Joaquin Valley Air Pollution Control District",
  "sdapcd.org": "San Diego County Air Pollution Control District",
  "ourair.org": "Santa Barbara County Air Pollution Control District",
  "airquality.org": "Sacramento Metropolitan Air Quality Management District",
  "vcapcd.org": "Ventura County Air Pollution Control District",
  "slocleanair.org": "San Luis Obispo County Air Pollution Control District",
  "mbard.org": "Monterey Bay Air Resources District",
  "portoflosangeles.org": "Port of Los Angeles",
  "polb.com": "Port of Long Beach",
  "portofoakland.com": "Port of Oakland",
  "metro.net": "Los Angeles County Metropolitan Transportation Authority",
  "sandag.org": "San Diego Association of Governments",
  "octa.net": "Orange County Transportation Authority",
  "cityofsacramento.org": "City of Sacramento",
  "cityofpaloalto.org": "City of Palo Alto",
  "ci.richmond.ca.us": "City of Richmond",
};

export interface OfficialHost {
  publisher: string;
  kind: "state" | "city" | "agency" | "federal" | "meeting_platform";
  basis: string;
}

/** Returns why a host is treated as an official source, or null if it isn't. */
export function officialHost(url: URL): OfficialHost | null {
  if (url.protocol !== "https:") return null;
  const h = url.hostname.toLowerCase();
  const listed = SOURCE_ALLOWLIST[h];
  if (listed) return { ...listed, basis: "Explicit source allowlist" };
  const bare = h.replace(/^www\./, "");
  const curated = CURATED_AGENCY_HOSTS[bare] ?? CURATED_AGENCY_HOSTS[h];
  if (curated) return { publisher: curated, kind: "agency", basis: "Curated list of California agency domains" };
  if (h.endsWith(".ca.gov")) return { publisher: `State of California — ${h}`, kind: "state", basis: ".ca.gov (State of California domain)" };
  if (h.endsWith(".ca.us")) return { publisher: `California local government — ${h}`, kind: "city", basis: ".ca.us (California locality namespace)" };
  if (h.endsWith(".gov")) return { publisher: `Government domain — ${h}`, kind: "agency", basis: ".gov (U.S. government-restricted registry)" };
  if (MEETING_PLATFORMS.test(h)) {
    return { publisher: `Agency meeting records portal — ${h}`, kind: "meeting_platform", basis: "Agency meeting-records platform (agendas and staff reports published by the agency)" };
  }
  return null;
}

export function hostAllowed(url: URL): boolean {
  return officialHost(url) !== null;
}

export function publisherFor(url: string): string | null {
  try {
    return officialHost(new URL(url))?.publisher ?? null;
  } catch {
    return null;
  }
}

/**
 * Bright Data refuses government-classified hosts (pending KYC). Route them straight to the guarded
 * direct fetch instead of spending a request on a refusal.
 */
export function brightDataRefusesHost(host: string): boolean {
  return BRIGHTDATA_POLICY_BLOCKED_HOSTS.has(host) || /\.(gov|ca\.us|mil)$/i.test(host);
}
