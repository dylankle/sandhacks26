import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { distance, point } from "@turf/turf";

type FC = GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>> & { metadata?: Record<string, unknown> };

let schools: FC | null = null;
async function loadSchools(): Promise<FC> {
  schools ??= JSON.parse(await readFile(join(process.cwd(), "public", "gis", "schools.geojson"), "utf8")) as FC;
  return schools;
}

const GENERIC = new Set(["school", "schools", "elementary", "elem", "es", "ms", "hs", "middle", "high", "the", "of", "k", "8", "academy", "charter", "and", "center", "intermediate"]);
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !GENERIC.has(t));

/**
 * Matches school names listed in a CEQA filing (e.g. "Scott Lane ES") to CDE school points
 * within 8 km of the site. Unmatched names are returned so the UI can say so.
 */
export async function matchReportedSchools(names: string, site: { lat: number; lng: number }) {
  const fc = await loadSchools();
  const origin = point([site.lng, site.lat]);
  const nearby = fc.features
    .map((f) => ({ f, km: distance(origin, f, { units: "kilometers" }) }))
    .filter((x) => x.km <= 8);
  const matched: { name: string; feature: GeoJSON.Feature<GeoJSON.Point>; km: number }[] = [];
  const unmatched: string[] = [];
  for (const raw of names.split(/,|;| and /).map((s) => s.trim()).filter(Boolean)) {
    const q = tokens(raw);
    if (q.length === 0) {
      unmatched.push(raw);
      continue;
    }
    let best: { score: number; f: GeoJSON.Feature<GeoJSON.Point>; km: number } | null = null;
    for (const { f, km } of nearby) {
      const t = new Set(tokens(String(f.properties?.SchoolName ?? "")));
      const hits = q.filter((x) => t.has(x)).length;
      const score = hits / q.length - km / 100;
      if (hits / q.length >= 0.99 && (!best || score > best.score)) best = { score, f, km };
    }
    if (best) matched.push({ name: raw, feature: best.f, km: best.km });
    else unmatched.push(raw);
  }
  return { matched, unmatched, dataset: fc.metadata ?? null };
}
