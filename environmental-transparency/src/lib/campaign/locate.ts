/**
 * Location verification for statewide records. A project becomes map-ready only when a reported
 * point passes every check below; otherwise it stays unlocated (no marker) with the reasons recorded.
 * Pure module: county boundaries are passed in.
 */
import { booleanPointInPolygon, point } from "@turf/turf";
import { parseDmsPair } from "@/lib/sources/parse";
import { inCalifornia } from "@/lib/pipeline/validate";
import type { CeqaFiling } from "@/lib/campaign/ceqa-feed";

export type CountyFC = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, { NAME: string }>;

export interface LocationCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export interface LocationVerdict {
  mapReady: boolean;
  lat: number | null;
  lng: number | null;
  precision: "reported_coordinates" | "unlocated";
  raw: string | null;
  county: string | null;
  checks: LocationCheck[];
  /** First failing check, phrased for residents. */
  reason: string | null;
}

/** Titles that describe linear, area-wide, or multi-site scopes, which a single point would misrepresent. */
const NON_POINT_SCOPE = /\bcounty[- ]?wide\b|\bcity[- ]?wide\b|\bstate[- ]?wide\b|\bregion(?:al)?[- ]?wide\b|\bprogram(?:matic)?\b|\bgeneral plan\b|\bspecific plan\b|\bmaster plan\b|\bvarious locations\b|\bmultiple (?:sites|locations)\b|\bcorridor\b|\bpipeline\b|\btransmission line\b|\bgen[- ]?tie\b|\brail line\b|\bsegments?\b|\bsystem[- ]?wide\b|\bnetwork\b/i;

export const normCounty = (s: string) =>
  s
    .toLowerCase()
    .replace(/\bcounty\b/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim();

/** Rounded coordinate key used to spot placeholder points shared by unrelated filings. */
export const coordKey = (lat: number, lng: number) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

/** Seconds-level DMS or ≥4 decimal places (≈10–30 m); degree-minute values are ±1.8 km. */
export function coordinatePrecisionOk(raw: string): boolean {
  const dms = [...raw.matchAll(/(\d{1,3})\s*°\s*(\d{1,2}(?:\.\d+)?)\s*['’′]\s*(\d{1,2}(?:\.\d+)?)?/g)];
  if (dms.length >= 2) return dms.every((m) => m[3] !== undefined);
  const dec = raw.match(/-?\d{1,3}\.(\d+)/g);
  return !!dec && dec.length >= 2 && dec.every((d) => (d.split(".")[1]?.length ?? 0) >= 4);
}

export function countyAt(counties: CountyFC, lat: number, lng: number): string | null {
  const pt = point([lng, lat]);
  for (const f of counties.features) if (booleanPointInPolygon(pt, f)) return f.properties.NAME;
  return null;
}

export function verifyLocation(
  f: CeqaFiling,
  title: string,
  counties: CountyFC,
  sharedCoordinateKeys: Set<string>,
): LocationVerdict {
  const checks: LocationCheck[] = [];
  const fail = (check: string, detail: string, reason: string, extra: Partial<LocationVerdict> = {}): LocationVerdict => {
    checks.push({ check, ok: false, detail });
    return { mapReady: false, lat: null, lng: null, precision: "unlocated", raw: f.coordinatesRaw, county: null, checks, reason, ...extra };
  };

  if (NON_POINT_SCOPE.test(title)) {
    const m = title.match(NON_POINT_SCOPE)![0];
    return fail("point_scope", `Title indicates a linear, area-wide, or multi-site scope ("${m}")`, "The project covers an area or route, so a single map point would misrepresent it.");
  }
  checks.push({ check: "point_scope", ok: true, detail: "Title describes a single site" });

  if (!f.coordinatesRaw) return fail("reported", "No coordinates in the State Clearinghouse filing", "The filing reports no site coordinates.");
  const c = parseDmsPair(f.coordinatesRaw);
  if (!c) return fail("parse", `Could not parse "${f.coordinatesRaw}"`, "The reported coordinates could not be read.");
  checks.push({ check: "parse", ok: true, detail: `"${f.coordinatesRaw}" → ${c.lat}, ${c.lng}` });

  if (!coordinatePrecisionOk(f.coordinatesRaw)) {
    return fail("precision", "Coordinates lack seconds/decimal precision (±1.8 km or worse)", "The reported coordinates are too coarse to mark a site.");
  }
  checks.push({ check: "precision", ok: true, detail: "Seconds-level or ≥4-decimal precision" });

  if (f.counties.length === 0) return fail("county_listed", "Filing lists no county to cross-check against", "The filing lists no county to confirm the point against.");
  if (f.counties.length > 1) {
    return fail("county_listed", `Filing lists ${f.counties.length} counties (${f.counties.join(", ")})`, "The filing spans several counties, so one point would misrepresent it.");
  }
  checks.push({ check: "county_listed", ok: true, detail: `Filing lists one county (${f.counties[0]})` });

  if (!inCalifornia(c.lat, c.lng)) return fail("in_state", "Point falls outside California", "The reported point is outside California.");
  const county = countyAt(counties, c.lat, c.lng);
  if (!county) return fail("in_state", "Point is not inside any California county land boundary", "The reported point is not inside a California county boundary (it may be offshore or mistyped).");
  checks.push({ check: "in_state", ok: true, detail: `Inside ${county} (U.S. Census TIGERweb county boundary)` });
  if (normCounty(f.counties[0]) !== normCounty(county)) {
    return fail("county_match", `Filing lists ${f.counties[0]} County but the point is in ${county}`, "The reported point is not in the county the filing names.", { county });
  }
  checks.push({ check: "county_match", ok: true, detail: `Listed county "${f.counties[0]}" contains the point` });

  if (sharedCoordinateKeys.has(coordKey(c.lat, c.lng))) {
    return fail("unique_point", "The same coordinates appear on filings for several unrelated projects (likely an agency office or placeholder)", "The reported point is shared with unrelated filings, which suggests a placeholder rather than the site.", { county });
  }
  checks.push({ check: "unique_point", ok: true, detail: "Coordinates not shared with unrelated filings" });

  return { mapReady: true, lat: c.lat, lng: c.lng, precision: "reported_coordinates", raw: f.coordinatesRaw, county, checks, reason: null };
}

/**
 * Coordinates that appear on ≥3 distinct SCH numbers whose titles differ. Agencies sometimes enter
 * their office or a jurisdiction centroid rather than the site.
 */
export function sharedCoordinates(filings: CeqaFiling[]): Set<string> {
  const by = new Map<string, Map<string, string>>();
  for (const f of filings) {
    if (!f.coordinatesRaw) continue;
    const c = parseDmsPair(f.coordinatesRaw);
    if (!c) continue;
    const k = coordKey(c.lat, c.lng);
    const m = by.get(k) ?? new Map<string, string>();
    m.set(f.sch, (f.projectTitle || f.docTitle).toLowerCase());
    by.set(k, m);
  }
  const out = new Set<string>();
  for (const [k, m] of by) if (m.size >= 3 && new Set(m.values()).size >= 3) out.add(k);
  return out;
}
