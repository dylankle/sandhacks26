"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { circle } from "@turf/turf";
import { CATEGORY_STYLES, CES_INDICATORS, CES_RAMP, DATASETS, STATUS_COLORS, STUDY_AREA, VICINITY_KM, formatRaw, type CesIndicator } from "@/lib/client/gis";
import { layerPlan, pointsNear, vicinityOf, type CesExtent, type LayerState, type MapMode, type MapView } from "@/lib/client/map-state";
import { markerImages } from "@/lib/client/map-icons";
import type { Evidence } from "@/lib/client/facts";
import { CATEGORY_LABELS, STATUS_LABELS, type ProjectCategory, type ProjectDetail, type ProjectStatus } from "@/types/project";

export type { LayerState, MapMode } from "@/lib/client/map-state";

export interface MapViewport {
  /** [west, south, east, north] */
  bounds: [number, number, number, number];
  center: [number, number];
  zoom: number;
}

interface Props {
  projectsGeo: GeoJSON.FeatureCollection | null;
  /** Changes when the search/category filter changes; the map then fits the matching sites. */
  fitKey: string;
  /** Area the reader chose (city/county bounding box or the whole state); the map opens framed on it. */
  focus: { key: string; bbox: [number, number, number, number] };
  /** Reports the visible area after every camera move (the sidebar's geographic scope). */
  onView?: (v: MapViewport) => void;
  selected: ProjectDetail | null;
  selectedId: string | null;
  view: MapView;
  mode: MapMode;
  layers: LayerState;
  cesExtent: CesExtent;
  indicator: CesIndicator;
  rightInset: number;
  onSelect: (id: string) => void;
  onEvidence: (e: Evidence) => void;
  onTract: (props: Record<string, number> | null) => void;
}

// MapLibre 6 resolves its worker relative to its own module URL, which bundling breaks.
// The worker is copied to /public by the predev/prebuild scripts.
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

const STYLE = "https://tiles.openfreemap.org/styles/positron";
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const FONT = ["Noto Sans Regular"];

type Expr = maplibregl.ExpressionSpecification;
const expr = (e: unknown) => e as Expr;
const single = expr(["!", ["has", "point_count"]]);

const statusColor = expr(["match", ["get", "status"], ...Object.entries(STATUS_COLORS).flat(), STATUS_COLORS.unknown]);
const categoryIcon = expr(["match", ["get", "category"], ...Object.keys(CATEGORY_STYLES).flatMap((c) => [c, `cat-${c}`]), "cat-other"]);

function cesColor(ind: CesIndicator) {
  return expr([
    "case",
    ["<", ["to-number", ["coalesce", ["get", ind], -1], -1], 0],
    "rgba(0,0,0,0)",
    ["interpolate", ["linear"], ["to-number", ["coalesce", ["get", ind], 0], 0], ...CES_RAMP.flat()],
  ]);
}

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function tractPopupHtml(props: Record<string, unknown>, active: CesIndicator, isSite: boolean) {
  const rows = (Object.keys(CES_INDICATORS) as CesIndicator[])
    .map((k) => {
      const pct = Number(props[k]);
      const on = k === active;
      return `<tr style="${on ? "background:#f6efe2;font-weight:600" : ""}"><td style="padding:3px 6px">${CES_INDICATORS[k].short}</td><td style="padding:3px 6px;font-family:var(--font-mono);font-size:11px">${esc(formatRaw(k, props))}</td><td style="padding:3px 6px;text-align:right;font-family:var(--font-mono)">${pct >= 0 ? `${pct.toFixed(0)}th` : "n/a"}</td></tr>`;
    })
    .join("");
  return `<div style="min-width:280px;max-width:320px">
  <p style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#807a70;margin:0">${isSite ? "Tract containing the project site" : "Census tract"} · existing conditions</p>
  <p style="font-weight:600;margin:2px 0 6px">Tract ${esc(props.tract)} · pop. ${Number(props.ACS2019TotalPop).toLocaleString()}</p>
  <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="color:#807a70;font-size:10px;text-align:left"><th style="padding:2px 6px">Indicator</th><th style="padding:2px 6px">Value</th><th style="padding:2px 6px;text-align:right">Statewide pct.</th></tr></thead><tbody>${rows}</tbody></table>
  <p style="font-size:11px;color:#807a70;margin:6px 0 0">${DATASETS.ces.name} · ${DATASETS.ces.publisher}. Baseline conditions (2015–2019 data), not effects of any proposed project.</p></div>`;
}

function projectPopupHtml(props: Record<string, unknown>) {
  const cat = String(props.category ?? "other");
  const color = CATEGORY_STYLES[cat]?.color ?? CATEGORY_STYLES.other.color;
  const status = String(props.status);
  const comment = props.comment_status === "open" ? `<span style="color:#12805c;font-weight:600">· comments open</span>` : "";
  return `<div style="min-width:220px;max-width:280px">
  <p style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${color};font-weight:600;margin:0">${esc(CATEGORY_LABELS[cat as ProjectCategory] ?? cat)}</p>
  <p style="font-family:var(--font-serif);font-size:16px;line-height:1.2;margin:2px 0 4px">${esc(props.canonical_name)}</p>
  <p style="font-size:12px;margin:0"><span style="color:${STATUS_COLORS[status] ?? "#6b7280"};font-weight:600">● ${esc(STATUS_LABELS[status as ProjectStatus] ?? status)}</span> ${comment}</p>
  <p style="font-size:12px;color:#4a463f;margin:4px 0 0">${esc(props.jurisdiction)} · ${esc(props.lead_agency ?? "Agency not stated")}</p>
  <p style="font-size:11px;color:#807a70;margin:4px 0 0">${esc(props.document_count)} official source documents · evidence in the side panel</p></div>`;
}

export default function ProjectMap(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const popup = useRef<maplibregl.Popup | null>(null);
  const [ready, setReady] = useState(false);
  const [cesData, setCesData] = useState<GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, Record<string, number>> | null>(null);
  const schoolData = useRef<GeoJSON.FeatureCollection<GeoJSON.Point> | null>(null);
  const cameraKey = useRef<string>("");
  const siteTractRef = useRef<number | null>(null);
  const popupKind = useRef<"project" | "tract" | null>(null);
  const cb = useRef(p);
  useEffect(() => {
    cb.current = p;
  });

  // Selected site coordinates come from the list GeoJSON so camera/vicinity don't wait for detail loads.
  const site = useMemo<[number, number] | null>(() => {
    const f = p.projectsGeo?.features.find((x) => String(x.id) === p.selectedId);
    return f ? ((f.geometry as GeoJSON.Point).coordinates as [number, number]) : null;
  }, [p.projectsGeo, p.selectedId]);
  const siteKey = site ? `${p.selectedId}|${site[0]},${site[1]}` : "";
  const vicinity = useMemo(() => vicinityOf(cesData, site, VICINITY_KM), [cesData, siteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- init (once) ------------------------------------------------------------------
  useEffect(() => {
    if (!el.current) return;
    const [w, s, e, n] = cb.current.focus.bbox;
    const m = new maplibregl.Map({
      container: el.current,
      style: STYLE,
      bounds: [[w, s], [e, n]],
      fitBoundsOptions: { padding: 32, maxZoom: 12.5 },
      attributionControl: { compact: true },
    });
    map.current = m;
    // Read-only handle for the end-to-end test (scripts/e2e.mjs) to inspect layer state.
    (window as unknown as { __imbyMap?: maplibregl.Map }).__imbyMap = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    m.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");
    popup.current = new maplibregl.Popup({ closeButton: true, maxWidth: "340px", offset: 14 });

    m.on("load", async () => {
      const [ces, schools, images] = await Promise.all([
        fetch("/gis/calenviroscreen.geojson").then((r) => r.json()),
        fetch("/gis/schools.geojson").then((r) => r.json()),
        markerImages(),
      ]);
      for (const { id, image } of images) if (!m.hasImage(id)) m.addImage(id, image, { pixelRatio: 2 });
      schoolData.current = schools;
      const firstSymbol = m.getStyle().layers.find((l) => l.type === "symbol")?.id;
      const hidden = { visibility: "none" as const };

      // Baseline polygons sit under basemap labels; everything project-related stacks above.
      m.addSource("ces", { type: "geojson", data: ces });
      m.addLayer(
        {
          id: "ces-fill",
          type: "fill",
          source: "ces",
          layout: hidden,
          paint: { "fill-color": cesColor("CIscoreP"), "fill-opacity": 0.5, "fill-opacity-transition": { duration: 450 }, "fill-color-transition": { duration: 450 } },
        },
        firstSymbol,
      );
      m.addLayer({ id: "ces-line", type: "line", source: "ces", layout: hidden, paint: { "line-color": "#8d7a5e", "line-width": 0.6, "line-opacity": 0.55 } }, firstSymbol);
      m.addLayer({ id: "ces-site-casing", type: "line", source: "ces", layout: hidden, filter: ["==", ["get", "tract"], -1], paint: { "line-color": "#fffdf9", "line-width": 5 } });
      m.addLayer({ id: "ces-site-line", type: "line", source: "ces", layout: hidden, filter: ["==", ["get", "tract"], -1], paint: { "line-color": "#1d1b18", "line-width": 2.2 } });

      m.addSource("ring", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "ring-line", type: "line", source: "ring", layout: hidden, paint: { "line-color": "#1d1b18", "line-width": 1.4, "line-dasharray": [1, 2], "line-opacity": 0.8 } });
      m.addLayer({
        id: "ring-label",
        type: "symbol",
        source: "ring",
        layout: { ...hidden, "symbol-placement": "line", "text-field": "1 km reference distance — not an impact boundary", "text-font": FONT, "text-size": 11 },
        paint: { "text-color": "#1d1b18", "text-halo-color": "#fffdf9", "text-halo-width": 1.6 },
      });

      // Schools: vicinity-limited, clustered at low zoom.
      m.addSource("schools", { type: "geojson", data: EMPTY, cluster: true, clusterRadius: 38, clusterMaxZoom: 13 });
      m.addLayer({
        id: "schools-cluster",
        type: "circle",
        source: "schools",
        layout: hidden,
        filter: ["has", "point_count"],
        paint: { "circle-color": "#e8eef4", "circle-stroke-color": "#24517a", "circle-stroke-width": 1.2, "circle-radius": ["step", ["get", "point_count"], 10, 5, 13, 10, 16] },
      });
      m.addLayer({
        id: "schools-cluster-count",
        type: "symbol",
        source: "schools",
        layout: { ...hidden, "text-field": ["get", "point_count_abbreviated"], "text-font": FONT, "text-size": 11, "text-allow-overlap": true },
        filter: ["has", "point_count"],
        paint: { "text-color": "#24517a" },
      });
      m.addLayer({
        id: "schools-icon",
        type: "symbol",
        source: "schools",
        filter: ["!", ["has", "point_count"]],
        layout: { ...hidden, "icon-image": "school", "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.9, 16, 1.1], "icon-allow-overlap": true },
      });
      m.addLayer({
        id: "schools-label",
        type: "symbol",
        source: "schools",
        minzoom: 14.5,
        filter: ["!", ["has", "point_count"]],
        layout: { ...hidden, "text-field": ["get", "SchoolName"], "text-font": FONT, "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top", "text-optional": true },
        paint: { "text-color": "#24517a", "text-halo-color": "#ffffff", "text-halo-width": 1.4 },
      });

      m.addSource("reported", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "reported-halo", type: "circle", source: "reported", layout: hidden, paint: { "circle-radius": 17, "circle-color": "rgba(180,70,43,0.12)", "circle-stroke-color": "#b4462b", "circle-stroke-width": 1 } });
      m.addLayer({ id: "reported-icon", type: "symbol", source: "reported", layout: { ...hidden, "icon-image": "school-reported", "icon-allow-overlap": true } });
      m.addLayer({
        id: "reported-label",
        type: "symbol",
        source: "reported",
        layout: {
          ...hidden,
          "text-field": ["concat", ["get", "SchoolName"], "\n", ["to-string", ["get", "km_from_site"]], " km · named in filing"],
          "text-font": FONT,
          "text-size": 11,
          "text-offset": [0, 1.6],
          "text-anchor": "top",
        },
        paint: { "text-color": "#8a3520", "text-halo-color": "#fffdf9", "text-halo-width": 1.6 },
      });

      // Projects: category landmark badge + separate status dot, always on top.
      // Statewide: cluster at low zoom so thousands of sites stay legible; individual badges from zoom 9.
      m.addSource("projects", { type: "geojson", data: EMPTY, promoteId: "id", cluster: true, clusterMaxZoom: 8, clusterRadius: 36 });
      m.addLayer({
        id: "projects-cluster",
        type: "circle",
        source: "projects",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#fffdf9",
          "circle-stroke-color": "#1d1b18",
          "circle-stroke-width": 1.4,
          "circle-radius": ["step", ["get", "point_count"], 13, 10, 16, 50, 20, 200, 25],
        },
      });
      m.addLayer({
        id: "projects-cluster-count",
        type: "symbol",
        source: "projects",
        filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": FONT, "text-size": 12, "text-allow-overlap": true },
        paint: { "text-color": "#1d1b18" },
      });
      m.addLayer({
        id: "projects-open",
        type: "circle",
        source: "projects",
        filter: ["all", single, ["==", ["get", "comment_status"], "open"]],
        paint: { "circle-radius": 24, "circle-color": "rgba(18,128,92,0.10)", "circle-stroke-color": "#12805c", "circle-stroke-width": 1.5 },
      });
      m.addLayer({
        id: "projects-selected",
        type: "circle",
        source: "projects",
        filter: ["==", ["get", "id"], ""],
        paint: { "circle-radius": 23, "circle-color": "rgba(29,27,24,0.08)", "circle-stroke-color": "#1d1b18", "circle-stroke-width": 2 },
      });
      m.addLayer({
        id: "projects-icon",
        type: "symbol",
        source: "projects",
        filter: single,
        layout: { "icon-image": categoryIcon, "icon-size": 1, "icon-allow-overlap": true, "icon-ignore-placement": true },
        paint: { "icon-opacity": 1, "icon-opacity-transition": { duration: 300 } },
      });
      m.addLayer({
        id: "projects-status",
        type: "circle",
        source: "projects",
        filter: single,
        paint: { "circle-radius": 4.5, "circle-color": statusColor, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5, "circle-translate": [12, -12] },
      });
      m.addLayer({
        id: "projects-label",
        type: "symbol",
        source: "projects",
        minzoom: 11,
        filter: single,
        layout: { "text-field": ["get", "canonical_name"], "text-font": FONT, "text-size": 12, "text-offset": [0, 1.75], "text-anchor": "top", "text-max-width": 12, "text-optional": true },
        paint: { "text-color": "#1d1b18", "text-halo-color": "#fffdf9", "text-halo-width": 2 },
      });

      // --- interactions ---
      for (const id of ["projects-icon", "projects-cluster", "schools-icon", "schools-cluster", "reported-icon", "ces-fill"]) {
        m.on("mouseenter", id, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", id, () => (m.getCanvas().style.cursor = ""));
      }
      m.on("click", async (e) => {
        const order = ["projects-icon", "projects-cluster", "reported-icon", "schools-icon", "schools-cluster", "ces-fill"];
        const hits = m.queryRenderedFeatures(e.point, { layers: order.filter((l) => m.getLayer(l) && m.getLayoutProperty(l, "visibility") !== "none") });
        const top = hits.sort((a, b) => order.indexOf(a.layer.id) - order.indexOf(b.layer.id))[0];
        if (!top) return;
        const props = top.properties as Record<string, unknown>;
        const pt = (top.geometry as GeoJSON.Point).coordinates as [number, number];
        if (top.layer.id === "projects-icon") {
          popupKind.current = "project";
          popup.current!.setLngLat(pt).setHTML(projectPopupHtml(props)).addTo(m);
          cb.current.onSelect(String(props.id));
        } else if (top.layer.id === "projects-cluster") {
          const zoom = await (m.getSource("projects") as maplibregl.GeoJSONSource).getClusterExpansionZoom(Number(props.cluster_id));
          m.easeTo({ center: pt, zoom: zoom + 0.3, duration: 500 });
        } else if (top.layer.id === "schools-cluster") {
          const zoom = await (m.getSource("schools") as maplibregl.GeoJSONSource).getClusterExpansionZoom(Number(props.cluster_id));
          m.easeTo({ center: pt, zoom: zoom + 0.5, duration: 500 });
        } else if (top.layer.id === "reported-icon" || top.layer.id === "schools-icon") {
          const reported = top.layer.id === "reported-icon";
          const sel = cb.current.selected;
          const imp = reported ? sel?.impact_features.find((f) => f.category === "reported_nearby_school" && (f.geojson as GeoJSON.Feature)?.properties?.CDSCode === props.CDSCode) : null;
          cb.current.onEvidence({
            title: String(props.SchoolName),
            value: `${props.SchoolLevel ?? ""} · grades ${props.GradeLow ?? "?"}–${props.GradeHigh ?? "?"} · ${props.EnrollTotal ?? "?"} students`,
            unit: null,
            reviewStatus: reported ? "validated" : "dataset",
            method: reported ? "parsed" : "dataset",
            quote: reported ? `Schools: … ${props.listed_as} …` : null,
            page: null,
            context: `${props.Street}, ${props.City} · ${props.DistrictName}${reported ? ` · ${props.km_from_site} km from reported site` : ""}`,
            document: imp ? sel?.documents.find((d) => d.id === imp.source_document_id) ?? null : null,
            dataset: { name: DATASETS.schools.name, publisher: DATASETS.schools.publisher, url: DATASETS.schools.url },
            limitations: [...(imp?.spatial_meaning ? [imp.spatial_meaning] : []), ...DATASETS.schools.limitations],
          });
        } else if (top.layer.id === "ces-fill") {
          const isSite = Number(props.tract) === siteTractRef.current;
          popupKind.current = "tract";
          popup.current!.setLngLat(e.lngLat).setHTML(tractPopupHtml(props, cb.current.indicator, isSite)).addTo(m);
        }
      });
      const report = () => {
        const b = m.getBounds();
        const c = m.getCenter();
        cb.current.onView?.({ bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], center: [c.lng, c.lat], zoom: m.getZoom() });
      };
      m.on("moveend", report);
      report();
      setCesData(ces);
      setReady(true);
    });
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // --- project markers ------------------------------------------------------------
  useEffect(() => {
    if (!ready || !p.projectsGeo) return;
    (map.current!.getSource("projects") as maplibregl.GeoJSONSource).setData(p.projectsGeo);
  }, [ready, p.projectsGeo]);

  // A new chosen area reframes the map (the first one is applied at construction).
  const focusKey = useRef(p.focus.key);
  useEffect(() => {
    if (!ready || focusKey.current === p.focus.key) return;
    focusKey.current = p.focus.key;
    const [w, s, e, n] = p.focus.bbox;
    map.current!.fitBounds([[w, s], [e, n]], { padding: 32, maxZoom: 12.5, duration: 900 });
  }, [ready, p.focus.key]); // eslint-disable-line react-hooks/exhaustive-deps -- bbox follows key

  // Geographic search: when the filter changes (and no project is open), frame the matching sites.
  const lastFit = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !p.projectsGeo || p.selectedId) return;
    if (lastFit.current === null) {
      lastFit.current = p.fitKey; // initial load keeps the statewide home view
      return;
    }
    if (lastFit.current === p.fitKey) return;
    const t = setTimeout(() => {
      lastFit.current = p.fitKey;
      const m = map.current!;
      const pts = p.projectsGeo!.features.map((f) => (f.geometry as GeoJSON.Point).coordinates);
      // Cleared filters (or no matches): return to the area the reader chose.
      if (!pts.length || p.fitKey === "|") {
        const [w, s, e, n] = p.focus.bbox;
        m.fitBounds([[w, s], [e, n]], { padding: 32, maxZoom: 12.5, duration: 800 });
        return;
      }
      const xs = pts.map((c) => c[0]);
      const ys = pts.map((c) => c[1]);
      m.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 80, maxZoom: 13, duration: 800 });
    }, 450);
    return () => clearTimeout(t);
  }, [ready, p.fitKey, p.projectsGeo, p.selectedId, p.focus.key]); // eslint-disable-line react-hooks/exhaustive-deps -- bbox follows key

  useEffect(() => {
    if (!ready) return;
    const m = map.current!;
    const sel = p.selectedId ?? "";
    m.setFilter("projects-selected", ["all", single, ["==", ["get", "id"], sel]]);
    m.setLayoutProperty("projects-icon", "icon-size", expr(["case", ["==", ["get", "id"], sel], 1.18, 1]));
    m.setPaintProperty("projects-icon", "icon-opacity", sel ? expr(["case", ["==", ["get", "id"], sel], 1, 0.72]) : 1);
    if (!sel) popup.current?.remove();
  }, [ready, p.selectedId]);

  // --- vicinity: site tract, neighbors, nearby schools, reference ring ----------------
  useEffect(() => {
    if (!ready) return;
    const m = map.current!;
    const schools = schoolData.current;
    (m.getSource("schools") as maplibregl.GeoJSONSource).setData(
      site && schools ? { type: "FeatureCollection", features: pointsNear(schools.features, site, VICINITY_KM) } : EMPTY,
    );
    (m.getSource("ring") as maplibregl.GeoJSONSource).setData(site ? { type: "FeatureCollection", features: [circle(site, 1, { units: "kilometers", steps: 96 })] } : EMPTY);
    const siteFilter = expr(["==", ["get", "tract"], vicinity.siteTract ?? -1]);
    m.setFilter("ces-site-casing", siteFilter);
    m.setFilter("ces-site-line", siteFilter);
    siteTractRef.current = vicinity.siteTract;
    cb.current.onTract(vicinity.siteProps);
  }, [ready, siteKey, vicinity]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- baseline extent & emphasis -----------------------------------------------------
  useEffect(() => {
    if (!ready) return;
    const m = map.current!;
    const siteT = vicinity.siteTract ?? -1;
    const near = vicinity.nearTracts;
    const inVicinity = expr(["in", ["get", "tract"], ["literal", [siteT, ...near]]]);
    const filter = p.cesExtent === "region" ? null : inVicinity;
    m.setFilter("ces-fill", filter);
    m.setFilter("ces-line", filter);
    m.setPaintProperty(
      "ces-fill",
      "fill-opacity",
      expr(["case", ["==", ["get", "tract"], siteT], 0.68, ["in", ["get", "tract"], ["literal", near]], 0.42, 0.3]),
    );
  }, [ready, vicinity, p.cesExtent]);

  // --- reported (filing-named) schools ----------------------------------------------------
  const reportedKey = p.selected?.impact_features.filter((f) => f.category === "reported_nearby_school").map((f) => f.id).join(",") ?? "";
  useEffect(() => {
    if (!ready) return;
    const features = (p.selected?.impact_features ?? []).filter((f) => f.category === "reported_nearby_school" && f.geojson).map((f) => f.geojson as GeoJSON.Feature);
    (map.current!.getSource("reported") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features });
  }, [ready, reportedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- deterministic visibility ------------------------------------------------------------
  useEffect(() => {
    if (!ready) return;
    const m = map.current!;
    const plan = layerPlan({ view: p.view, mode: p.mode, layers: p.layers, hasSite: !!site });
    for (const [id, on] of Object.entries(plan)) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    if (!plan["ces-fill"] && popupKind.current === "tract") popup.current?.remove();
  }, [ready, p.view, p.mode, p.layers, siteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ready) return;
    map.current!.setPaintProperty("ces-fill", "fill-color", cesColor(p.indicator));
  }, [ready, p.indicator]);

  // --- camera: one deliberate move per (project, view, extent) change ----------------------
  useEffect(() => {
    if (!ready) return;
    const m = map.current!;
    const key = `${p.selectedId ?? ""}|${p.view}|${p.view === "impacts" ? p.cesExtent : ""}`;
    if (key === cameraKey.current) return;
    const prev = cameraKey.current;
    cameraKey.current = key;
    if (popupKind.current === "tract") popup.current?.remove();
    // The drawer inset is applied as persistent map padding; per-move padding only adds margins.
    const inset = { top: 0, bottom: 0, left: 0, right: p.rightInset };
    const margin = { top: 70, bottom: 40, left: 40, right: 40 };
    if (!site) {
      // Closing a project keeps the reader where they are (statewide, "home" would be a jarring jump).
      if (prev.split("|")[0]) m.easeTo({ padding: inset, duration: 600 });
      return;
    }
    if (p.view === "impacts") {
      const bbox = p.cesExtent === "region" ? STUDY_AREA : vicinity.bbox;
      if (bbox) {
        m.resize(); // the project list collapses on entering Impacts; measure the new canvas first
        m.setPadding(inset);
        m.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: margin, maxZoom: 14.5, duration: 1000 });
      }
      return;
    }
    // Entering a project (or changing project): fly to it; returning from Impacts to the same project: stay put.
    const sameProject = prev.split("|")[0] === p.selectedId;
    m.resize();
    if (!sameProject) m.flyTo({ center: site, zoom: 14, padding: inset, duration: 1100, essential: true });
  }, [ready, p.selectedId, p.view, p.cesExtent, p.rightInset, siteKey, vicinity, cesData]); // eslint-disable-line react-hooks/exhaustive-deps

  // MapLibre sets `position: relative` on its container, so it must be wrapped to fill the parent.
  return (
    <div className="absolute inset-0">
      <div ref={el} className="h-full w-full" role="application" aria-label="Map of tracked developments" />
    </div>
  );
}
