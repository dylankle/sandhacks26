import { connection } from "next/server";
import { getProject } from "@/lib/data/projects";
import { UUID, json } from "@/lib/http";

const parsePassage = (s: string | null) => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return { quote: s };
  }
};

/** GET /api/projects/[id]/export?format=json|geojson — downloadable structured record. */
export async function GET(req: Request, ctx: RouteContext<"/api/projects/[id]/export">) {
  await connection();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json({ error: "Invalid project id" }, 400);
  const format = new URL(req.url).searchParams.get("format") === "geojson" ? "geojson" : "json";
  const p = await getProject(id);
  if (!p) return json({ error: "Not found" }, 404);

  const docsById = new Map(p.documents.map((d) => [d.id, d]));
  const facts = p.facts.map((f) => ({
    field: f.field,
    value: f.value,
    unit: f.unit,
    method: f.method,
    review_status: f.review_status,
    evidence: parsePassage(f.page_or_passage),
    source_url: f.document_id ? docsById.get(f.document_id)?.source_url ?? null : null,
  }));
  const record = {
    exported_at: new Date().toISOString(),
    disclaimer:
      "Facts marked review_status=validated had their quoted passage found verbatim in the cited source; 'unverified' items are model extractions that did not pass that check. Summaries are AI-generated explanations.",
    project: {
      id: p.id,
      name: p.canonical_name,
      source: { id: p.source_id, url: p.source_url },
      category: p.category,
      status: p.status,
      jurisdiction: p.jurisdiction,
      lead_agency: p.lead_agency,
      description: p.description,
      ai_summary: p.summary,
      location: { latitude: p.latitude, longitude: p.longitude, precision: p.location_precision },
      last_checked_at: p.last_checked_at,
    },
    documents: p.documents,
    facts,
    participation: p.participation,
  };

  const filename = p.canonical_name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60);
  if (format === "geojson") {
    const fc = {
      type: "FeatureCollection",
      features: [
        ...(p.latitude !== null && p.longitude !== null
          ? [{ type: "Feature", geometry: { type: "Point", coordinates: [p.longitude, p.latitude] }, properties: { ...record.project, facts } }]
          : []),
        ...p.impact_features
          .filter((f) => f.category !== "project_site" && f.geojson && "geometry" in f.geojson)
          .map((f) => ({ ...(f.geojson as GeoJSON.Feature), properties: { ...(f.geojson as GeoJSON.Feature).properties, category: f.category, meaning: f.spatial_meaning } })),
      ],
    };
    return new Response(JSON.stringify(fc, null, 2), {
      headers: { "Content-Type": "application/geo+json", "Content-Disposition": `attachment; filename="${filename}.geojson"` },
    });
  }
  return new Response(JSON.stringify(record, null, 2), {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${filename}.json"` },
  });
}
