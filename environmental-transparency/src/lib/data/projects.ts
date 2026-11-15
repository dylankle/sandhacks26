import "server-only";
import { getAdmin } from "@/lib/supabase/admin";
import { commentState, hearingUpcoming, pacificDate } from "@/lib/participation";
import { primarySource } from "@/lib/source";
import type { DocumentRecord, FactRecord, ImpactFeatureRecord, ParticipationRecord, ProjectDetail, ProjectSummary } from "@/types/project";

/**
 * Read-side queries. Uses the server client so RLS-protected tables stay closed to browsers;
 * only these intentionally public columns are returned.
 */

type Row = Record<string, unknown>;

/** Value of a fact from the most recently retrieved document (later records supersede earlier ones). */
function latestFact(facts: Row[], docs: Row[], projectId: string, field: string): string | null {
  const when = new Map(docs.map((d) => [d.id, Date.parse(String(d.retrieved_at)) || 0]));
  const hits = facts
    .filter((f) => f.project_id === projectId && f.field === field)
    .sort((a, b) => (when.get(a.document_id) ?? 0) - (when.get(b.document_id) ?? 0));
  return (hits.at(-1)?.value as string | undefined) ?? null;
}

type Details = Map<string, Record<string, string | null>>;

/** Event id → details stored in its linked `participation.event.<id>` fact (start date, hearing date/time…). */
function eventDetails(facts: Row[]): Details {
  const m: Details = new Map();
  for (const f of facts) {
    const id = String(f.field).slice("participation.event.".length);
    try {
      m.set(id, (JSON.parse(String(f.page_or_passage ?? "{}")).details ?? {}) as Record<string, string | null>);
    } catch {
      /* malformed passage: no details */
    }
  }
  return m;
}

/** Comment and hearing status for a project, on the Pacific calendar (see lib/participation). */
export function participationSummary(
  events: Row[],
  details: Details,
  now = Date.now(),
): Pick<ProjectSummary, "comment_status" | "comment_deadline" | "comment_opens" | "next_hearing"> {
  const windows = events
    .filter((e) => e.event_type === "comment_period" && e.deadline_at)
    .map((e) => {
      const start = details.get(String(e.id))?.start ?? null;
      return { deadline: String(e.deadline_at), start, state: commentState(String(e.deadline_at), start, now) };
    });
  const rank = { open: 0, upcoming: 1, closed: 2 } as const;
  const w = windows.sort((a, b) => rank[a.state] - rank[b.state] || Date.parse(b.deadline) - Date.parse(a.deadline))[0];
  const hearings = events
    .filter((e) => e.event_type === "hearing" && e.deadline_at)
    .map((e) => (details.get(String(e.id))?.date ?? pacificDate(String(e.deadline_at))).slice(0, 10))
    .filter((d) => hearingUpcoming(d, now))
    .sort();
  return {
    comment_status: w ? w.state : "none",
    comment_deadline: w?.deadline ?? null,
    comment_opens: w?.state === "upcoming" ? w.start : null,
    next_hearing: hearings[0] ?? null,
  };
}

/** All rows of a query (PostgREST caps each response at 1,000 rows). */
async function all(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) return out;
  }
}

const groupBy = (rows: Row[]) => {
  const m = new Map<unknown, Row[]>();
  for (const r of rows) m.set(r.project_id, [...(m.get(r.project_id) ?? []), r]);
  return m;
};

let listCache: { at: number; value: Promise<ProjectSummary[]> } | null = null;

/** Project summaries for the map and list. Memoized briefly: every open browser polls this. */
export function listProjects(): Promise<ProjectSummary[]> {
  if (listCache && Date.now() - listCache.at < 8_000) return listCache.value;
  const value = loadProjectList();
  listCache = { at: Date.now(), value };
  value.catch(() => (listCache = null));
  return value;
}

async function loadProjectList(): Promise<ProjectSummary[]> {
  const db = getAdmin();
  const [projects, events, facts, docs, eventFacts] = await Promise.all([
    all((a, b) => db.from("projects").select("id, canonical_name, category, status, jurisdiction, latitude, longitude, location_precision, last_checked_at").order("last_checked_at", { ascending: false }).order("id").range(a, b)),
    all((a, b) => db.from("participation_events").select("id, project_id, event_type, deadline_at").order("id").range(a, b)),
    all((a, b) => db.from("facts").select("project_id, document_id, field, value").in("field", ["identity.lead_agency", "index.level", "identity.sch_number", "identity.case_number"]).order("id").range(a, b)),
    all((a, b) => db.from("documents").select("id, project_id, retrieved_at, source_url").order("id").range(a, b)),
    all((a, b) => db.from("facts").select("field, page_or_passage").like("field", "participation.event.%").order("id").range(a, b)),
  ]);
  const details = eventDetails(eventFacts);
  const factsBy = groupBy(facts);
  const docsBy = groupBy(docs);
  const eventsBy = groupBy(events);
  return projects.map((p) => {
    const pf = factsBy.get(p.id) ?? [];
    const pd = docsBy.get(p.id) ?? [];
    const level = pf.find((f) => f.field === "index.level")?.value as string | undefined;
    const sch = (pf.find((f) => f.field === "identity.sch_number")?.value as string | undefined) ?? null;
    const source = primarySource({
      sch_number: sch,
      documents: pd.map((d) => ({ source_url: String(d.source_url ?? ""), retrieved_at: d.retrieved_at as string | null })),
      case_numbers: pf.filter((f) => f.field === "identity.case_number").map((f) => f.value as string | null),
    });
    return {
      ...(p as unknown as ProjectSummary),
      lead_agency: latestFact(pf, pd, String(p.id), "identity.lead_agency"),
      sch_number: sch,
      source_id: source.id,
      source_url: source.url,
      // Records created before statewide indexing were all deep-ingested.
      index_level: level === "lightweight" ? "lightweight" : "enriched",
      document_count: pd.length,
      ...participationSummary(eventsBy.get(p.id) ?? [], details),
    };
  });
}

export async function getProject(id: string): Promise<ProjectDetail | null> {
  const db = getAdmin();
  const { data: p, error } = await db.from("projects").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!p) return null;
  const [{ data: documents }, { data: facts }, { data: events }, { data: features }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", id).order("retrieved_at", { ascending: true }),
    db.from("facts").select("*").eq("project_id", id),
    db.from("participation_events").select("*").eq("project_id", id).order("deadline_at", { ascending: false }),
    db.from("impact_features").select("*").eq("project_id", id),
  ]);
  const factList = (facts ?? []) as FactRecord[];
  const docFact = (docId: string, field: string) => factList.find((f) => f.document_id === docId && f.field === field)?.value ?? null;

  const participation: ParticipationRecord[] = (events ?? []).map((e) => {
    const detail = factList.find((f) => f.field === `participation.event.${e.id}`);
    let passage: { quote?: string; details?: Record<string, string> } = {};
    try {
      passage = detail?.page_or_passage ? JSON.parse(detail.page_or_passage) : {};
    } catch {
      /* ignore malformed */
    }
    const d = passage.details ?? {};
    const status =
      e.event_type === "comment_period" && e.deadline_at
        ? commentState(e.deadline_at, d.start, Date.now())
        : e.event_type === "hearing" && e.deadline_at
          ? hearingUpcoming((d.date ?? pacificDate(e.deadline_at)).slice(0, 10))
            ? "scheduled"
            : "past"
          : e.status;
    return { ...e, status, details: passage.details ?? {}, quote: passage.quote ?? null } as ParticipationRecord;
  });

  const summary = participationSummary(
    events ?? [],
    eventDetails(factList.filter((f) => f.field.startsWith("participation.event.")) as unknown as Row[]),
  );
  const sch = factList.find((f) => f.field === "identity.sch_number")?.value ?? null;
  const source = primarySource({
    sch_number: sch,
    documents: documents ?? [],
    case_numbers: factList.filter((f) => f.field === "identity.case_number").map((f) => f.value),
  });
  return {
    ...(p as unknown as ProjectDetail),
    lead_agency: latestFact(factList as unknown as Row[], documents ?? [], id, "identity.lead_agency"),
    sch_number: sch,
    source_id: source.id,
    source_url: source.url,
    index_level: factList.find((f) => f.field === "index.level")?.value === "lightweight" ? "lightweight" : "enriched",
    document_count: documents?.length ?? 0,
    ...summary,
    documents: (documents ?? []).map((d) => ({
      ...(d as DocumentRecord),
      retrieval_method: docFact(d.id, "document.retrieval_method"),
      document_type: docFact(d.id, "document.type"),
    })),
    facts: factList.filter((f) => !f.field.startsWith("participation.event.") && !f.field.startsWith("document.")),
    participation,
    impact_features: (features ?? []) as ImpactFeatureRecord[],
  };
}
