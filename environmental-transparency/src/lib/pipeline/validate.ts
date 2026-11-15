/**
 * Deterministic validation of model output against the retrieved source text.
 * A Gemini response is a claim; it becomes a "validated" fact only when its verbatim
 * quote is found in the cited document and its number appears in that quote.
 * Pure module (no I/O) so it can be unit tested.
 */
import { ENVIRONMENTAL_TOPICS, type Extraction, type ProjectCategory, type ProjectStatus } from "@/types/project";
import type { CeqaPage } from "@/lib/sources/parse";

export interface SourceDoc {
  url: string;
  title: string | null;
  text: string;
  documentType: string | null;
}

export interface Passage {
  quote: string;
  page?: number | null;
  label?: string;
  context?: string | null;
  kind?: string;
  significance?: string | null;
  details?: Record<string, string | null>;
}

export interface ValidatedFact {
  docIndex: number | null;
  field: string;
  value: string | null;
  unit: string | null;
  method: "reported" | "parsed" | "derived";
  passage: Passage | null;
  review_status: "validated" | "unverified";
}

export interface ValidatedEvent {
  docIndex: number;
  event_type: "comment_period" | "hearing";
  agency_name: string | null;
  deadline_at: string | null;
  status: "open" | "closed" | "scheduled" | "past" | "unverified";
  official_submission_url: string | null;
  passage: Passage;
}

export interface ValidationIssue {
  level: "error" | "warning";
  message: string;
}

export interface ValidatedRecord {
  accepted: boolean;
  project: {
    canonical_name: string;
    category: ProjectCategory;
    status: ProjectStatus;
    description: string | null;
    summary: string | null;
    developer: string | null;
    jurisdiction: string | null;
    lead_agency: string | null;
    latitude: number | null;
    longitude: number | null;
    location_precision: "reported_coordinates" | "geocoded_address" | "unlocated";
    address: string | null;
    sch_number: string | null;
    case_numbers: string[];
  };
  facts: ValidatedFact[];
  events: ValidatedEvent[];
  issues: ValidationIssue[];
  stats: { claims: number; validated: number; unverified: number; dropped: number };
}

// ---------------------------------------------------------------------------
// Text matching helpers
// ---------------------------------------------------------------------------

export const normalizeForMatch = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Finds a quote in document text (whitespace/punctuation-insensitive). Returns page number if paged. */
export function locateQuote(quote: string, docText: string): { found: boolean; page: number | null } {
  const segments = quote
    .split(/\.\.\.|…/)
    .map(normalizeForMatch)
    .filter((s) => s.length >= 12);
  if (segments.length === 0) return { found: false, page: null };

  const pages = docText.split(/\[page (\d+)\]/);
  // pages = [pre, "1", text1, "2", text2, ...] when paged
  if (pages.length > 2) {
    for (let i = 1; i < pages.length; i += 2) {
      const norm = normalizeForMatch(pages[i + 1] ?? "");
      if (segments.every((s) => norm.includes(s))) return { found: true, page: Number(pages[i]) };
    }
  }
  const all = normalizeForMatch(docText);
  return { found: segments.every((s) => all.includes(s)), page: null };
}

/** True if the numeric value appears in the quote (tolerates thousands separators). */
export function numberInQuote(value: number, quote: string): boolean {
  const digits = quote.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const candidates = new Set([String(value), value.toLocaleString("en-US"), value.toFixed(1), value.toFixed(2)]);
  if (Number.isInteger(value)) candidates.add(`${value}.0`);
  const words: Record<number, string> = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 12: "twelve" };
  return (
    [...candidates].some((c) => new RegExp(`(^|[^\\d.])${c.replace(".", "\\.")}([^\\d]|$)`).test(digits)) ||
    (words[value] !== undefined && new RegExp(`\\b${words[value]}\\b`, "i").test(quote))
  );
}

const KNOWN_UNITS = /^(mw|megawatts?|kw|kv|mva|mwh(\/(yr|year))?|gwh(\/(yr|year))?|sq\.? ?ft\.?|square feet|sf|gsf|acres?|feet|ft|stories|story|generators?|units?|engines?|spaces|parking spaces|jobs|employees|gallons?(\/|per )?(day|year|minute)?|gpd|afy|acre-feet(\/| per )?(year|yr)?|tons?(\/| per )?(year|yr|day)?|mtco2e(\/(yr|year))?|lbs?(\/| per )?(day|year)|pounds per day|dba|db|trips?(\/| per )?(day)?|daily trips|percent|%|buildings?|parcels?|trees?|hours?(\/| per )?(year)?|vehicles?|trucks?|miles?|kilovolts?|megavolt-amperes?)$/i;

export const unitLooksValid = (unit: string) =>
  KNOWN_UNITS.test(unit.replace(/\s*\([^)]*\)/g, "").replace(/square[- ]foot/i, "square feet").replace(/kilowatts?/i, "kw").trim());

export function isoDateValid(d: string | null | undefined): d is string {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return false;
  const t = Date.parse(d.slice(0, 10));
  if (Number.isNaN(t)) return false;
  const y = Number(d.slice(0, 4));
  return y >= 1990 && y <= 2040;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** True if an ISO date (YYYY-MM-DD) is written in the text in a common US format. */
export function dateInText(iso: string, text: string): boolean {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return false;
  const t = text.toLowerCase().replace(/\s+/g, " ");
  const month = MONTHS[m - 1];
  const patterns = [
    `${m}/${d}/${y}`,
    `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`,
    `${m}/${d}/${String(y).slice(2)}`,
    iso.slice(0, 10),
    `${m}-${d}-${y}`,
  ];
  if (patterns.some((p) => t.includes(p))) return true;
  const re = new RegExp(`\\b(${month}|${month.slice(0, 3)}\\.?)\\s+${d}(st|nd|rd|th)?\\b`);
  return re.test(t);
}

export const inCalifornia = (lat: number, lng: number) => lat >= 32.4 && lat <= 42.1 && lng >= -124.5 && lng <= -114.0;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);

/** Pacific end-of-day timestamp for a date-only deadline. */
export function endOfDayPacific(isoDate: string): string {
  const month = Number(isoDate.slice(5, 7));
  const offset = month >= 4 && month <= 10 ? "-07:00" : "-08:00";
  return `${isoDate.slice(0, 10)}T23:59:59${offset}`;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const URL_RE = /https?:\/\/[^\s)>\]"']+/i;

// ---------------------------------------------------------------------------
// Status from deterministic document metadata
// ---------------------------------------------------------------------------

/** Maps a CEQAnet document type + review window to a procedural status. */
export function statusFromCeqaDocType(docType: string | null): ProjectStatus | null {
  if (!docType) return null;
  const t = docType.toUpperCase();
  if (t.startsWith("NOD")) return "approved";
  // NOP starts environmental review; draft documents circulate for comment; both await a decision.
  if (/^(NOP|EIR|MND|NEG|ND|IS|SIR|SBE|EA|EIS)/.test(t)) return "under_review";
  return null;
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

export interface ValidateInput {
  extraction: Extraction;
  docs: SourceDoc[];
  ceqa?: { docIndex: number; page: CeqaPage } | null;
  now?: Date;
}

export function validateExtraction({ extraction: x, docs, ceqa, now = new Date() }: ValidateInput): ValidatedRecord {
  const issues: ValidationIssue[] = [];
  const facts: ValidatedFact[] = [];
  const events: ValidatedEvent[] = [];
  const stats = { claims: 0, validated: 0, unverified: 0, dropped: 0 };

  const docOk = (i: number | null | undefined): i is number => typeof i === "number" && i >= 0 && i < docs.length;

  /** Verifies a quoted claim. Returns null (dropped) if the cited document doesn't exist. */
  const check = (docIndex: number, quote: string, value?: number) => {
    stats.claims++;
    if (!docOk(docIndex)) {
      stats.dropped++;
      return null;
    }
    const loc = locateQuote(quote, docs[docIndex].text);
    const numOk = value === undefined || numberInQuote(value, quote);
    const validated = loc.found && numOk;
    if (validated) stats.validated++;
    else stats.unverified++;
    return { validated, page: loc.page, numOk, found: loc.found };
  };

  // --- identity -----------------------------------------------------------
  const name = x.project.name?.trim() || ceqa?.page.fields["Document Title"] || ceqa?.page.title || null;
  if (!name) issues.push({ level: "error", message: "No project name in source material" });

  const cf = ceqa?.page.fields ?? {};
  const ceqaIdx = ceqa?.docIndex ?? null;
  const parsedFact = (field: string, value: string | undefined | null, label: string) => {
    if (!value || ceqaIdx === null) return;
    facts.push({
      docIndex: ceqaIdx,
      field,
      value,
      unit: null,
      method: "parsed",
      passage: { quote: `${label}: ${value}`, label },
      review_status: "validated",
    });
  };

  const sch = ceqa?.page.schNumber ?? x.project.case_numbers.map((c) => c.match(/\b(19|20)\d{8}\b/)?.[0]).find(Boolean) ?? null;
  const leadAgency = cf["Lead Agency"] ?? x.government.lead_agency ?? null;

  parsedFact("identity.sch_number", sch, "SCH Number");
  parsedFact("identity.lead_agency", cf["Lead Agency"], "Lead Agency");
  parsedFact("identity.document_type", cf["Document Type"], "Document Type");
  parsedFact("identity.present_land_use", cf["Present Land Use"], "Present Land Use");
  parsedFact("identity.cross_streets", cf["Cross Streets"], "Cross Streets");
  parsedFact("identity.parcels", cf["Parcel #"], "Parcel #");
  parsedFact("community.reported_nearby_schools", cf["Schools"], "Schools");
  parsedFact("community.waterways", cf["Waterways"], "Waterways");
  parsedFact("community.airports", cf["Airports"], "Airports");
  parsedFact("identity.project_issues", cf["Project Issues"], "Project Issues");
  parsedFact("identity.development_types", cf["Development Types"], "Development Types");
  parsedFact("land_use.total_acres", cf["Total Acres"], "Total Acres");
  parsedFact("economic.jobs_reported", cf["Jobs"], "Jobs");

  if (!cf["Lead Agency"] && x.government.lead_agency) {
    facts.push({ docIndex: null, field: "identity.lead_agency", value: x.government.lead_agency, unit: null, method: "reported", passage: null, review_status: "unverified" });
  }
  for (const c of x.project.case_numbers.slice(0, 6)) {
    const hit = docs.findIndex((d) => d.text.includes(c));
    facts.push({
      docIndex: hit >= 0 ? hit : null,
      field: "identity.case_number",
      value: c,
      unit: null,
      method: "reported",
      passage: hit >= 0 ? { quote: c } : null,
      review_status: hit >= 0 ? "validated" : "unverified",
    });
  }

  // Lead agency contact from CEQAnet (deterministic, used as verified participation channel).
  const leadContact = ceqa?.page.contacts.find((c) => /lead\/public agency/i.test(c.types ?? "")) ?? null;
  if (leadContact && ceqaIdx !== null) {
    facts.push({
      docIndex: ceqaIdx,
      field: "participation.lead_agency_contact",
      value: leadContact.email,
      unit: null,
      method: "parsed",
      passage: {
        quote: [leadContact.name, leadContact.title, leadContact.agency, leadContact.email, leadContact.phone].filter(Boolean).join(" · "),
        label: "Lead/Public Agency contact",
        details: { ...leadContact },
      },
      review_status: "validated",
    });
  }

  // --- location -------------------------------------------------------------
  let latitude: number | null = null;
  let longitude: number | null = null;
  let precision: ValidatedRecord["project"]["location_precision"] = "unlocated";
  if (ceqa?.page.coordinates) {
    const { lat, lng, raw } = ceqa.page.coordinates;
    if (inCalifornia(lat, lng)) {
      latitude = lat;
      longitude = lng;
      precision = "reported_coordinates";
      facts.push({
        docIndex: ceqaIdx,
        field: "location.coordinates",
        value: `${lat}, ${lng}`,
        unit: "decimal degrees",
        method: "derived",
        passage: { quote: `Coordinates: ${raw}`, label: "Reported coordinates (converted from DMS)" },
        review_status: "validated",
      });
    } else {
      issues.push({ level: "warning", message: `Reported coordinates outside California ignored: ${raw}` });
    }
  }

  // --- status ---------------------------------------------------------------
  const sm = x.summary;
  let status: ProjectStatus = sm.status;
  if (status !== "unknown" && sm.status_quote && docOk(sm.status_doc ?? -1)) {
    const c = check(sm.status_doc!, sm.status_quote);
    if (c && !c.validated) {
      issues.push({ level: "warning", message: "Status quote not found in source; status downgraded to unknown" });
      status = "unknown";
    }
  } else if (status !== "unknown" && !sm.status_quote) {
    status = "unknown";
  }
  const detStatus = statusFromCeqaDocType(cf["Document Type"] ?? null);
  if (detStatus && detStatus !== status) {
    if (status !== "unknown") {
      issues.push({ level: "warning", message: `Model status "${status}" overridden by CEQAnet document type (${cf["Document Type"]}) → "${detStatus}"` });
    }
    status = detStatus;
  }

  // --- dates → timeline -----------------------------------------------------
  const parsedDates = new Set(Object.values(ceqa?.page.dates ?? {}));
  for (const d of x.timeline) {
    // CEQAnet's structured dates are authoritative; skip model restatements of the same date.
    if (parsedDates.has(d.date.slice(0, 10))) continue;
    if (!isoDateValid(d.date)) {
      stats.claims++;
      stats.dropped++;
      continue;
    }
    const c = check(d.doc, d.quote);
    if (!c) continue;
    facts.push({
      docIndex: d.doc,
      field: `timeline.${slug(d.label)}`,
      value: d.date.slice(0, 10),
      unit: "date",
      method: "reported",
      passage: { quote: d.quote, page: c.page, label: d.label, kind: d.phase },
      review_status: c.validated && dateInText(d.date, d.quote) ? "validated" : "unverified",
    });
  }
  if (ceqa && ceqaIdx !== null) {
    for (const [label, date] of Object.entries(ceqa.page.dates)) {
      facts.push({
        docIndex: ceqaIdx,
        field: `timeline.${slug(label)}`,
        value: date,
        unit: "date",
        method: "parsed",
        passage: { quote: `${label}: ${date}`, label: `${label} (${cf["Document Type"] ?? "CEQA document"})` },
        review_status: "validated",
      });
    }
  }

  // --- environmental costs: metrics and findings, by topic -------------------
  const finding = (topic: string, k: Extraction["other_impacts"][number] | Extraction["environmental_impacts"]["noise"]["findings"][number]) => {
    const c = check(k.doc, k.quote);
    if (!c) return;
    facts.push({
      docIndex: k.doc,
      field: `consideration.${topic}.${k.kind}`,
      value: k.statement,
      unit: null,
      method: "reported",
      passage: { quote: k.quote, page: c.page, kind: k.kind, significance: k.significance },
      review_status: c.validated ? "validated" : "unverified",
    });
  };
  for (const topic of ENVIRONMENTAL_TOPICS) {
    const block = x.environmental_impacts[topic];
    for (const m of block.metrics) {
      if (!Number.isFinite(m.value)) {
        stats.claims++;
        stats.dropped++;
        continue;
      }
      const c = check(m.doc, m.quote, m.value);
      if (!c) continue;
      if (!unitLooksValid(m.unit)) issues.push({ level: "warning", message: `Unrecognized unit "${m.unit}" for ${m.name}` });
      facts.push({
        docIndex: m.doc,
        field: `metric.${topic}.${slug(m.name)}`,
        value: String(m.value),
        unit: m.unit,
        method: "reported",
        passage: { quote: m.quote, page: c.page, label: m.name, context: m.context },
        review_status: c.validated ? "validated" : "unverified",
      });
    }
    for (const k of block.findings) finding(topic, k);
  }
  for (const k of x.other_impacts) finding(k.topic, k);

  // --- monetary cost estimates ------------------------------------------------
  for (const m of x.cost_estimates) {
    if (!Number.isFinite(m.amount)) {
      stats.claims++;
      stats.dropped++;
      continue;
    }
    const c = check(m.doc, m.quote, m.amount);
    if (!c) continue;
    facts.push({
      docIndex: m.doc,
      field: `cost.${m.category}.${slug(m.label)}`,
      value: String(m.amount),
      unit: m.unit,
      method: "reported",
      passage: { quote: m.quote, page: c.page, label: m.label, context: m.context, details: { paid_by: m.paid_by } },
      review_status: c.validated ? "validated" : "unverified",
    });
  }

  // --- who proposed it ----------------------------------------------------------
  for (const p of x.proponents) {
    const c = check(p.doc, p.quote);
    if (!c) continue;
    // The name itself must appear in the verified quote, not just somewhere near it.
    const named = normalizeForMatch(p.quote).includes(normalizeForMatch(p.name));
    facts.push({
      docIndex: p.doc,
      field: `proponent.${p.role}`,
      value: p.name,
      unit: null,
      method: "reported",
      passage: { quote: p.quote, page: c.page, label: `Proponent (${p.role.replace(/_/g, " ")})`, details: { representative: p.representative } },
      review_status: c.validated && named ? "validated" : "unverified",
    });
  }
  const developer =
    x.proponents.find((p) => p.role === "applicant")?.name ?? x.proponents.find((p) => p.role === "developer")?.name ?? x.proponents[0]?.name ?? null;

  // --- government officials and bodies involved ----------------------------------
  for (const g of x.government.participants) {
    const c = check(g.doc, g.quote);
    if (!c) continue;
    const who = g.name ?? g.body;
    const named = normalizeForMatch(g.quote).includes(normalizeForMatch(who));
    const dated = g.date ? isoDateValid(g.date) && dateInText(g.date, g.quote) : true;
    facts.push({
      docIndex: g.doc,
      field: `government.${g.role}`,
      value: who,
      unit: null,
      method: "reported",
      passage: {
        quote: g.quote,
        page: c.page,
        label: g.action,
        details: { name: g.name, title: g.title, body: g.body, vote: g.vote, date: g.date && isoDateValid(g.date) ? g.date.slice(0, 10) : null },
      },
      review_status: c.validated && named && dated ? "validated" : "unverified",
    });
  }

  // --- participation ----------------------------------------------------------
  const reviewEnd = ceqa?.page.dates["Public Review Period End"] ?? null;
  const reviewStart = ceqa?.page.dates["Public Review Period Start"] ?? null;
  const cp = x.public_participation.comment_period;
  const cpCheck = cp ? check(cp.doc, cp.quote) : null;
  const end = reviewEnd ?? (cp && cpCheck?.validated && isoDateValid(cp.end) && dateInText(cp.end, cp.quote) ? cp.end.slice(0, 10) : null);

  let submitUrl: string | null = null;
  if (cp?.submit_to && cpCheck?.validated) {
    const email = cp.submit_to.match(EMAIL)?.[0];
    const url = cp.submit_to.match(URL_RE)?.[0];
    const inDoc = (s: string) => docs[cp.doc].text.toLowerCase().includes(s.toLowerCase());
    if (email && inDoc(email)) submitUrl = `mailto:${email}`;
    else if (url && inDoc(url)) submitUrl = url;
  }
  if (!submitUrl && leadContact?.email && end) submitUrl = `mailto:${leadContact.email}`;

  if (end) {
    const deadline = endOfDayPacific(end);
    const passageDoc = reviewEnd && ceqaIdx !== null ? ceqaIdx : cp!.doc;
    events.push({
      docIndex: passageDoc,
      event_type: "comment_period",
      agency_name: leadAgency,
      deadline_at: deadline,
      status: Date.parse(deadline) >= now.getTime() ? "open" : "closed",
      official_submission_url: submitUrl,
      passage: {
        quote: reviewEnd ? `Public Review Period Start ${reviewStart ?? "—"} · Public Review Period End ${reviewEnd}` : cp!.quote,
        page: reviewEnd ? null : cpCheck?.page ?? null,
        label: `Public review period${cf["Document Type"] ? ` — ${cf["Document Type"]}` : ""}`,
        details: {
          start: reviewStart ?? cp?.start ?? null,
          end,
          submit_to: cp?.submit_to && cpCheck?.validated ? cp.submit_to : leadContact?.email ?? null,
          submit_source: cp?.submit_to && cpCheck?.validated ? "stated in notice" : leadContact ? "CEQAnet lead agency contact" : null,
          supporting_quote: cp && cpCheck?.validated ? cp.quote : null,
        },
      },
    });
  } else if (cp) {
    issues.push({ level: "warning", message: "Comment period mentioned but no verifiable end date; not shown as a deadline" });
  }

  for (const h of x.public_participation.hearings) {
    if (!isoDateValid(h.date)) continue;
    const c = check(h.doc, h.quote);
    // Unverified hearings (quote not in source, or date not in quote) are never shown as events.
    if (!c || !c.validated || !dateInText(h.date, h.quote)) continue;
    const at = endOfDayPacific(h.date);
    events.push({
      docIndex: h.doc,
      event_type: "hearing",
      agency_name: h.body ?? leadAgency,
      deadline_at: `${h.date.slice(0, 10)}T12:00:00${at.slice(-6)}`,
      status: Date.parse(at) >= now.getTime() ? "scheduled" : "past",
      official_submission_url: null,
      passage: {
        quote: h.quote,
        page: c.page,
        label: h.body ?? "Public hearing",
        details: {
          time: h.time,
          location: h.location,
          body: h.body,
          date: h.date,
          // Online details are kept only when they appear verbatim in the cited document.
          virtual: h.online && normalizeForMatch(docs[h.doc].text).includes(normalizeForMatch(h.online)) ? h.online : null,
        },
      },
    });
  }

  // --- provenance of documents --------------------------------------------
  docs.forEach((d, i) => {
    if (d.documentType) {
      facts.push({ docIndex: i, field: "document.type", value: d.documentType, unit: null, method: "parsed", passage: null, review_status: "validated" });
    }
  });

  if (stats.validated === 0 && facts.filter((f) => f.method !== "reported").length === 0) {
    issues.push({ level: "error", message: "No claim could be verified against the source text" });
  }

  return {
    accepted: !issues.some((i) => i.level === "error"),
    project: {
      canonical_name: name ?? "Unnamed project",
      category: x.project.category,
      status,
      description: sm.description ?? cf["Document Description"] ?? null,
      summary: sm.plain_language,
      developer,
      jurisdiction: x.project.location.city ?? cf["Cities"] ?? null,
      lead_agency: leadAgency,
      latitude,
      longitude,
      location_precision: precision,
      address: x.project.location.address,
      sch_number: sch,
      case_numbers: x.project.case_numbers,
    },
    facts,
    events,
    issues,
    stats,
  };
}
