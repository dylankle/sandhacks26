/** Pure helpers for presenting stored facts (shared by client components). */
import { TOPICS, TOPIC_LABELS, type DocumentRecord, type FactRecord, type ProjectDetail, type Topic } from "@/types/project";

export interface Passage {
  quote?: string;
  page?: number | null;
  label?: string;
  context?: string | null;
  kind?: string;
  significance?: string | null;
  details?: Record<string, string | null>;
}

export function passageOf(f: FactRecord): Passage {
  if (!f.page_or_passage) return {};
  try {
    return JSON.parse(f.page_or_passage) as Passage;
  } catch {
    return { quote: f.page_or_passage };
  }
}

export interface Evidence {
  title: string;
  value: string | null;
  unit: string | null;
  reviewStatus: string;
  method: string | null;
  quote: string | null;
  page: number | null;
  context: string | null;
  document: DocumentRecord | null;
  /** Non-document dataset source (GIS layers). */
  dataset?: { name: string; publisher: string; url: string; retrieved?: string } | null;
  limitations: string[];
}

export function evidenceFromFact(f: FactRecord, docs: DocumentRecord[], title?: string): Evidence {
  const p = passageOf(f);
  const limitations: string[] = [];
  if (f.review_status !== "validated") limitations.push("The model's quote for this item was not found verbatim in the source, so treat it as an unverified extraction.");
  if (f.method === "derived") limitations.push("Derived value: converted or computed deterministically from the cited source (e.g. coordinates in DMS → decimal).");
  if (f.field.startsWith("metric.")) limitations.push("Value as reported by the document. Not independently measured or modeled by this site.");
  if (f.field.startsWith("cost.")) limitations.push("Amount as stated in the document. Not an independent estimate by this site; actual costs may differ.");
  if (f.field.startsWith("consideration.")) limitations.push("Sentence is a paraphrase; rely on the quoted passage and the original document.");
  return {
    title: title ?? p.label ?? humanizeField(f.field),
    value: f.value,
    unit: f.unit,
    reviewStatus: f.review_status,
    method: f.method,
    quote: p.quote ?? null,
    page: p.page ?? null,
    context: p.context ?? p.significance ?? null,
    document: docs.find((d) => d.id === f.document_id) ?? null,
    limitations,
  };
}

export function humanizeField(field: string): string {
  const last = field.split(".").at(-1) ?? field;
  const s = last.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const topicOfField = (field: string): Topic | null => {
  const t = field.split(".")[1];
  return (TOPICS as readonly string[]).includes(t) ? (t as Topic) : null;
};

export function metrics(p: ProjectDetail) {
  return p.facts.filter((f) => f.field.startsWith("metric."));
}

export function considerations(p: ProjectDetail) {
  return p.facts.filter((f) => f.field.startsWith("consideration."));
}

export const COST_CATEGORY_LABELS: Record<string, string> = {
  total_project: "Total project",
  construction: "Construction",
  land_acquisition: "Land acquisition",
  infrastructure_upgrades: "Infrastructure upgrades",
  annual_operating: "Annual operating",
  mitigation: "Mitigation",
  public_funding: "Public funding",
  tax_revenue: "Tax revenue",
  fees: "Fees",
  other: "Other",
};

export const PROPONENT_ROLE_LABELS: Record<string, string> = {
  applicant: "Applicant",
  developer: "Developer",
  property_owner: "Property owner",
  operator: "Operator",
  public_agency: "Public agency",
  consultant: "Consultant",
  other: "Other",
};

export const GOVERNMENT_ROLE_LABELS: Record<string, string> = {
  lead_agency: "Lead agency",
  decision_maker: "Decision maker",
  elected_official: "Elected official",
  appointed_commissioner: "Commissioner",
  agency_staff: "Agency staff",
  responsible_agency: "Responsible agency",
  trustee_agency: "Trustee agency",
  commenting_agency: "Commenting agency",
  other: "Other",
};

const roleOf = (f: FactRecord) => f.field.split(".")[1] ?? "other";

/** Monetary figures, verified first, then largest first within the same unit scale. */
export function costs(p: ProjectDetail) {
  const scale = (u: string | null) => (/billion/i.test(u ?? "") ? 1e9 : /million/i.test(u ?? "") ? 1e6 : /thousand/i.test(u ?? "") ? 1e3 : 1);
  return p.facts
    .filter((f) => f.field.startsWith("cost."))
    .map((f) => ({ fact: f, category: roleOf(f), amount: (Number(f.value) || 0) * scale(f.unit) }))
    .sort((a, b) => Number(b.fact.review_status === "validated") - Number(a.fact.review_status === "validated") || b.amount - a.amount);
}

export function proponents(p: ProjectDetail) {
  const seen = new Set<string>();
  return p.facts
    .filter((f) => f.field.startsWith("proponent.") && f.value)
    .filter((f) => {
      const k = `${roleOf(f)}|${f.value!.toLowerCase()}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .map((f) => ({ fact: f, role: roleOf(f), name: f.value!, representative: passageOf(f).details?.representative ?? null }));
}

export function governmentParticipants(p: ProjectDetail) {
  return p.facts
    .filter((f) => f.field.startsWith("government.") && f.value)
    .map((f) => {
      const d = passageOf(f).details ?? {};
      return { fact: f, role: roleOf(f), name: d.name ?? null, title: d.title ?? null, body: d.body ?? f.value!, action: passageOf(f).label ?? null, vote: d.vote ?? null, date: d.date ?? null };
    })
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/** "$450 million", "$1.2 billion/year", "$450,000". Falls back to number + unit for non-USD units. */
export function fmtMoney(value: string | null, unit: string | null): string {
  if (value === null) return "—";
  const u = (unit ?? "").trim();
  const m = u.match(/^(thousand|million|billion)?\s*(usd|us\$|\$|dollars?)\s*(\/\s*(year|yr|month|mo))?$/i);
  if (!m) return `${fmtNumber(value)}${u ? ` ${u}` : ""}`;
  const per = m[4] ? `/${/^mo/i.test(m[4]) ? "month" : "year"}` : "";
  return `$${fmtNumber(value)}${m[1] ? ` ${m[1].toLowerCase()}` : ""}${per}`;
}

export function factValue(p: ProjectDetail, field: string): string | null {
  return p.facts.filter((f) => f.field === field).at(-1)?.value ?? null;
}

export function factsBy(p: ProjectDetail, field: string) {
  return p.facts.filter((f) => f.field === field);
}

/** Timeline from dated facts, deduplicated by date + label. */
export function timeline(p: ProjectDetail) {
  const items = p.facts
    .filter((f) => f.field.startsWith("timeline.") && f.value)
    .map((f) => ({ fact: f, date: f.value!, label: passageOf(f).label ?? humanizeField(f.field) }));
  const seen = new Set<string>();
  return items
    .filter((i) => {
      const k = `${i.date}|${i.label.toLowerCase().replace(/\(.*\)/, "").replace(/state /, "").trim()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Map CEQAnet "Project Issues" names onto our topic vocabulary. */
const ISSUE_TOPIC: [RegExp, Topic][] = [
  [/air quality/i, "air_quality"],
  [/greenhouse/i, "greenhouse_gas"],
  [/energy/i, "energy"],
  [/hydrology|water|sewer/i, "water"],
  [/noise/i, "noise"],
  [/transportation|traffic/i, "traffic"],
  [/hazard/i, "hazards"],
  [/land use|aesthetic|population/i, "land_use"],
  [/biolog|vegetation|wetland/i, "biological"],
  [/schools|public services|recreation/i, "community"],
  [/economics|jobs/i, "economic"],
];

/** Topics that the retrieved records actually discuss. */
export function documentedTopics(p: ProjectDetail): Topic[] {
  const set = new Set<Topic>();
  for (const f of [...metrics(p), ...considerations(p)]) {
    const t = topicOfField(f.field);
    if (t && t !== "other") set.add(t);
  }
  const issues = factValue(p, "identity.project_issues");
  if (issues) for (const [re, t] of ISSUE_TOPIC) if (re.test(issues)) set.add(t);
  if (factValue(p, "community.reported_nearby_schools")) set.add("community");
  return TOPICS.filter((t) => set.has(t));
}

export const topicLabel = (t: Topic) => TOPIC_LABELS[t];

export function documentLabel(d: DocumentRecord): string {
  return d.title ?? d.document_type ?? new URL(d.source_url).hostname;
}

export const RETRIEVAL_LABELS: Record<string, string> = {
  brightdata_web_unlocker: "Bright Data Web Unlocker",
  direct_official_fetch: "Direct official fetch",
  ceqanet_export: "CEQAnet statewide export (direct official fetch)",
};

export const PRECISION_LABELS: Record<string, string> = {
  reported_coordinates: "Coordinates reported in State Clearinghouse filing",
  geocoded_address: "Approximate: geocoded from the site address",
  unlocated: "Not mapped: location not verified",
  unverified: "Location unverified",
};

export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }) {
  if (!iso) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", ...opts });
}

export function fmtNumber(v: string | null) {
  if (v === null) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v;
}

export function daysUntil(iso: string): number {
  return Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000);
}
