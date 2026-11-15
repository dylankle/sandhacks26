/**
 * Deterministic map state: which layers are visible for a given (view, mode, toggles) and which
 * census tracts form a selected site's vicinity. Pure functions, unit-tested, no MapLibre import.
 */
import { booleanIntersects, booleanPointInPolygon, circle, point } from "@turf/turf";

/** explore = no project; project = drawer open on a non-Impacts tab; impacts = Impacts tab. */
export type MapView = "explore" | "project" | "impacts";
export type MapMode = "existing" | "proposed";
export type CesExtent = "vicinity" | "region";

/** Contextual layers the reader can toggle. Development markers are not toggleable: they are always shown. */
export interface LayerState {
  schools: boolean;
  ces: boolean;
  reported: boolean;
  ring: boolean;
}

/** Defaults: baseline on (shown only in Impacts), schools off until the user asks for them. */
export const DEFAULT_LAYERS: LayerState = { schools: false, ces: true, reported: true, ring: true };

export const LAYER_GROUPS = {
  ces: ["ces-fill", "ces-line", "ces-site-casing", "ces-site-line"],
  schools: ["schools-cluster", "schools-cluster-count", "schools-icon", "schools-label"],
  reported: ["reported-halo", "reported-icon", "reported-label"],
  ring: ["ring-line", "ring-label"],
  projects: ["projects-cluster", "projects-cluster-count", "projects-open", "projects-selected", "projects-icon", "projects-status", "projects-label"],
} as const;

export type LayerId = (typeof LAYER_GROUPS)[keyof typeof LAYER_GROUPS][number];

export interface PlanInput {
  view: MapView;
  mode: MapMode;
  layers: LayerState;
  hasSite: boolean;
}

/** Visibility of every managed layer. Baseline and school context exist only inside Impacts. */
export function layerPlan({ view, mode, layers, hasSite }: PlanInput): Record<LayerId, boolean> {
  const impacts = view === "impacts" && hasSite;
  const proposed = impacts && mode === "proposed";
  const plan = {} as Record<LayerId, boolean>;
  const set = (ids: readonly LayerId[], on: boolean) => ids.forEach((id) => (plan[id] = on));
  set(LAYER_GROUPS.ces, impacts && layers.ces);
  set(LAYER_GROUPS.schools, impacts && layers.schools);
  set(LAYER_GROUPS.reported, proposed && layers.reported);
  set(LAYER_GROUPS.ring, proposed && layers.ring);
  // Development markers are always visible (filtering happens through category/status filters).
  set(LAYER_GROUPS.projects, true);
  return plan;
}

type TractFC = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, Record<string, number>>;

export interface Vicinity {
  siteTract: number | null;
  siteProps: Record<string, number> | null;
  nearTracts: number[];
  bbox: [number, number, number, number] | null;
}

/** Tract containing the site plus tracts intersecting a `km` radius (geographic comparison only). */
export function vicinityOf(ces: TractFC | null, site: [number, number] | null, km: number): Vicinity {
  if (!ces || !site) return { siteTract: null, siteProps: null, nearTracts: [], bbox: null };
  const pt = point(site);
  const area = circle(site, km, { units: "kilometers", steps: 48 });
  let siteHit: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, Record<string, number>> | null = null;
  const near: number[] = [];
  for (const f of ces.features) {
    if (!siteHit && booleanPointInPolygon(pt, f)) siteHit = f;
    if (booleanIntersects(area, f)) near.push(f.properties.tract);
  }
  // Camera frame: the vicinity radius plus the whole site tract (neighbors may be large; they are context only).
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  const extend = (ring: number[][]) => {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  };
  extend(area.geometry.coordinates[0]);
  if (siteHit) for (const poly of siteHit.geometry.type === "Polygon" ? [siteHit.geometry.coordinates] : siteHit.geometry.coordinates) extend(poly[0]);
  return {
    siteTract: siteHit?.properties.tract ?? null,
    siteProps: siteHit?.properties ?? null,
    nearTracts: near.filter((t) => t !== siteHit?.properties.tract),
    bbox: [minX, minY, maxX, maxY],
  };
}

/** Points within `km` of the site (school context is limited to the vicinity). */
export function pointsNear<T extends GeoJSON.Feature<GeoJSON.Point>>(features: T[], site: [number, number], km: number): T[] {
  const lat = (site[1] * Math.PI) / 180;
  return features.filter((f) => {
    const [x, y] = f.geometry.coordinates;
    const dx = (x - site[0]) * 111.32 * Math.cos(lat);
    const dy = (y - site[1]) * 110.57;
    return Math.hypot(dx, dy) <= km;
  });
}
