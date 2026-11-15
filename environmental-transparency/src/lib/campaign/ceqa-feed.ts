/**
 * CEQAnet statewide feed: the State Clearinghouse search export (CSV), parsed deterministically.
 * One row = one filing (document). Filings sharing an SCH number are the same project, so a new
 * filing for a known SCH number is a new *document* of an existing project, never a new development.
 * Pure module (no I/O).
 */

/** RFC 4180 CSV parser (quoted fields, escaped quotes, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    // A quote opens a quoted field only at the start of the field; elsewhere it is data
    // (CEQAnet coordinates such as 35°4'32.3"N appear unquoted).
    if (c === '"' && field === "" && (i === 0 || text[i - 1] === "," || text[i - 1] === "\n" || text[i - 1] === "\r")) quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/** CEQAnet serves the export as Windows-1252 (e.g. the degree sign is byte 0xB0). */
export function decodeFeed(buf: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  return fixC1(utf8.includes("�") ? new TextDecoder("windows-1252").decode(buf) : utf8);
}

/** Windows-1252 bytes 0x80–0x9F that reach us as C1 control characters (double-encoded source data). */
const C1: Record<string, string> = {
  "\x80": "€", "\x82": "‚", "\x83": "ƒ", "\x84": "„", "\x85": "…", "\x86": "†", "\x87": "‡", "\x88": "ˆ", "\x89": "‰",
  "\x8a": "Š", "\x8b": "‹", "\x8c": "Œ", "\x8e": "Ž", "\x91": "‘", "\x92": "’", "\x93": "“", "\x94": "”", "\x95": "•",
  "\x96": "–", "\x97": "—", "\x98": "˜", "\x99": "™", "\x9a": "š", "\x9b": "›", "\x9c": "œ", "\x9e": "ž", "\x9f": "Ÿ",
};
export function fixC1(s: string): string {
  return s.replace(/[\x80-\x9f]/g, (c) => C1[c] ?? "");
}

export interface CeqaFiling {
  sch: string;
  docType: string;
  docTitle: string;
  projectTitle: string;
  leadAgency: string;
  received: string | null; // ISO date
  posted: string | null;
  description: string;
  portalUrl: string;
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    title: string | null;
    /** "Contact Authority": the department or office within the agency. */
    department: string | null;
    address: string | null;
  };
  coordinatesRaw: string | null;
  cities: string[];
  counties: string[];
  crossStreets: string | null;
  zip: string | null;
  totalAcres: string | null;
  parcels: string | null;
  highways: string | null;
  developmentTypes: string | null;
  localAction: string | null;
  projectIssues: string | null;
  stateReview: { start: string | null; end: string | null };
  publicReview: { start: string | null; end: string | null };
  nod: { approvedDate: string | null; approvedBy: string | null; significantImpact: string | null };
  /** The exact CSV row, kept as the provenance passage for parsed facts. */
  raw: Record<string, string>;
}

/** MM/DD/YYYY → YYYY-MM-DD (null when absent or malformed). */
export function usDateToIso(s: string | undefined | null): string | null {
  const m = (s ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const list = (s: string | undefined) =>
  (s ?? "")
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
const opt = (s: string | undefined) => (s ?? "").trim() || null;

/** Columns retained in the stored provenance row (drops nothing a displayed claim relies on). */
const KEEP = [
  "SCH Number",
  "Lead Agency Name",
  "Document Title",
  "Document Type",
  "Received",
  "Posted",
  "Document Description",
  "Document Portal URL",
  "Project Title",
  "Contact Full Name",
  "Contact Authority",
  "Contact Job Title",
  "Contact Email Address",
  "Contact Phone Number",
  "Contact Address 1",
  "Contact Address 2",
  "Contact City",
  "Contact State",
  "Contact Zip Code",
  "Location Coordinates",
  "Cities",
  "Counties",
  "Location Cross Streets",
  "Location Zip Code",
  "Location Total Acres",
  "Location Parcel Number",
  "Location State Highways",
  "NOC Development Type",
  "NOC Local Action",
  "NOC Project Issues",
  "NOC State Review Start Date",
  "NOC State Review End Date",
  "NOC Public Review Start Date",
  "NOC Public Review End Date",
  "NOD Approved By Lead Agency",
  "NOD Approved Date",
  "NOD Significant Environmental Impact",
];

/** "385 N Arrowhead, San Bernardino, CA 92415" from the contact columns (duplicate line 2 dropped). */
export function mailingAddress(rec: Record<string, string>): string | null {
  const l1 = (rec["Contact Address 1"] ?? "").trim();
  const l2 = (rec["Contact Address 2"] ?? "").trim();
  const city = (rec["Contact City"] ?? "").trim();
  const st = (rec["Contact State"] ?? "").trim();
  const zip = (rec["Contact Zip Code"] ?? "").trim();
  if (!l1 && !city) return null;
  const street = [l1, l2 && l2 !== l1 ? l2 : ""].filter(Boolean).join(", ");
  const locality = [city, [st, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [street, locality].filter(Boolean).join(", ") || null;
}

/** Phone digits as written in the export (e.g. 9093874422) → (909) 387-4422. */
export function formatPhone(s: string | null): string | null {
  if (!s) return null;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return s.trim();
}

export function parseFeed(text: string): CeqaFiling[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().replace(/\s+/g, " "));
  if (!header.includes("SCH Number") || !header.includes("Document Portal URL")) {
    throw new Error("CEQAnet export header not recognized (format may have changed)");
  }
  const out: CeqaFiling[] = [];
  for (const r of rows.slice(1)) {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = (r[i] ?? "").trim()));
    const sch = rec["SCH Number"].match(/^\d{10}$/)?.[0];
    const portal = rec["Document Portal URL"];
    if (!sch || !/^https:\/\/ceqanet\.(lci|opr)\.ca\.gov\/\d{10}(\/\d+)?$/.test(portal)) continue;
    const raw = Object.fromEntries(KEEP.filter((k) => rec[k]).map((k) => [k, rec[k]]));
    out.push({
      sch,
      docType: rec["Document Type"].trim().toUpperCase(),
      docTitle: rec["Document Title"],
      projectTitle: rec["Project Title"] || rec["Document Title"],
      leadAgency: rec["Lead Agency Name"],
      received: usDateToIso(rec["Received"]),
      posted: usDateToIso(rec["Posted"]),
      description: rec["Document Description"],
      portalUrl: portal,
      contact: {
        name: opt(rec["Contact Full Name"]),
        email: opt(rec["Contact Email Address"]),
        phone: opt(rec["Contact Phone Number"]),
        title: opt(rec["Contact Job Title"]),
        department: opt(rec["Contact Authority"]),
        address: mailingAddress(rec),
      },
      coordinatesRaw: opt(rec["Location Coordinates"]),
      cities: list(rec["Cities"]),
      counties: list(rec["Counties"]),
      crossStreets: opt(rec["Location Cross Streets"]),
      zip: opt(rec["Location Zip Code"]),
      totalAcres: opt(rec["Location Total Acres"]),
      parcels: opt(rec["Location Parcel Number"]),
      highways: opt(rec["Location State Highways"]),
      developmentTypes: opt(rec["NOC Development Type"]),
      localAction: opt(rec["NOC Local Action"]),
      projectIssues: opt(rec["NOC Project Issues"]),
      stateReview: { start: usDateToIso(rec["NOC State Review Start Date"]), end: usDateToIso(rec["NOC State Review End Date"]) },
      publicReview: { start: usDateToIso(rec["NOC Public Review Start Date"]), end: usDateToIso(rec["NOC Public Review End Date"]) },
      nod: {
        approvedDate: usDateToIso(rec["NOD Approved Date"]),
        approvedBy: opt(rec["NOD Approved By Lead Agency"]),
        significantImpact: opt(rec["NOD Significant Environmental Impact"]),
      },
      raw,
    });
  }
  return out;
}

export interface ProjectGroup {
  sch: string;
  /** Filings sorted oldest → newest by received date (ties: portal URL). */
  filings: CeqaFiling[];
}

/**
 * Groups filings into projects by SCH number, deduplicating repeated rows of the same filing
 * (same portal URL) that appear in overlapping export windows.
 */
export function groupBySch(filings: CeqaFiling[]): ProjectGroup[] {
  const by = new Map<string, Map<string, CeqaFiling>>();
  for (const f of filings) {
    const docs = by.get(f.sch) ?? new Map<string, CeqaFiling>();
    docs.set(f.portalUrl, f);
    by.set(f.sch, docs);
  }
  return [...by.entries()].map(([sch, docs]) => ({
    sch,
    filings: [...docs.values()].sort(
      (a, b) => (a.received ?? "").localeCompare(b.received ?? "") || a.portalUrl.localeCompare(b.portalUrl),
    ),
  }));
}

/** Search-export URL for filings received in [start, end] (inclusive ISO dates). */
export function feedUrl(start: string, end: string): string {
  const q = new URLSearchParams({ StartRange: start, EndRange: end, SearchType: "Advanced", OutputFormat: "CSV" });
  return `https://ceqanet.lci.ca.gov/Search?${q}`;
}

/** Calendar-month windows covering [from, to], newest first (so the most current filings index first). */
export function monthWindows(fromIso: string, toIso: string): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  const d = new Date(to);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  for (;;) {
    const first = Date.UTC(y, m, 1);
    const last = Date.UTC(y, m + 1, 0);
    if (last < from) break;
    out.push({ start: iso(Math.max(first, from)), end: iso(Math.min(last, to)) });
    if (--m < 0) {
      m = 11;
      y--;
    }
  }
  return out;
}
