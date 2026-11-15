import { connection } from "next/server";
import { listProjects } from "@/lib/data/projects";
import { json } from "@/lib/http";

/** GET /api/projects — projects with map representation (GeoJSON FeatureCollection + list). */
export async function GET() {
  await connection();
  try {
    const projects = await listProjects();
    const features = projects
      .filter((p) => p.latitude !== null && p.longitude !== null)
      .map((p) => ({
        type: "Feature" as const,
        id: p.id,
        geometry: { type: "Point" as const, coordinates: [p.longitude!, p.latitude!] },
        properties: { ...p },
      }));
    return json({ projects, geojson: { type: "FeatureCollection", features } });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Failed to load projects" }, 500);
  }
}
