/**
 * Resolves a typed California city, community or county to an official Census place (bounding box),
 * using the static index built by `npm run gis:fetch` (public/gis/ca-places.json). Pure functions.
 */

export type PlaceKind = "city" | "community" | "county";

export interface Place {
  name: string;
  kind: PlaceKind;
  geoid: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
}

/** Lowercase, accents removed ("San José" → "san jose"), punctuation collapsed. */
export function normPlace(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Strips "city of", "town of", trailing ", CA"/"California" so typed variants match Census names. */
function core(input: string): { text: string; wantsCounty: boolean } {
  let t = normPlace(input)
    .replace(/\b(ca|calif|california|usa|us)$/g, "")
    .trim()
    .replace(/^(city|town|county) (and county )?of /, "")
    .trim();
  const wantsCounty = /\bcounty\b/.test(normPlace(input));
  t = t.replace(/\bcounty\b/g, "").replace(/\s+/g, " ").trim();
  return { text: t, wantsCounty };
}

const placeCore = (p: Place) => normPlace(p.name).replace(/\bcounty\b/g, "").replace(/\s+/g, " ").trim();
const KIND_RANK: Record<PlaceKind, number> = { city: 0, community: 1, county: 2 };

export function placeLabel(p: Place): string {
  if (p.kind === "county") return p.name;
  return `${p.name} (${p.kind === "city" ? "city" : "community"})`;
}

/** Exact match on the place name. "Fresno" → the city; "Fresno County" → the county. */
export function resolvePlace(input: string, places: Place[]): Place | null {
  const { text, wantsCounty } = core(input);
  if (!text) return null;
  // A label picked from the suggestions ("Mountain View (community)") resolves to exactly that place.
  const labelled = places.find((p) => normPlace(placeLabel(p)) === normPlace(input));
  if (labelled) return labelled;
  const hits = places.filter((p) => placeCore(p) === text);
  if (!hits.length) return null;
  if (wantsCounty) return hits.find((p) => p.kind === "county") ?? null;
  return [...hits].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind])[0];
}

/** Autocomplete: prefix matches first (cities, then counties, then communities), then word matches. */
export function suggestPlaces(input: string, places: Place[], limit = 8): Place[] {
  const { text, wantsCounty } = core(input);
  if (text.length < 2) return [];
  const rank = (p: Place) => (p.kind === "city" ? 0 : p.kind === "county" ? 1 : 2);
  const scored = places
    .filter((p) => !wantsCounty || p.kind === "county")
    .map((p) => {
      const n = placeCore(p);
      const score = n === text ? 0 : n.startsWith(text) ? 1 : n.split(" ").some((w) => w.startsWith(text)) ? 2 : -1;
      return { p, score };
    })
    .filter((x) => x.score >= 0);
  return scored
    .sort((a, b) => a.score - b.score || rank(a.p) - rank(b.p) || a.p.name.length - b.p.name.length || a.p.name.localeCompare(b.p.name))
    .slice(0, limit)
    .map((x) => x.p);
}
