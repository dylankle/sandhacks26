import { connection } from "next/server";
import { getProject, listProjects } from "@/lib/data/projects";

/** GET /api/export — every project as a GeoJSON FeatureCollection with validated facts and sources. */
export async function GET() {
  await connection();
  // Only mapped projects are exported; details load in small batches to bound database load.
  const summaries = (await listProjects()).filter(
    (s) => s.latitude !== null && s.longitude !== null,
  );
  const details: Awaited<ReturnType<typeof getProject>>[] = [];
  for (let i = 0; i < summaries.length; i += 8) {
    details.push(
      ...(await Promise.all(
        summaries.slice(i, i + 8).map((s) => getProject(s.id)),
      )),
    );
  }
  const features = details
    .filter((p) => p && p.latitude !== null && p.longitude !== null)
    .map((p) => {
      const validated = (prefix: string) =>
        p!.facts
          .filter(
            (f) =>
              f.field.startsWith(prefix) && f.review_status === "validated",
          )
          .map((f) => ({
            field: f.field,
            value: f.value,
            unit: f.unit,
            source_url:
              p!.documents.find((d) => d.id === f.document_id)?.source_url ??
              null,
          }));
      return {
        type: "Feature",
        id: p!.id,
        geometry: { type: "Point", coordinates: [p!.longitude, p!.latitude] },
        properties: {
          name: p!.canonical_name,
        source_id: p!.source_id,
        source_url: p!.source_url,
          category: p!.category,
          status: p!.status,
          jurisdiction: p!.jurisdiction,
          lead_agency: p!.lead_agency,
          location_precision: p!.location_precision,
          comment_status: p!.comment_status,
          comment_deadline: p!.comment_deadline,
          description: p!.description,
          validated_metrics: validated("metric."),
          validated_costs: validated("cost."),
          validated_proponents: validated("proponent."),
          validated_government: validated("government."),
          sources: p!.documents.map((d) => ({
            title: d.title,
            url: d.source_url,
            retrieved_at: d.retrieved_at,
            content_hash: d.content_hash,
            method: d.retrieval_method,
          })),
          last_checked_at: p!.last_checked_at,
        },
      };
    });
  return new Response(
    JSON.stringify(
      {
        type: "FeatureCollection",
        exported_at: new Date().toISOString(),
        features,
      },
      null,
      2,
    ),
    {
      headers: {
        "Content-Type": "application/geo+json",
        "Content-Disposition": 'attachment; filename="imby-projects.geojson"',
      },
    },
  );
}
