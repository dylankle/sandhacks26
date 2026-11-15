import "server-only";
import { getAdmin } from "@/lib/supabase/admin";
import { sha256 } from "@/lib/storage";
import { statusFromDocType, type Classification } from "@/lib/campaign/classify";
import type { CeqaFiling } from "@/lib/campaign/ceqa-feed";
import type { LocationVerdict } from "@/lib/campaign/locate";
import { commentsFromFilings, contactFromFilings } from "@/lib/campaign/participation-records";

/**
 * Level-1 (lightweight) records: verified title, source, agency, location, dates and procedural status,
 * written only from structured fields of official State Clearinghouse filings (no model involved).
 *
 * Identity: SCH number → existing project; each filing's portal URL → existing document. A new filing
 * for a known SCH number is added to that project as a document, never as a new development.
 */

export interface PlannedFiling extends CeqaFiling {
  feedUrl: string;
  feedRetrievedAt: string;
}

export interface PlannedProject {
  sch: string;
  title: string;
  filings: PlannedFiling[];
  cls: Omit<Classification, "latest" | "primary"> & { latestUrl: string; primaryUrl: string };
  loc: LocationVerdict;
}

const DOC_TYPE_NAMES: Record<string, string> = {
  NOD: "Notice of Determination",
  NOE: "Notice of Exemption",
  NOP: "Notice of Preparation of a Draft EIR",
  EIR: "Draft EIR",
  MND: "Mitigated Negative Declaration",
  NEG: "Negative Declaration",
  FIN: "Final Document",
  SIR: "Supplemental EIR",
  SBE: "Subsequent EIR",
  RIR: "Recirculated EIR",
  REV: "Revised Document",
  ADM: "Addendum",
  CON: "Early Consultation",
  NOI: "Notice of Intent",
  EA: "Environmental Assessment",
  EIS: "Draft EIS",
  JD: "Joint Document",
  RC: "Response to Comments",
  FON: "FONSI - Findings of No Significant Impact",
  ROD: "Record of Decision",
  NOC: "Other Notice of Completion",
};
export const docTypeName = (t: string) => (DOC_TYPE_NAMES[t] ? `${t} - ${DOC_TYPE_NAMES[t]}` : t);

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---------------------------------------------------------------------------
// Knowledge-base index (paginated: PostgREST returns at most 1,000 rows per request)
// ---------------------------------------------------------------------------

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

export interface KbIndex {
  bySch: Map<string, string>;
  docs: Map<string, { id: string; project_id: string | null; publication_date: string | null }>;
  /** Projects without an SCH number, by normalized name (for records ingested from city systems). */
  unnumbered: Map<string, { id: string; jurisdiction: string | null }[]>;
  located: Set<string>;
}

export async function loadIndex(): Promise<KbIndex> {
  const db = getAdmin();
  const [schFacts, docs, projects] = await Promise.all([
    all<{ project_id: string; value: string }>((a, b) => db.from("facts").select("project_id, value").eq("field", "identity.sch_number").range(a, b)),
    all<{ id: string; project_id: string | null; source_url: string; publication_date: string | null }>((a, b) =>
      db.from("documents").select("id, project_id, source_url, publication_date").range(a, b),
    ),
    all<{ id: string; canonical_name: string; jurisdiction: string | null; latitude: number | null }>((a, b) =>
      db.from("projects").select("id, canonical_name, jurisdiction, latitude").range(a, b),
    ),
  ]);
  const bySch = new Map(schFacts.map((f) => [f.value, f.project_id]));
  const withSch = new Set(bySch.values());
  const unnumbered = new Map<string, { id: string; jurisdiction: string | null }[]>();
  for (const p of projects) {
    if (withSch.has(p.id)) continue;
    const k = normName(p.canonical_name);
    unnumbered.set(k, [...(unnumbered.get(k) ?? []), { id: p.id, jurisdiction: p.jurisdiction }]);
  }
  return {
    bySch,
    docs: new Map(docs.map((d) => [d.source_url, { id: d.id, project_id: d.project_id, publication_date: d.publication_date }])),
    unnumbered,
    located: new Set(projects.filter((p) => p.latitude !== null).map((p) => p.id)),
  };
}

// ---------------------------------------------------------------------------
// Fact construction (every value quotes the structured filing field it came from)
// ---------------------------------------------------------------------------

type FactRow = {
  project_id: string;
  document_id: string | null;
  field: string;
  value: string | null;
  unit: string | null;
  method: "parsed" | "derived";
  page_or_passage: string;
  review_status: "validated";
};

function jurisdictionOf(f: CeqaFiling): string | null {
  if (f.counties.length > 1) return `${f.counties.join(" / ")} counties`;
  const county = f.counties[0] ? `${f.counties[0]} County` : null;
  if (f.cities.length === 1) return county ? `${f.cities[0]}, ${county}` : f.cities[0];
  return county;
}

const exportContext = (f: PlannedFiling) =>
  `Structured field of the ${f.docType} filing received ${f.received ?? "(date not stated)"}, from the CEQAnet statewide search export retrieved ${f.feedRetrievedAt.slice(0, 10)}.`;

function parsed(pid: string, docId: string | null, f: PlannedFiling, field: string, label: string, csvColumn: string, value: string | null, unit: string | null = null): FactRow | null {
  if (!value) return null;
  return {
    project_id: pid,
    document_id: docId,
    field,
    value,
    unit,
    method: "parsed",
    page_or_passage: JSON.stringify({ quote: `${csvColumn}: ${f.raw[csvColumn] ?? value}`, label, context: exportContext(f), source: f.feedUrl }),
    review_status: "validated",
  };
}

function documentFacts(pid: string, docId: string, f: PlannedFiling): FactRow[] {
  return [
    parsed(pid, docId, f, "document.type", "Document type", "Document Type", docTypeName(f.docType)),
    parsed(pid, docId, f, "timeline.received", `${docTypeName(f.docType)} received by the State Clearinghouse`, "Received", f.received),
    {
      project_id: pid,
      document_id: docId,
      field: "document.retrieval_method",
      value: "ceqanet_export",
      unit: null,
      method: "derived",
      page_or_passage: JSON.stringify({
        quote: `Structured row from the CEQAnet statewide search export (${f.feedUrl}), fetched directly from the State Clearinghouse. Bright Data declines .ca.gov hosts under its government-site policy.`,
      }),
      review_status: "validated",
    },
  ].filter(Boolean) as FactRow[];
}

function projectFacts(pid: string, docIds: Map<string, string>, p: PlannedProject): FactRow[] {
  const latest = p.filings[p.filings.length - 1];
  const primary = p.filings.find((f) => f.portalUrl === p.cls.primaryUrl) ?? latest;
  const d = (f: PlannedFiling) => docIds.get(f.portalUrl) ?? null;
  const reviewed = [...p.filings].reverse().find((f) => f.publicReview.end || f.publicReview.start);
  const stateRev = [...p.filings].reverse().find((f) => f.stateReview.end || f.stateReview.start);
  const nod = [...p.filings].reverse().find((f) => f.nod.approvedDate);
  const rows: (FactRow | null | undefined)[] = [
    parsed(pid, d(latest), latest, "identity.sch_number", "SCH Number", "SCH Number", p.sch),
    parsed(pid, d(latest), latest, "identity.lead_agency", "Lead Agency", "Lead Agency Name", latest.leadAgency),
    parsed(pid, d(latest), latest, "identity.document_type", "Latest CEQA document", "Document Type", docTypeName(latest.docType)),
    parsed(pid, d(primary), primary, "identity.development_types", "Development Types", "NOC Development Type", primary.developmentTypes),
    parsed(pid, d(primary), primary, "identity.project_issues", "Project Issues", "NOC Project Issues", primary.projectIssues),
    parsed(pid, d(primary), primary, "identity.local_action", "Local Action", "NOC Local Action", primary.localAction),
    parsed(pid, d(primary), primary, "identity.cross_streets", "Cross Streets", "Location Cross Streets", primary.crossStreets),
    parsed(pid, d(primary), primary, "identity.parcels", "Parcel #", "Location Parcel Number", primary.parcels),
    parsed(pid, d(primary), primary, "land_use.total_acres", "Total Acres", "Location Total Acres", primary.totalAcres, "acres"),
    reviewed && parsed(pid, d(reviewed), reviewed, "timeline.public_review_period_start", "Public review period begins", "NOC Public Review Start Date", reviewed.publicReview.start),
    reviewed && parsed(pid, d(reviewed), reviewed, "timeline.public_review_period_end", "Public review period ends", "NOC Public Review End Date", reviewed.publicReview.end),
    stateRev && parsed(pid, d(stateRev), stateRev, "timeline.state_review_period_start", "State review period begins", "NOC State Review Start Date", stateRev.stateReview.start),
    stateRev && parsed(pid, d(stateRev), stateRev, "timeline.state_review_period_end", "State review period ends", "NOC State Review End Date", stateRev.stateReview.end),
    nod && parsed(pid, d(nod), nod, "timeline.nod_approved", "Approved by lead agency (per Notice of Determination)", "NOD Approved Date", nod.nod.approvedDate),
  ];
  // Location: the reported point only when every verification check passed.
  if (p.loc.mapReady && p.loc.lat !== null) {
    const f = primary.coordinatesRaw === p.loc.raw ? primary : (p.filings.find((x) => x.coordinatesRaw === p.loc.raw) ?? primary);
    rows.push({
      project_id: pid,
      document_id: d(f),
      field: "location.coordinates",
      value: `${p.loc.lat}, ${p.loc.lng}`,
      unit: "decimal degrees",
      method: "parsed",
      page_or_passage: JSON.stringify({
        quote: `Location Coordinates: ${p.loc.raw}`,
        label: "Site coordinates reported in State Clearinghouse filing",
        context: `Converted from degrees-minutes-seconds. ${p.loc.checks.map((c) => c.detail).join("; ")}.`,
        source: f.feedUrl,
      }),
      review_status: "validated",
    });
  }
  rows.push({
    project_id: pid,
    document_id: d(primary),
    field: "location.verification",
    value: p.loc.mapReady ? "map_ready" : "not_mapped",
    unit: null,
    method: "derived",
    page_or_passage: JSON.stringify({
      quote: p.loc.mapReady ? `Reported point verified: ${p.loc.checks.map((c) => c.detail).join("; ")}` : `Not mapped: ${p.loc.reason}`,
      label: p.loc.mapReady ? "Location verified" : "Location not mapped",
      context: p.loc.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.detail}`).join(" · "),
    }),
    review_status: "validated",
  });
  const why = p.cls.reasons[0];
  rows.push({
    project_id: pid,
    document_id: why ? (docIds.get(why.docUrl) ?? d(latest)) : d(latest),
    field: "index.relevance",
    value: p.cls.category,
    unit: null,
    method: "derived",
    page_or_passage: JSON.stringify({
      quote: why?.matched ?? latest.docTitle,
      label: "Why this project is in IMBY",
      context: p.cls.reasons.map((r) => r.rule).join("; "),
    }),
    review_status: "validated",
  });
  rows.push({
    project_id: pid,
    document_id: null,
    field: "index.level",
    value: "lightweight",
    unit: null,
    method: "derived",
    page_or_passage: JSON.stringify({
      quote: "Indexed from structured State Clearinghouse fields only. Environmental figures and participation details are added when the record is enriched.",
      label: "Record depth",
    }),
    review_status: "validated",
  });
  return rows.filter(Boolean) as FactRow[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface LightResult {
  outcome: "created" | "updated" | "unchanged";
  projectId: string;
  newDocuments: number;
  mapped: boolean;
}

/** Inserts filings not yet stored; returns portal URL → document id for every filing of the project. */
async function upsertDocuments(pid: string, p: PlannedProject, idx: KbIndex, inserted: { table: string; id: string }[]) {
  const db = getAdmin();
  const ids = new Map<string, string>();
  const fresh: PlannedFiling[] = [];
  for (const f of p.filings) {
    const known = idx.docs.get(f.portalUrl);
    if (known && known.project_id === pid) ids.set(f.portalUrl, known.id);
    else if (!known) fresh.push(f);
    // A filing URL already attached to a different project is left alone (never re-assigned silently).
  }
  if (fresh.length) {
    const { data, error } = await db
      .from("documents")
      .insert(
        fresh.map((f) => ({
          project_id: pid,
          source_url: f.portalUrl,
          title: `${f.docTitle} (${f.docType})`,
          issuer: f.leadAgency || null,
          publication_date: f.received,
          retrieved_at: f.feedRetrievedAt,
          content_hash: sha256(JSON.stringify(f.raw)),
          version: 1,
        })),
      )
      .select("id, source_url");
    if (error || !data) throw new Error(`document insert failed: ${error?.message}`);
    for (const r of data) {
      inserted.push({ table: "documents", id: r.id });
      ids.set(r.source_url, r.id);
      const f = fresh.find((x) => x.portalUrl === r.source_url)!;
      idx.docs.set(r.source_url, { id: r.id, project_id: pid, publication_date: f.received });
    }
  }
  return { ids, fresh };
}

async function insertFacts(rows: FactRow[], pid: string, inserted: { table: string; id: string }[]) {
  if (!rows.length) return;
  const db = getAdmin();
  const { data: prev } = await db.from("facts").select("field, value, document_id").eq("project_id", pid);
  const seen = new Set((prev ?? []).map((f) => `${f.field}|${f.value}|${f.document_id}`));
  const fresh = rows.filter((r) => !seen.has(`${r.field}|${r.value}|${r.document_id}`));
  if (!fresh.length) return;
  const { data, error } = await db.from("facts").insert(fresh).select("id");
  if (error) throw new Error(`facts insert failed: ${error.message}`);
  data?.forEach((r) => inserted.push({ table: "facts", id: r.id }));
}

async function rollback(inserted: { table: string; id: string }[], idx: KbIndex) {
  const db = getAdmin();
  const ids = new Set(inserted.map((r) => r.id));
  for (const [url, d] of idx.docs) if (ids.has(d.id)) idx.docs.delete(url);
  for (const row of [...inserted].reverse()) await db.from(row.table).delete().eq("id", row.id);
}

function siteFeature(pid: string, docId: string | null, p: PlannedProject) {
  return {
    project_id: pid,
    source_document_id: docId,
    category: "project_site",
    baseline_or_proposed: "proposed",
    geojson: { type: "Feature", geometry: { type: "Point", coordinates: [p.loc.lng, p.loc.lat] }, properties: { precision: "reported_coordinates" } },
    spatial_meaning: "Site coordinates reported in the State Clearinghouse (CEQAnet) filing, verified to fall in the county the filing names. A point, not a parcel boundary.",
  };
}

/**
 * Comment windows and the agency contact stated in the filings, written in the same shape as the
 * document pipeline (participation_events + `participation.event.<id>` detail fact). Skips anything
 * already recorded for the project (same event type + deadline; any existing contact).
 */
export async function upsertParticipation(
  pid: string,
  filings: CeqaFiling[],
  docIdOf: (portalUrl: string) => string | null,
  now = Date.now(),
): Promise<{ events: number; contact: boolean }> {
  const db = getAdmin();
  const contact = contactFromFilings(filings);
  const [{ data: prevEvents }, { data: prevContact }] = await Promise.all([
    db.from("participation_events").select("event_type, deadline_at").eq("project_id", pid),
    db.from("facts").select("id").eq("project_id", pid).eq("field", "participation.lead_agency_contact").limit(1),
  ]);
  const seen = new Set((prevEvents ?? []).map((e) => `${e.event_type}|${e.deadline_at ? Date.parse(e.deadline_at) : ""}`));
  let events = 0;
  for (const c of commentsFromFilings(filings, contact)) {
    if (seen.has(`comment_period|${Date.parse(c.deadlineAt)}`)) continue;
    const docId = docIdOf(c.filing.portalUrl);
    const { data: ev, error } = await db
      .from("participation_events")
      .insert({
        project_id: pid,
        source_document_id: docId,
        agency_name: c.filing.leadAgency || null,
        event_type: "comment_period",
        deadline_at: c.deadlineAt,
        status: Date.parse(c.deadlineAt) >= now ? "open" : "closed",
        official_submission_url: c.submissionUrl,
      })
      .select("id")
      .single();
    if (error || !ev) throw new Error(`participation insert failed: ${error?.message}`);
    const { error: fe } = await db.from("facts").insert({
      project_id: pid,
      document_id: docId,
      field: `participation.event.${ev.id}`,
      value: "comment_period",
      method: "parsed",
      page_or_passage: JSON.stringify({
        quote: c.quote,
        label: `Public review period — ${docTypeName(c.filing.docType)}`,
        details: {
          start: c.start,
          end: c.end,
          submit_to: c.submissionUrl ? c.submissionUrl.slice(7) : null,
          submit_source: c.submissionUrl ? "CEQAnet lead agency contact" : null,
        },
      }),
      review_status: "validated",
    });
    if (fe) {
      await db.from("participation_events").delete().eq("id", ev.id);
      throw new Error(`participation detail insert failed: ${fe.message}`);
    }
    events++;
  }
  let wroteContact = false;
  if (contact && !prevContact?.length) {
    const { error } = await db.from("facts").insert({
      project_id: pid,
      document_id: docIdOf(contact.filing.portalUrl),
      field: "participation.lead_agency_contact",
      value: contact.details.email ?? contact.details.phone ?? contact.details.name,
      method: "parsed",
      page_or_passage: JSON.stringify({ quote: contact.quote, label: "Lead/Public Agency contact", details: contact.details }),
      review_status: "validated",
    });
    if (error) throw new Error(`contact insert failed: ${error.message}`);
    wroteContact = true;
  }
  return { events, contact: wroteContact };
}

export async function indexLightweight(p: PlannedProject, idx: KbIndex): Promise<LightResult> {
  const db = getAdmin();
  const latest = p.filings[p.filings.length - 1];
  const primary = p.filings.find((f) => f.portalUrl === p.cls.primaryUrl) ?? latest;
  const jurisdiction = jurisdictionOf(primary);

  let pid = idx.bySch.get(p.sch) ?? null;
  if (!pid) {
    // Records first ingested from city systems carry no SCH number: match on exact name + jurisdiction.
    const city = primary.cities[0]?.toLowerCase();
    const cand = (idx.unnumbered.get(normName(p.title)) ?? []).find((c) => city && c.jurisdiction?.toLowerCase().includes(city));
    pid = cand?.id ?? null;
  }
  const inserted: { table: string; id: string }[] = [];

  if (pid) {
    // Existing development: add new filings as documents; never create a second project.
    try {
      const { ids, fresh } = await upsertDocuments(pid, p, idx, inserted);
      const facts = fresh.flatMap((f) => documentFacts(pid!, ids.get(f.portalUrl)!, f));
      const { data: proj } = await db.from("projects").select("latitude, status").eq("id", pid).single();
      const knownDates = [...idx.docs.values()].filter((d) => d.project_id === pid && !fresh.some((f) => idx.docs.get(f.portalUrl)?.id === d.id)).map((d) => d.publication_date ?? "");
      const newest = fresh.at(-1);
      const update: Record<string, unknown> = {};
      if (fresh.length) {
        facts.push(...projectFacts(pid, ids, p).filter((r) => r.field !== "index.level" && r.field !== "index.relevance" && (r.field !== "location.coordinates" || proj?.latitude == null) && r.field !== "location.verification"));
        // A later filing moves the procedural status (e.g. a Notice of Determination → approved).
        if (newest?.received && knownDates.every((k) => k <= newest.received!)) {
          const s = statusFromDocType(newest.docType);
          if (s !== "unknown") update.status = s;
        }
        update.last_checked_at = new Date().toISOString();
      }
      if (proj?.latitude == null && p.loc.mapReady) {
        Object.assign(update, { latitude: p.loc.lat, longitude: p.loc.lng, location_precision: "reported_coordinates" });
        const { data: fe, error } = await db.from("impact_features").insert(siteFeature(pid, ids.get(primary.portalUrl) ?? null, p)).select("id");
        if (error) throw new Error(`impact feature insert failed: ${error.message}`);
        fe?.forEach((r) => inserted.push({ table: "impact_features", id: r.id }));
        if (!facts.some((f) => f.field === "location.coordinates")) facts.push(...projectFacts(pid, ids, p).filter((r) => r.field === "location.coordinates"));
      }
      await insertFacts(facts, pid, inserted);
      if (Object.keys(update).length) {
        const { error } = await db.from("projects").update(update).eq("id", pid);
        if (error) throw new Error(`project update failed: ${error.message}`);
      }
      idx.bySch.set(p.sch, pid);
      // Supplementary and idempotent: a failure here leaves the core record intact for the next backfill.
      await upsertParticipation(pid, p.filings, (u) => idx.docs.get(u)?.id ?? null).catch(() => undefined);
      return { outcome: fresh.length || update.latitude !== undefined ? "updated" : "unchanged", projectId: pid, newDocuments: fresh.length, mapped: p.loc.mapReady || proj?.latitude != null };
    } catch (err) {
      await rollback(inserted, idx);
      throw err;
    }
  }

  // New development.
  try {
    const { data, error } = await db
      .from("projects")
      .insert({
        canonical_name: p.title,
        category: p.cls.category,
        status: p.cls.status,
        description: primary.description || latest.description || null,
        developer: null,
        jurisdiction,
        summary: null,
        last_checked_at: new Date().toISOString(),
        latitude: p.loc.mapReady ? p.loc.lat : null,
        longitude: p.loc.mapReady ? p.loc.lng : null,
        location_precision: p.loc.mapReady ? "reported_coordinates" : "unlocated",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`project insert failed: ${error?.message}`);
    pid = data.id as string;
    inserted.push({ table: "projects", id: pid });
    const { ids } = await upsertDocuments(pid, p, idx, inserted);
    const facts = [...p.filings.flatMap((f) => documentFacts(pid!, ids.get(f.portalUrl)!, f)), ...projectFacts(pid, ids, p)];
    await insertFacts(facts, pid, inserted);
    if (p.loc.mapReady) {
      const { data: fe, error: fe2 } = await db.from("impact_features").insert(siteFeature(pid, ids.get(primary.portalUrl) ?? null, p)).select("id");
      if (fe2) throw new Error(`impact feature insert failed: ${fe2.message}`);
      fe?.forEach((r) => inserted.push({ table: "impact_features", id: r.id }));
    }
    idx.bySch.set(p.sch, pid);
    await upsertParticipation(pid, p.filings, (u) => ids.get(u) ?? null).catch(() => undefined);
    return { outcome: "created", projectId: pid, newDocuments: p.filings.length, mapped: p.loc.mapReady };
  } catch (err) {
    await rollback(inserted, idx);
    throw err;
  }
}
