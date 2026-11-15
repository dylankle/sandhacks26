"use client";

import Image from "next/image";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Activity, Download, MapPin, Search, X } from "lucide-react";
import type { Evidence } from "@/lib/client/facts";
import type { CesIndicator } from "@/lib/client/gis";
import { DEFAULT_LAYERS, type CesExtent, type LayerState, type MapMode, type MapView } from "@/lib/client/map-state";
import LayerPanel from "@/components/map/LayerPanel";
import ProjectList from "@/components/projects/ProjectList";
import Landing from "@/components/Landing";
import { placeLabel, type Place } from "@/lib/client/places";
import type { MapViewport } from "@/components/map/ProjectMap";
import { actionTier, inBounds, prioritize, STATUS_FILTERS, type StatusFilter } from "@/lib/participation";
import ProjectDrawer, { type Tab } from "@/components/projects/ProjectDrawer";
import EvidenceDialog from "@/components/EvidenceDialog";
import PipelinePanel from "@/components/PipelinePanel";
import { Spinner } from "@/components/ui";
import { CATEGORY_LABELS, type ProjectCategory, type ProjectDetail, type ProjectSummary } from "@/types/project";

const MapLoading = () => (
  <div className="absolute inset-0 flex items-center justify-center bg-[#eef0ec] text-sm text-ink-3">
    <Spinner className="mr-2 size-4" /> Loading map…
  </div>
);
// WebGL map is client-only: rendered after hydration and code-split, so the static shell never touches it.
const ProjectMap = lazy(() => import("@/components/map/ProjectMap"));
const noop = () => () => {};
/** Sidebar rows rendered at once; the map always shows every match. */
const LIST_LIMIT = 150;
const useIsClient = () => useSyncExternalStore(noop, () => true, () => false);

/** Where the reader chose to look: a Census place/county, or all of California. */
export type Location = { kind: "place"; place: Place } | { kind: "statewide" };
const CA_BBOX: [number, number, number, number] = [-124.5, 32.5, -114.1, 42.0];
const locationKey = (l: Location) => (l.kind === "place" ? l.place.geoid : "ca");

interface ProjectsResponse {
  projects: ProjectSummary[];
  geojson: GeoJSON.FeatureCollection;
}

export default function Explorer() {
  const [data, setData] = useState<ProjectsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [mode, setMode] = useState<MapMode>("existing");
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS);
  const [cesExtent, setCesExtent] = useState<CesExtent>("vicinity");
  const [indicator, setIndicator] = useState<CesIndicator>("CIscoreP");
  const [tract, setTract] = useState<Record<string, number> | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [query, setQuery] = useState("");
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<StatusFilter>>(new Set());
  const [viewport, setViewport] = useState<MapViewport | null>(null);
  const [scope, setScope] = useState<"map" | "all">("map");
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const known = useRef<Map<string, string> | null>(null);
  const isClient = useIsClient();
  const [places, setPlaces] = useState<Place[] | null>(null);
  // undefined: not yet read from the URL (avoids flashing the landing screen on deep links).
  const [location, setLocation] = useState<Location | null | undefined>(undefined);

  // Place index (Census cities, communities, counties → bounding boxes), loaded once.
  useEffect(() => {
    fetch("/gis/ca-places.json")
      .then((r) => r.json())
      .then((d: { places: Place[] }) => setPlaces(d.places))
      .catch(() => setPlaces([]));
  }, []);

  // Restore the chosen location from the URL (?place=<Census GEOID>|ca); a shared project link opens statewide.
  useEffect(() => {
    if (location !== undefined || !places) return;
    const params = new URLSearchParams(window.location.search);
    const key = params.get("place");
    const found = key && key !== "ca" ? places.find((p) => p.geoid === key) : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from the URL
    setLocation(found ? { kind: "place", place: found } : key === "ca" || params.get("project") ? { kind: "statewide" } : null);
  }, [places, location]);

  const chooseLocation = (l: Location | null) => {
    setLocation(l);
    setViewport(null);
    setQuery("");
    const url = new URL(window.location.href);
    if (l) url.searchParams.set("place", locationKey(l));
    else {
      url.searchParams.delete("place");
      url.searchParams.delete("project");
      setSelectedId(null);
      setDetail(null);
      setPipelineOpen(false);
    }
    window.history.replaceState(null, "", url);
  };

  // Poll the knowledge base (cheap DB read, no scraping/AI) so ingestions appear live.
  const loadProjects = useCallback(async () => {
    try {
      const r = await fetch("/api/projects", { cache: "no-store" });
      const d = (await r.json()) as ProjectsResponse & { error?: string };
      if (!r.ok) throw new Error(d.error ?? "Failed to load");
      setLoadError(null);
      const sig = new Map(d.projects.map((p) => [p.id, `${p.document_count}|${p.last_checked_at}|${p.status}`]));
      if (known.current) {
        const changed = d.projects.filter((p) => known.current!.get(p.id) !== sig.get(p.id) && (!known.current!.has(p.id) || known.current!.get(p.id)!.split("|")[0] !== String(p.document_count)));
        if (changed.length) {
          const isNew = changed.filter((p) => !known.current!.has(p.id));
          setFresh(new Set(changed.map((p) => p.id)));
          setToast(isNew.length ? `New record ingested: ${isNew[0].canonical_name}` : `Record updated with new evidence: ${changed[0].canonical_name}`);
          setTimeout(() => setFresh(new Set()), 20_000);
          setTimeout(() => setToast(null), 7000);
        }
      }
      known.current = sig;
      setData(d);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load projects");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch + polling subscription
    loadProjects();
    const t = setInterval(loadProjects, 12_000);
    const id = new URLSearchParams(window.location.search).get("project");
    if (id) setSelectedId(id);
    return () => clearInterval(t);
  }, [loadProjects]);

  // Load detail on selection; refresh when the record's signature changes.
  const sig = data?.projects.find((p) => p.id === selectedId);
  const sigKey = sig ? `${sig.document_count}|${sig.last_checked_at}` : "";
  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    fetch(`/api/projects/${selectedId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setDetail(d));
    const url = new URL(window.location.href);
    url.searchParams.set("project", selectedId);
    window.history.replaceState(null, "", url);
    return () => {
      alive = false;
    };
  }, [selectedId, sigKey]);
  const detailLoading = !!selectedId && detail?.id !== selectedId;
  const shownDetail = detail?.id === selectedId ? detail : null;

  const participate = (id: string) => {
    select(id);
    setTab("participate");
  };
  const select = (id: string) => {
    if (id !== selectedId) {
      setDetail(null);
      setTab("overview");
      setMode("existing");
    }
    setPipelineOpen(false);
    setSelectedId(id);
  };
  const close = () => {
    setSelectedId(null);
    setDetail(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("project");
    window.history.replaceState(null, "", url);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.projects ?? []).filter(
      (p) =>
        (cats.size === 0 || cats.has(p.category ?? "other")) &&
        (statuses.size === 0 || statuses.has(STATUS_FILTERS.find((f) => f.tiers.includes(actionTier(p)))!.id)) &&
        (!q || `${p.canonical_name} ${p.jurisdiction} ${p.lead_agency} ${p.sch_number ?? ""} ${CATEGORY_LABELS[p.category as ProjectCategory] ?? ""}`.toLowerCase().includes(q)),
    );
  }, [data, query, cats, statuses]);

  // Sidebar: the same matches, limited to the map area when scoped, ordered by actionability.
  const scoped = useMemo(() => {
    const inArea = scope === "all" || !viewport ? filtered : filtered.filter((p) => p.latitude !== null && p.longitude !== null && inBounds([p.longitude, p.latitude], viewport.bounds));
    return prioritize(inArea, viewport?.center ?? null);
  }, [filtered, scope, viewport]);
  const unmappedHidden = scope === "map" && viewport ? filtered.filter((p) => p.latitude === null).length : 0;

  const geo = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!data) return null;
    const ids = new Set(filtered.map((p) => p.id));
    return { ...data.geojson, features: data.geojson.features.filter((f) => ids.has(String(f.id))) };
  }, [data, filtered]);

  const categories = [...new Set((data?.projects ?? []).map((p) => p.category ?? "other"))];
  const scopedOpen = scoped.filter((p) => p.comment_status === "open").length;
  const drawerOpen = !!selectedId && !pipelineOpen;

  const onMode = (m: MapMode) => {
    setMode(m);
    if (m === "proposed") setLayers((l) => ({ ...l, reported: true, ring: true }));
  };
  const onTab = (t: Tab) => {
    setTab(t);
    if (t !== "impacts") setMode("existing");
    // Opening Impacts always (re)activates the environmental baseline for the selected site.
    else setLayers((l) => ({ ...l, ces: true }));
  };
  const view: MapView = !drawerOpen ? "explore" : tab === "impacts" ? "impacts" : "project";

  if (location === undefined) return <div className="h-full bg-paper" aria-busy="true" />;
  if (location === null) {
    return <Landing projects={data?.projects ?? null} places={places} onPlace={(p) => chooseLocation({ kind: "place", place: p })} onStatewide={() => chooseLocation({ kind: "statewide" })} />;
  }
  const where = location.kind === "place" ? location.place : null;
  const focus = { key: locationKey(location), bbox: where?.bbox ?? CA_BBOX };

  return (
    <div className="flex h-full flex-col">
      <header className="relative z-30 flex h-14 shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
        <Link
          href="/"
          onClick={(e) => {
            e.preventDefault();
            chooseLocation(null);
          }}
          className="flex items-center gap-2.5"
          aria-label="IMBY home: choose a location"
        >
          <Image src="/imby-logo.png" alt="" width={32} height={32} className="size-8" priority />
          <span className="font-serif text-[21px] tracking-tight">IMBY</span>
        </Link>
        <button
          onClick={() => chooseLocation(null)}
          className="hidden items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[12px] font-medium text-ink-2 transition hover:bg-paper sm:inline-flex"
          title="Choose a different city or county"
        >
          <MapPin className="size-3.5 text-accent" /> {where ? placeLabel(where) : "All of California"} <span className="text-ink-3">· change</span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          <label className="relative hidden items-center md:flex">
            <Search className="pointer-events-none absolute left-2.5 size-4 text-ink-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects, cities, counties, agencies, SCH #"
              className="h-9 w-72 rounded-full border border-line bg-paper pl-8 pr-8 text-[13px] outline-none transition focus:border-ink-3 focus:bg-panel"
              aria-label="Search projects"
            />
            {query && (
              <button onClick={() => setQuery("")} className="absolute right-2 text-ink-3" aria-label="Clear search">
                <X className="size-3.5" />
              </button>
            )}
          </label>
          <a href="/api/export" className="hidden h-9 items-center gap-1.5 rounded-full border border-line px-3 text-[13px] font-medium text-ink-2 hover:bg-paper sm:inline-flex" title="Download all records as GeoJSON">
            <Download className="size-4" /> GeoJSON
          </a>
          <button
            onClick={() => setPipelineOpen((o) => !o)}
            className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition ${pipelineOpen ? "bg-ink text-white" : "border border-line text-ink-2 hover:bg-paper"}`}
          >
            <Activity className="size-4" /> Pipeline
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <aside className={`scroll-thin z-10 hidden w-[340px] shrink-0 flex-col overflow-y-auto border-r border-line bg-paper ${view === "impacts" ? "" : "md:flex"}`}>
          <div className="px-4 pb-3 pt-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">{where ? "Developments near" : "Developments across"}</p>
            <div className="mt-0.5 flex items-baseline justify-between gap-2">
              <h1 className="truncate font-serif text-[26px] leading-tight tracking-tight">{where ? where.name : "California"}</h1>
              <button onClick={() => chooseLocation(null)} className="shrink-0 text-[12px] font-medium text-ink-3 underline decoration-line-2 underline-offset-2 hover:text-ink">
                Change
              </button>
            </div>
            {data && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
                <span>
                  <b className="text-[15px]">{scoped.length.toLocaleString()}</b> <span className="text-ink-3">in this map area</span>
                </span>
                {scopedOpen > 0 && (
                  <span className="text-open">
                    <b className="text-[15px]">{scopedOpen}</b> open for comment
                  </span>
                )}
                <span className="text-ink-3">{data.projects.length.toLocaleString()} statewide</span>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by procedural status">
              {STATUS_FILTERS.map((f) => {
                const on = statuses.has(f.id);
                return (
                  <button
                    key={f.id}
                    onClick={() =>
                      setStatuses((s) => {
                        const n = new Set(s);
                        if (on) n.delete(f.id);
                        else n.add(f.id);
                        return n;
                      })
                    }
                    aria-pressed={on}
                    className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${on ? (f.id === "action" ? "bg-open text-white" : "bg-ink text-white") : "border border-line text-ink-2 hover:bg-black/[0.04]"}`}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
            {categories.length > 1 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
                {categories.map((c) => {
                  const on = cats.has(c);
                  return (
                    <button
                      key={c}
                      onClick={() => setCats((s) => {
                        const n = new Set(s);
                        if (on) n.delete(c);
                        else n.add(c);
                        return n;
                      })}
                      aria-pressed={on}
                      className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${on ? "bg-ink text-white" : "bg-black/[0.05] text-ink-2 hover:bg-black/10"}`}
                    >
                      {CATEGORY_LABELS[c as ProjectCategory] ?? c}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex-1 px-3 pb-4">
            {loadError && <p className="rounded-lg bg-red-50 p-3 text-[13px] text-red-800">Couldn&apos;t load projects: {loadError}</p>}
            {!data && !loadError && (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-[118px] animate-pulse rounded-xl bg-black/[0.04]" />
                ))}
              </div>
            )}
            {data && (
              <div className="mb-3 flex items-center justify-between gap-2 px-1">
                <div role="radiogroup" aria-label="Sidebar area" className="flex rounded-full bg-black/[0.05] p-0.5 text-[12px] font-medium">
                  {(
                    [
                      ["map", "In map area"],
                      ["all", "All matches"],
                    ] as const
                  ).map(([v, l]) => (
                    <button key={v} role="radio" aria-checked={scope === v} onClick={() => setScope(v)} className={`rounded-full px-2.5 py-1 transition ${scope === v ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}>
                      {l}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-ink-3">{scoped.length.toLocaleString()} projects</span>
              </div>
            )}
            {data && filtered.length === 0 && <p className="px-1 text-[13px] text-ink-3">No projects match your filters.</p>}
            {data && filtered.length > 0 && (
              <ProjectList projects={scoped} selectedId={selectedId} onSelect={select} onParticipate={participate} freshIds={fresh} limit={LIST_LIMIT} />
            )}
            {unmappedHidden > 0 && (
              <p className="mt-3 px-1 text-[12px] text-ink-3">
                {unmappedHidden} matching project{unmappedHidden === 1 ? " has" : "s have"} no verified map location and {unmappedHidden === 1 ? "is" : "are"} not in any map area.{" "}
                <button onClick={() => setScope("all")} className="font-medium text-ink underline underline-offset-2">
                  Show all matches
                </button>
              </p>
            )}
          </div>
          <p className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-ink-3">
            Sources: CEQAnet (State Clearinghouse) statewide filings, agency and city meeting records, OEHHA CalEnviroScreen 4.0, CDE school locations, U.S. Census county boundaries. Basic records come from structured State Clearinghouse fields. Enriched records add Gemini extraction, with each claim checked against the source text. Projects whose location is ambiguous are listed but not mapped.
          </p>
        </aside>

        <main className="relative flex-1">
          <Suspense fallback={<MapLoading />}>
          {isClient ? <ProjectMap
            projectsGeo={geo}
            focus={focus}
            fitKey={`${query.trim().toLowerCase()}|${[...cats].sort().join(",")}`}
            selected={shownDetail}
            selectedId={selectedId}
            view={view}
            mode={view === "impacts" ? mode : "existing"}
            layers={layers}
            cesExtent={cesExtent}
            indicator={indicator}
            rightInset={drawerOpen ? 480 : 0}
            onSelect={select}
            onView={setViewport}
            onEvidence={setEvidence}
            onTract={setTract}
          /> : <MapLoading />}
          </Suspense>
          <div className={`pointer-events-none absolute bottom-4 left-4 z-10 transition-all ${drawerOpen ? "sm:right-[496px]" : ""}`}>
            <div className="pointer-events-auto w-fit">
              <LayerPanel
                key={view}
                defaultOpen={view !== "project"}
                view={view}
                mode={mode}
                layers={layers}
                onLayers={setLayers}
                indicator={indicator}
                onIndicator={setIndicator}
                cesExtent={cesExtent}
                onCesExtent={setCesExtent}
                categories={categories}
              />
            </div>
          </div>
          {drawerOpen && tab === "impacts" && (
            <div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 sm:left-[calc((100%-480px)/2)]">
              <div className="rounded-full border border-line bg-panel/95 p-1 shadow-lg backdrop-blur">
                <div role="radiogroup" aria-label="Map view" className="flex text-[13px] font-medium">
                  {(["existing", "proposed"] as MapMode[]).map((m) => (
                    <button
                      key={m}
                      role="radio"
                      aria-checked={mode === m}
                      onClick={() => onMode(m)}
                      className={`rounded-full px-4 py-1.5 capitalize transition ${mode === m ? "bg-ink text-white" : "text-ink-3 hover:text-ink"}`}
                    >
                      {m} conditions
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {drawerOpen && (
            <ProjectDrawer
              project={shownDetail}
              loading={detailLoading}
              tab={tab}
              onTab={onTab}
              onClose={close}
              mode={mode}
              onMode={onMode}
              tract={tract}
              indicator={indicator}
              onIndicator={setIndicator}
              onEvidence={setEvidence}
            />
          )}
          {pipelineOpen && <PipelinePanel onClose={() => setPipelineOpen(false)} onOpenProject={select} />}
          {toast && (
            <div role="status" className="animate-rise absolute left-1/2 top-4 z-40 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-white shadow-xl">
              <span className="mr-2 inline-block size-2 rounded-full bg-open" />
              {toast}
            </div>
          )}
        </main>
      </div>
      <EvidenceDialog evidence={evidence} onClose={() => setEvidence(null)} />
    </div>
  );
}
