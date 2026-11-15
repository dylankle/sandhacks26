"use client";

import { useEffect, useMemo, useState } from "react";
import { distance, point } from "@turf/turf";
import { Info, MapPin, School } from "lucide-react";
import { PRECISION_LABELS, evidenceFromFact, factValue, metrics, topicOfField, type Evidence } from "@/lib/client/facts";
import { CES_INDICATORS, CES_RAMP, DATASETS, formatRaw, type CesIndicator } from "@/lib/client/gis";
import type { MapMode } from "@/components/map/ProjectMap";
import { MetricCard } from "@/components/projects/OverviewTab";
import { Empty, SectionTitle } from "@/components/ui";
import { TOPIC_LABELS, type ProjectDetail, type Topic } from "@/types/project";

type SchoolFC = GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, string | number>>;
let schoolsPromise: Promise<SchoolFC> | null = null;
const loadSchools = () => (schoolsPromise ??= fetch("/gis/schools.geojson").then((r) => r.json()));

function rampColor(v: number) {
  let c = CES_RAMP[0][1];
  for (const [stop, color] of CES_RAMP) if (v >= stop) c = color;
  return c;
}

export function ModeToggle({ mode, onMode }: { mode: MapMode; onMode: (m: MapMode) => void }) {
  return (
    <div role="radiogroup" aria-label="Existing or proposed conditions" className="inline-flex rounded-full bg-black/[0.05] p-1 text-[13px] font-medium">
      {(["existing", "proposed"] as MapMode[]).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          onClick={() => onMode(m)}
          className={`rounded-full px-4 py-1.5 capitalize transition ${mode === m ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

export default function ImpactsTab({
  p,
  mode,
  onMode,
  tract,
  indicator,
  onIndicator,
  onEvidence,
}: {
  p: ProjectDetail;
  mode: MapMode;
  onMode: (m: MapMode) => void;
  tract: Record<string, number> | null;
  indicator: CesIndicator;
  onIndicator: (i: CesIndicator) => void;
  onEvidence: (e: Evidence) => void;
}) {
  const [schools, setSchools] = useState<SchoolFC | null>(null);
  useEffect(() => {
    loadSchools().then(setSchools);
  }, []);

  const nearby = useMemo(() => {
    if (!schools || p.latitude === null || p.longitude === null) return null;
    const o = point([p.longitude, p.latitude]);
    const withD = schools.features.map((f) => ({ f, km: distance(o, f, { units: "kilometers" }) })).sort((a, b) => a.km - b.km);
    return { within1: withD.filter((x) => x.km <= 1), within2: withD.filter((x) => x.km <= 2), nearest: withD[0] };
  }, [schools, p.latitude, p.longitude]);

  const reported = p.impact_features.filter((f) => f.category === "reported_nearby_school");
  const site = p.impact_features.find((f) => f.category === "project_site");
  const siteDoc = site ? p.documents.find((d) => d.id === site.source_document_id) ?? null : null;
  const m = metrics(p);
  const byTopic = m.reduce<Record<string, typeof m>>((acc, f) => {
    const t = topicOfField(f.field) ?? "other";
    (acc[t] ??= []).push(f);
    return acc;
  }, {});
  const landUse = factValue(p, "identity.present_land_use");

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <ModeToggle mode={mode} onMode={onMode} />
        <p className="text-[13px] leading-snug text-ink-2">
          {mode === "existing"
            ? "Published conditions around the site today, from state datasets. These describe the neighborhood, not the project's effects."
            : "What the project's own records report: the site location, schools named in the filing, and reported figures."}
        </p>
      </div>

      {mode === "existing" ? (
        <>
          <section>
            <SectionTitle aside={<span className="text-[11px] text-ink-3">OEHHA · 2021</span>}>Census tract around the site</SectionTitle>
            {tract ? (
              <div className="rounded-xl border border-line p-3">
                <p className="mb-2 font-mono text-[12px] text-ink-3">Tract {tract.tract} · population {tract.ACS2019TotalPop?.toLocaleString()}</p>
                <ul className="space-y-2">
                  {(Object.keys(CES_INDICATORS) as CesIndicator[]).map((k) => {
                    const v = Number(tract[k]);
                    const has = Number.isFinite(v) && v >= 0;
                    return (
                      <li key={k}>
                        <button
                          onClick={() => {
                            onIndicator(k);
                            onEvidence({
                              title: CES_INDICATORS[k].label,
                              value: has ? `${v.toFixed(0)}th percentile statewide` : "No data",
                              unit: `· ${formatRaw(k, tract)} · tract ${tract.tract}`,
                              reviewStatus: "dataset",
                              method: "dataset",
                              quote: null,
                              page: null,
                              context: CES_INDICATORS[k].description,
                              document: null,
                              dataset: { name: DATASETS.ces.name, publisher: DATASETS.ces.publisher, url: DATASETS.ces.url },
                              limitations: [...DATASETS.ces.limitations],
                            });
                          }}
                          className={`w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-paper ${indicator === k ? "bg-paper ring-1 ring-line-2" : ""}`}
                        >
                          <div className="flex items-baseline justify-between text-[13px]">
                            <span>
                              {CES_INDICATORS[k].short}
                              <span className="ml-1.5 font-mono text-[11px] text-ink-3">{formatRaw(k, tract)}</span>
                            </span>
                            <span className="font-mono text-[12px] font-medium">{has ? `${v.toFixed(0)}th` : "n/a"}</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/[0.06]">
                            <div className="h-full rounded-full" style={{ width: `${has ? v : 0}%`, background: has ? rampColor(v) : "transparent" }} />
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 flex gap-1.5 text-[12px] leading-snug text-ink-3">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  Statewide percentiles describing existing burden. They are not caused by, and do not predict effects of, this proposal. Tap a row to shade the map by that indicator.
                </p>
              </div>
            ) : (
              <Empty>Site is outside the loaded CalEnviroScreen study area.</Empty>
            )}
          </section>

          <section>
            <SectionTitle aside={<span className="text-[11px] text-ink-3">CDE · 2025-26</span>}>Public schools nearby</SectionTitle>
            {nearby ? (
              <div className="grid grid-cols-3 gap-2 text-center">
                <Stat value={nearby.within1.length} label="within 1 km" />
                <Stat value={nearby.within2.length} label="within 2 km" />
                <Stat value={nearby.nearest ? `${nearby.nearest.km.toFixed(1)} km` : "—"} label="to nearest" />
              </div>
            ) : (
              <Empty>Loading school locations…</Empty>
            )}
            {nearby?.within1.length ? (
              <ul className="mt-2 space-y-1">
                {nearby.within1.map(({ f, km }) => (
                  <li key={String(f.properties.CDSCode)} className="flex items-center justify-between rounded-md px-2 py-1 text-[13px] hover:bg-paper">
                    <span className="flex items-center gap-2">
                      <School className="size-3.5 text-[#24517a]" />
                      {f.properties.SchoolName}
                    </span>
                    <span className="font-mono text-[12px] text-ink-3">{km.toFixed(2)} km</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-2 text-[12px] text-ink-3">Straight-line distance from the reported site point. Proximity is a geographic relationship, not a measure of exposure.</p>
          </section>

          {landUse && (
            <section>
              <SectionTitle>Present land use (filing)</SectionTitle>
              <p className="text-[14px] text-ink-2">{landUse}</p>
            </section>
          )}
        </>
      ) : (
        <>
          <section>
            <SectionTitle>Documented site</SectionTitle>
            <button
              onClick={() => {
                const f = p.facts.find((x) => x.field === "location.coordinates");
                if (f) onEvidence({ ...evidenceFromFact(f, p.documents, "Site location"), limitations: [site?.spatial_meaning ?? "", "No parcel footprint or impact boundary is drawn because none was published in the retrieved records."].filter(Boolean) });
              }}
              className="flex w-full items-start gap-3 rounded-xl border border-line p-3 text-left hover:bg-paper/50"
            >
              <MapPin className="mt-0.5 size-4 shrink-0 text-accent" />
              <div>
                <p className="text-[14px] font-medium">{PRECISION_LABELS[p.location_precision]}</p>
                <p className="text-[12px] text-ink-3">
                  {site?.spatial_meaning}
                  {siteDoc ? ` Source: ${siteDoc.title}.` : ""}
                </p>
              </div>
            </button>
          </section>

          <section>
            <SectionTitle>Schools named in the filing</SectionTitle>
            {reported.length ? (
              <ul className="space-y-1.5">
                {reported.map((r) => {
                  const g = r.geojson as GeoJSON.Feature<GeoJSON.Point, Record<string, string | number>>;
                  const doc = p.documents.find((d) => d.id === r.source_document_id) ?? null;
                  return (
                    <li key={r.id}>
                      <button
                        onClick={() =>
                          onEvidence({
                            title: String(g.properties.SchoolName),
                            value: `${g.properties.km_from_site} km from site`,
                            unit: null,
                            reviewStatus: "validated",
                            method: "parsed",
                            quote: `Schools: … ${g.properties.listed_as} …`,
                            page: null,
                            context: `${g.properties.Street}, ${g.properties.City} · ${g.properties.DistrictName}`,
                            document: doc,
                            dataset: { name: DATASETS.schools.name, publisher: DATASETS.schools.publisher, url: DATASETS.schools.url },
                            limitations: [r.spatial_meaning ?? "", ...DATASETS.schools.limitations].filter(Boolean),
                          })
                        }
                        className="flex w-full items-center justify-between rounded-lg border border-accent/20 bg-accent/[0.04] px-3 py-2 text-left text-[13px] hover:bg-accent/[0.08]"
                      >
                        <span>
                          <span className="font-medium">{g.properties.SchoolName}</span>
                          <span className="block text-[11px] text-ink-3">listed as “{g.properties.listed_as}”</span>
                        </span>
                        <span className="font-mono text-[12px] text-accent">{g.properties.km_from_site} km</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty>The retrieved records don&apos;t name specific schools.</Empty>
            )}
          </section>

          <section>
            <SectionTitle>Reported project figures</SectionTitle>
            {m.length ? (
              <div className="space-y-3">
                {Object.entries(byTopic).map(([t, fs]) => (
                  <div key={t}>
                    <p className="mb-1.5 text-[12px] font-medium text-ink-2">{TOPIC_LABELS[t as Topic]}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {fs.map((f) => (
                        <MetricCard key={f.id} f={f} p={p} onEvidence={onEvidence} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>No quantitative figures reported.</Empty>
            )}
            <p className="mt-3 flex gap-1.5 text-[12px] leading-snug text-ink-3">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              Figures are as stated in the project&apos;s documents. This site does not model emissions, dispersion, or exposure; the dashed ring on the map is a 1 km reference distance only.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="rounded-xl border border-line px-2 py-2.5">
      <p className="text-xl font-semibold tracking-tight">{value}</p>
      <p className="text-[11px] text-ink-3">{label}</p>
    </div>
  );
}
