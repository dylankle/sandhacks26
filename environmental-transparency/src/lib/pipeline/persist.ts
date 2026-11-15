import "server-only";
import { getAdmin } from "@/lib/supabase/admin";
import type { ValidatedRecord } from "@/lib/pipeline/validate";

export interface DocToPersist {
  source_url: string;
  title: string | null;
  issuer: string | null;
  publication_date: string | null;
  retrieved_at: string;
  content_hash: string;
  retrieval_method: string;
  method_note: string | null;
}

export interface ImpactFeatureInput {
  docIndex: number | null;
  category: string;
  geojson: GeoJSON.Feature | GeoJSON.FeatureCollection;
  baseline_or_proposed: "baseline" | "proposed";
  spatial_meaning: string;
}

export interface PersistResult {
  projectId: string;
  createdProject: boolean;
  documents: { id: string; source_url: string; version: number; reused: boolean }[];
  factsInserted: number;
  eventsInserted: number;
  featuresInserted: number;
}

/** Stable identity for a map feature (jsonb does not preserve key order, so compare geometry only). */
export function featureKey(category: string, geojson: unknown): string {
  const g = (geojson as { geometry?: { coordinates?: unknown } } | null)?.geometry?.coordinates;
  return `${category}|${JSON.stringify(g ?? null)}`;
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Finds an existing project by SCH number, then case number, then normalized name. */
export async function matchProject(rec: ValidatedRecord["project"]): Promise<string | null> {
  const db = getAdmin();
  if (rec.sch_number) {
    const { data } = await db.from("facts").select("project_id").eq("field", "identity.sch_number").eq("value", rec.sch_number).limit(1);
    if (data?.[0]?.project_id) return data[0].project_id;
  }
  if (rec.case_numbers.length) {
    const { data } = await db.from("facts").select("project_id").eq("field", "identity.case_number").in("value", rec.case_numbers).limit(1);
    if (data?.[0]?.project_id) return data[0].project_id;
  }
  // Name fallback: exact normalized name AND same jurisdiction (statewide, generic names repeat).
  const { data } = await db.from("projects").select("id, canonical_name, jurisdiction").ilike("canonical_name", rec.canonical_name.replace(/[%_]/g, "\\$&"));
  const target = normName(rec.canonical_name);
  const city = rec.jurisdiction ? normName(rec.jurisdiction) : null;
  return (
    data?.find((p) => normName(p.canonical_name) === target && (!city || !p.jurisdiction || normName(p.jurisdiction).includes(city) || city.includes(normName(p.jurisdiction))))?.id ?? null
  );
}

/** Returns hashes already stored, so unchanged documents skip re-extraction. */
export async function existingHashes(hashes: string[]): Promise<Map<string, { id: string; project_id: string | null }>> {
  if (hashes.length === 0) return new Map();
  const { data, error } = await getAdmin().from("documents").select("id, project_id, content_hash").in("content_hash", hashes);
  if (error) throw new Error(`documents lookup failed: ${error.message}`);
  return new Map((data ?? []).map((d) => [d.content_hash as string, { id: d.id, project_id: d.project_id }]));
}

/**
 * Writes a validated record. Writes are ordered parent → child and every inserted row is
 * tracked; on any failure the inserted rows are deleted so no misleading partial record remains.
 * Existing evidence is never overwritten: revised documents become new versions.
 */
export async function persistRecord(
  rec: ValidatedRecord,
  docs: DocToPersist[],
  features: ImpactFeatureInput[],
  opts: { projectId?: string } = {},
): Promise<PersistResult> {
  const db = getAdmin();
  const inserted: { table: string; id: string }[] = [];
  const track = (table: string, rows: { id: string }[] | null) => rows?.forEach((r) => inserted.push({ table, id: r.id }));

  let projectSnapshot: Record<string, unknown> | null = null;
  let projectId = opts.projectId ?? (await matchProject(rec.project));
  const createdProject = !projectId;

  try {
    const p = rec.project;
    const projectFields = {
      canonical_name: p.canonical_name,
      category: p.category,
      status: p.status,
      description: p.description,
      developer: p.developer,
      jurisdiction: p.jurisdiction,
      summary: p.summary,
      last_checked_at: new Date().toISOString(),
      ...(p.latitude !== null && p.longitude !== null
        ? { latitude: p.latitude, longitude: p.longitude, location_precision: p.location_precision }
        : {}),
    };

    if (projectId) {
      const { data: before } = await db.from("projects").select("*").eq("id", projectId).single();
      projectSnapshot = before;
      // Keep the earlier name; never blank out fields the new document doesn't mention.
      const update = Object.fromEntries(
        Object.entries(projectFields).filter(([k, v]) => v !== null && v !== undefined && k !== "canonical_name"),
      );
      const { error } = await db.from("projects").update(update).eq("id", projectId);
      if (error) throw new Error(`project update failed: ${error.message}`);
    } else {
      const { data, error } = await db
        .from("projects")
        .insert({ ...projectFields, location_precision: p.location_precision })
        .select("id")
        .single();
      if (error || !data) throw new Error(`project insert failed: ${error?.message}`);
      projectId = data.id as string;
      inserted.push({ table: "projects", id: projectId });
    }

    // Documents (dedupe by content hash; revisions of the same URL get version+1).
    const hashes = await existingHashes(docs.map((d) => d.content_hash));
    const docIds: (string | null)[] = [];
    const docResults: PersistResult["documents"] = [];
    for (const d of docs) {
      const existing = hashes.get(d.content_hash);
      if (existing && existing.project_id === projectId) {
        docIds.push(existing.id);
        docResults.push({ id: existing.id, source_url: d.source_url, version: 0, reused: true });
        continue;
      }
      const { data: prior } = await db
        .from("documents")
        .select("version")
        .eq("source_url", d.source_url)
        .eq("project_id", projectId)
        .order("version", { ascending: false })
        .limit(1);
      const version = (prior?.[0]?.version ?? 0) + 1;
      const { data, error } = await db
        .from("documents")
        .insert({
          project_id: projectId,
          source_url: d.source_url,
          title: d.title,
          issuer: d.issuer,
          publication_date: d.publication_date,
          retrieved_at: d.retrieved_at,
          content_hash: d.content_hash,
          version,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`document insert failed: ${error?.message}`);
      inserted.push({ table: "documents", id: data.id });
      docIds.push(data.id);
      docResults.push({ id: data.id, source_url: d.source_url, version, reused: false });
    }
    const docId = (i: number | null) => (i === null ? null : docIds[i] ?? null);

    // Facts, including per-document provenance facts.
    const factRows = [
      ...rec.facts.map((f) => ({
        project_id: projectId,
        document_id: docId(f.docIndex),
        field: f.field,
        value: f.value,
        unit: f.unit,
        method: f.method,
        page_or_passage: f.passage ? JSON.stringify(f.passage) : null,
        review_status: f.review_status,
      })),
      ...docs.flatMap((d, i) => [
        {
          project_id: projectId,
          document_id: docIds[i],
          field: "document.retrieval_method",
          value: d.retrieval_method,
          unit: null,
          method: "derived",
          page_or_passage: d.method_note ? JSON.stringify({ quote: d.method_note }) : null,
          review_status: "validated",
        },
      ]),
    ];
    // Skip facts already recorded for this project with the same field, value and document.
    const { data: prevFacts } = await db.from("facts").select("field, value, document_id").eq("project_id", projectId);
    const seen = new Set((prevFacts ?? []).map((f) => `${f.field}|${f.value}|${f.document_id}`));
    const newFacts = factRows.filter((f) => !seen.has(`${f.field}|${f.value}|${f.document_id}`));
    if (newFacts.length) {
      const { data, error } = await db.from("facts").insert(newFacts).select("id");
      if (error) throw new Error(`facts insert failed: ${error.message}`);
      track("facts", data);
    }

    // Participation events; details/quotes are stored as linked facts.
    let eventsInserted = 0;
    const { data: prevEvents } = await db.from("participation_events").select("event_type, deadline_at").eq("project_id", projectId);
    const evSeen = new Set((prevEvents ?? []).map((e) => `${e.event_type}|${e.deadline_at ? Date.parse(e.deadline_at) : ""}`));
    for (const ev of rec.events) {
      const key = `${ev.event_type}|${ev.deadline_at ? Date.parse(ev.deadline_at) : ""}`;
      if (evSeen.has(key)) continue;
      evSeen.add(key);
      const { data, error } = await db
        .from("participation_events")
        .insert({
          project_id: projectId,
          source_document_id: docId(ev.docIndex),
          agency_name: ev.agency_name,
          event_type: ev.event_type,
          deadline_at: ev.deadline_at,
          status: ev.status,
          official_submission_url: ev.official_submission_url,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`participation insert failed: ${error?.message}`);
      inserted.push({ table: "participation_events", id: data.id });
      const { data: f, error: fe } = await db
        .from("facts")
        .insert({
          project_id: projectId,
          document_id: docId(ev.docIndex),
          field: `participation.event.${data.id}`,
          value: ev.event_type,
          unit: null,
          method: "parsed",
          page_or_passage: JSON.stringify(ev.passage),
          review_status: "validated",
        })
        .select("id");
      if (fe) throw new Error(`participation detail insert failed: ${fe.message}`);
      track("facts", f);
      eventsInserted++;
    }

    // Impact features (site point, schools named in filings). Replace only same-category proposed features.
    let featuresInserted = 0;
    if (features.length) {
      const { data: prevF } = await db.from("impact_features").select("id, category, geojson").eq("project_id", projectId);
      const prevKeys = new Set((prevF ?? []).map((f) => featureKey(f.category, f.geojson)));
      const rows = features
        .filter((f) => !prevKeys.has(featureKey(f.category, f.geojson)))
        .map((f) => ({
          project_id: projectId,
          source_document_id: docId(f.docIndex),
          category: f.category,
          geojson: f.geojson,
          baseline_or_proposed: f.baseline_or_proposed,
          spatial_meaning: f.spatial_meaning,
        }));
      if (rows.length) {
        const { data, error } = await db.from("impact_features").insert(rows).select("id");
        if (error) throw new Error(`impact feature insert failed: ${error.message}`);
        track("impact_features", data);
        featuresInserted = rows.length;
      }
    }

    return {
      projectId: projectId!,
      createdProject,
      documents: docResults,
      factsInserted: newFacts.length,
      eventsInserted,
      featuresInserted,
    };
  } catch (err) {
    // Compensating rollback, children first.
    for (const row of inserted.reverse()) {
      await db.from(row.table).delete().eq("id", row.id);
    }
    if (projectSnapshot && projectId) {
      const restore = { ...projectSnapshot };
      delete restore.id;
      await db.from("projects").update(restore).eq("id", projectId);
    }
    throw err;
  }
}
