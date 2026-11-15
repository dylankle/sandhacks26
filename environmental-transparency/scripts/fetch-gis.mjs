#!/usr/bin/env node
/**
 * Downloads authoritative baseline GIS layers for the study area into public/gis/.
 * Run once (or to refresh): `npm run gis:fetch`. No API keys; public ArcGIS REST services.
 *
 *  - California Department of Education, California Public Schools 2025-26
 *  - OEHHA CalEnviroScreen 4.0 census-tract results
 *  - U.S. Census Bureau TIGERweb California place index (cities, CDPs, counties → bounding boxes)
 *  - U.S. Census Bureau TIGERweb California county boundaries (statewide; used server-side to verify
 *    that a reported site point lies in the county its filing names)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// North San José / Santa Clara study area (lng/lat envelope)
const BBOX = { xmin: -122.1, ymin: 37.28, xmax: -121.78, ymax: 37.47 };

const LAYERS = [
  {
    file: "schools.geojson",
    name: "California Public Schools 2025-26",
    publisher: "California Department of Education",
    url: "https://services3.arcgis.com/fdvHcZVgB2QSRNkL/arcgis/rest/services/SchoolSites2526/FeatureServer/0",
    landing: "https://catalog.data.gov/dataset/california-public-schools-2025-26",
    where: "Status='Active'",
    outFields: "SchoolName,DistrictName,SchoolLevel,SchoolType,GradeLow,GradeHigh,EnrollTotal,Street,City,CDSCode",
    note: "Active public K-12 school sites (points). Excludes private schools and district offices.",
  },
  {
    file: "calenviroscreen.geojson",
    name: "CalEnviroScreen 4.0 Results",
    publisher: "California Office of Environmental Health Hazard Assessment (OEHHA)",
    url: "https://services1.arcgis.com/PCHfdHz4GlDNAhBb/arcgis/rest/services/CalEnviroScreen_4_0_Results_/FeatureServer/0",
    landing: "https://oehha.ca.gov/calenviroscreen/report/calenviroscreen-40",
    where: "1=1",
    outFields: "tract,ACS2019TotalPop,CIscore,CIscoreP,pm,pmP,diesel,dieselP,traffic,trafficP,ozoneP,asthma,asthmaP,cvdP,povP,PollutionP,PopCharP",
    note:
      "Census-tract cumulative pollution burden and population vulnerability percentiles (statewide). Published Oct 2021 using data mostly from 2015–2019. Describes existing conditions; it does not measure any proposed project's effects.",
  },
  {
    file: "ca-counties.geojson",
    name: "TIGERweb Counties (current)",
    publisher: "U.S. Census Bureau",
    url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1",
    landing: "https://tigerweb.geo.census.gov/tigerwebmain/TIGERweb_main.html",
    where: "STATE='06'",
    outFields: "NAME,GEOID",
    statewide: true,
    // ~300 m generalization: ample for county containment, keeps the file ~170 KB.
    maxAllowableOffset: "0.003",
    note: "California county boundaries, generalized (~300 m). Used only to cross-check reported coordinates against the county listed in a filing.",
  },
];

async function fetchLayer(layer) {
  const q = new URLSearchParams({
    where: layer.where,
    ...(layer.statewide
      ? { maxAllowableOffset: layer.maxAllowableOffset }
      : {
          geometry: `${BBOX.xmin},${BBOX.ymin},${BBOX.xmax},${BBOX.ymax}`,
          geometryType: "esriGeometryEnvelope",
          inSR: "4326",
          spatialRel: "esriSpatialRelIntersects",
        }),
    returnGeometry: "true",
    outFields: layer.outFields,
    outSR: "4326",
    geometryPrecision: "5",
    f: "geojson",
    resultRecordCount: "2000",
  });
  const res = await fetch(`${layer.url}/query?${q}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${layer.name}: HTTP ${res.status}`);
  const fc = await res.json();
  if (!Array.isArray(fc.features)) throw new Error(`${layer.name}: unexpected response ${JSON.stringify(fc).slice(0, 200)}`);
  return {
    type: "FeatureCollection",
    metadata: {
      name: layer.name,
      publisher: layer.publisher,
      service: layer.url,
      landing: layer.landing,
      retrieved_at: new Date().toISOString(),
      bbox: layer.statewide ? "California (statewide)" : BBOX,
      note: layer.note,
    },
    features: fc.features,
  };
}

/**
 * California place index for the location prompt: every incorporated city, census-designated place and
 * county with its bounding box (U.S. Census TIGERweb). Names + boxes only, so it stays small.
 */
const PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer";
const bboxOf = (geom) => {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => (typeof c[0] === "number" ? ((w = Math.min(w, c[0])), (e = Math.max(e, c[0])), (s = Math.min(s, c[1])), (n = Math.max(n, c[1]))) : c.forEach(walk));
  walk(geom.coordinates);
  return [w, s, e, n].map((v) => +v.toFixed(4));
};
async function fetchPlaces(layer, kind) {
  const out = [];
  for (let offset = 0; ; offset += 400) {
    const q = new URLSearchParams({ where: "STATE='06'", outFields: "BASENAME,GEOID", returnGeometry: "true", maxAllowableOffset: "0.002", geometryPrecision: "4", outSR: "4326", f: "geojson", resultOffset: String(offset), resultRecordCount: "400", orderByFields: "GEOID" });
    const res = await fetch(`${PLACES}/${layer}/query?${q}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`places layer ${layer}: HTTP ${res.status}`);
    const fc = await res.json();
    for (const f of fc.features ?? []) if (f.geometry) out.push({ name: f.properties.BASENAME, kind, geoid: f.properties.GEOID, bbox: bboxOf(f.geometry) });
    if (!fc.features?.length || fc.features.length < 400) return out;
  }
}
async function buildPlaceIndex(dir) {
  const counties = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "ca-counties.geojson"), "utf8"));
  const places = [
    ...counties.features.map((f) => ({ name: f.properties.NAME, kind: "county", geoid: f.properties.GEOID, bbox: bboxOf(f.geometry) })),
    ...(await fetchPlaces(4, "city")),
    ...(await fetchPlaces(5, "community")),
  ];
  return {
    metadata: {
      name: "California place index (cities, census-designated places, counties)",
      publisher: "U.S. Census Bureau (TIGERweb)",
      service: PLACES,
      retrieved_at: new Date().toISOString(),
      note: "Bounding boxes only, used to frame the map on a place the reader enters. Not legal boundaries.",
    },
    places,
  };
}

const out = join(process.cwd(), "public", "gis");
await mkdir(out, { recursive: true });
const only = process.argv.slice(2);
for (const layer of LAYERS.filter((l) => only.length === 0 || only.includes(l.file))) {
  const fc = await fetchLayer(layer);
  await writeFile(join(out, layer.file), JSON.stringify(fc));
  console.log(`${layer.file}: ${fc.features.length} features`);
}
if (only.length === 0 || only.includes("ca-places.json")) {
  const idx = await buildPlaceIndex(out);
  await writeFile(join(out, "ca-places.json"), JSON.stringify(idx));
  console.log(`ca-places.json: ${idx.places.length} places`);
}
