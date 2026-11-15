"use client";

import { useState } from "react";
import { Building2, ChevronDown, Factory, GraduationCap, Layers, Route, Server, Warehouse, Zap, type LucideIcon } from "lucide-react";
import { CATEGORY_STYLES, CES_INDICATORS, CES_RAMP, DATASETS, SCHOOL_COLOR, STATUS_COLORS, VICINITY_KM, type CesIndicator } from "@/lib/client/gis";
import type { CesExtent, LayerState, MapMode, MapView } from "@/lib/client/map-state";
import { CATEGORY_LABELS, STATUS_LABELS, type ProjectCategory, type ProjectStatus } from "@/types/project";

const ICONS: Record<string, LucideIcon> = { server: Server, zap: Zap, factory: Factory, warehouse: Warehouse, route: Route, building: Building2 };
const LEGEND_STATUSES: ProjectStatus[] = ["proposed", "under_review", "approved", "unknown"];

export function CategoryBadge({ category, size = 22 }: { category: string; size?: number }) {
  const s = CATEGORY_STYLES[category] ?? CATEGORY_STYLES.other;
  const Icon = ICONS[s.icon];
  return (
    <span className="grid shrink-0 place-items-center rounded-full ring-2 ring-white" style={{ width: size, height: size, background: s.color }}>
      <Icon className="text-white" style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2.4} />
    </span>
  );
}

interface Props {
  view: MapView;
  mode: MapMode;
  layers: LayerState;
  onLayers: (l: LayerState) => void;
  indicator: CesIndicator;
  onIndicator: (i: CesIndicator) => void;
  cesExtent: CesExtent;
  onCesExtent: (e: CesExtent) => void;
  categories: string[];
  defaultOpen?: boolean;
}

export default function LayerPanel(p: Props) {
  const [open, setOpen] = useState(p.defaultOpen ?? true);
  const toggle = (k: keyof LayerState) => p.onLayers({ ...p.layers, [k]: !p.layers[k] });
  const impacts = p.view === "impacts";
  const proposed = impacts && p.mode === "proposed";

  return (
    <div className="w-[284px] overflow-hidden rounded-2xl border border-line bg-panel/95 shadow-lg backdrop-blur">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3.5 py-2.5 text-[13px] font-semibold" aria-expanded={open}>
        <span className="flex items-center gap-2">
          <Layers className="size-4" /> {impacts ? "Map layers · Impacts" : "Map legend"}
        </span>
        <ChevronDown className={`size-4 text-ink-3 transition ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && (
        <div className="scroll-thin max-h-[calc(100vh-200px)] space-y-3.5 overflow-y-auto border-t border-line px-3.5 pb-3.5 pt-3 text-[13px]">
          <div>
            <p className="font-medium leading-tight">Developments</p>
            <p className="text-[11px] text-ink-3">From official records · always shown</p>
            {!impacts && (
            <>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              {p.categories.map((c) => (
                <span key={c} className="inline-flex items-center gap-1.5 text-[11px] text-ink-2">
                  <CategoryBadge category={c} size={18} /> {CATEGORY_LABELS[c as ProjectCategory] ?? c}
                </span>
              ))}
            </div>
            <p className="mb-1 mt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Review status (corner dot)</p>
            <div className="flex flex-wrap gap-x-2.5 gap-y-1">
              {LEGEND_STATUSES.map((s) => (
                <span key={s} className="inline-flex items-center gap-1 text-[11px] text-ink-2">
                  <span className="size-2.5 rounded-full ring-[1.5px] ring-white" style={{ background: STATUS_COLORS[s] }} /> {STATUS_LABELS[s]}
                </span>
              ))}
              <span className="inline-flex items-center gap-1 text-[11px] text-ink-2">
                <span className="size-3 rounded-full border-[1.5px] border-open bg-open/10" /> Comments open
              </span>
            </div>
            </>
            )}
          </div>

          {!impacts ? (
            <p className="rounded-lg bg-paper px-2.5 py-2 text-[12px] leading-snug text-ink-3">
              Select a project and open its <span className="font-medium text-ink-2">Impacts</span> tab to see environmental baseline data and nearby schools.
            </p>
          ) : (
            <>
              <Toggle on={p.layers.ces} onClick={() => toggle("ces")} label="Environmental baseline" hint={`${DATASETS.ces.name} · OEHHA · census tracts`}>
                <label className="mt-1.5 block text-[11px] text-ink-3">
                  Indicator
                  <select
                    value={p.indicator}
                    onChange={(e) => p.onIndicator(e.target.value as CesIndicator)}
                    className="mt-0.5 w-full rounded-md border border-line bg-panel px-1.5 py-1 text-[12px] text-ink"
                    aria-label="CalEnviroScreen indicator"
                  >
                    {(Object.keys(CES_INDICATORS) as CesIndicator[]).map((k) => (
                      <option key={k} value={k}>
                        {CES_INDICATORS[k].label}
                      </option>
                    ))}
                  </select>
                </label>
                <div role="radiogroup" aria-label="Baseline extent" className="mt-2 grid grid-cols-2 rounded-md bg-black/[0.05] p-0.5 text-[11px] font-medium">
                  {(
                    [
                      ["vicinity", `Near site (${VICINITY_KM} km)`],
                      ["region", "Full region"],
                    ] as [CesExtent, string][]
                  ).map(([v, l]) => (
                    <button
                      key={v}
                      role="radio"
                      aria-checked={p.cesExtent === v}
                      onClick={() => p.onCesExtent(v)}
                      className={`rounded px-1.5 py-1 transition ${p.cesExtent === v ? "bg-panel text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <div className="mt-2">
                  <div className="flex h-2.5 overflow-hidden rounded-sm">
                    {CES_RAMP.map(([stop, c], i) => (
                      <span key={stop} style={{ background: c, flex: (CES_RAMP[i + 1]?.[0] ?? 100) - stop }} />
                    ))}
                  </div>
                  <div className="relative mt-0.5 h-3 font-mono text-[9px] text-ink-3">
                    {[0, 20, 40, 60, 80, 100].map((v) => (
                      <span key={v} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full" style={{ left: `${v}%` }}>
                        {v}
                      </span>
                    ))}
                  </div>
                  <p className="mt-0.5 text-[10px] text-ink-3">Statewide percentile of {CES_INDICATORS[p.indicator].short.toLowerCase()} (higher = more burdened)</p>
                  <div className="mt-1.5 space-y-1 text-[11px] text-ink-2">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-4 rounded-[2px] border-2 border-ink bg-[#d68f5e]" /> Tract containing the site
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2.5 w-4 rounded-[2px] border border-[#8d7a5e] bg-[#d68f5e]/50" /> Neighboring tracts (lighter)
                    </span>
                  </div>
                  <p className="mt-1.5 text-[10px] leading-snug text-ink-3">Existing conditions (2015–2019 data). Not the project&apos;s footprint or emissions. Click a tract for values.</p>
                </div>
              </Toggle>

              <Toggle on={p.layers.schools} onClick={() => toggle("schools")} label="Public schools" hint={`CDE 2025-26 · within ${VICINITY_KM} km of site`}>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-2">
                  <span className="inline-flex items-center gap-1">
                    <span className="grid size-4 place-items-center rounded-full ring-[1.5px] ring-white" style={{ background: SCHOOL_COLOR }}>
                      <GraduationCap className="size-2.5 text-white" />
                    </span>
                    School site
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="grid size-4 place-items-center rounded-full border border-[#24517a] bg-[#e8eef4] font-mono text-[8px] text-[#24517a]">5</span>
                    Cluster (zoom in)
                  </span>
                </div>
              </Toggle>

              {proposed ? (
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Project records</p>
                  <Toggle on={p.layers.reported} onClick={() => toggle("reported")} label="Schools named in filing" hint="From the CEQAnet “Schools” field" />
                  <div className="h-2" />
                  <Toggle on={p.layers.ring} onClick={() => toggle("ring")} label="1 km reference ring" hint="Distance guide, not an impact zone" />
                </div>
              ) : (
                <p className="text-[11px] leading-snug text-ink-3">Switch to Proposed to overlay the project&apos;s documented site features.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Toggle({
  on,
  onClick,
  label,
  hint,
  children,
  disabled,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  children?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div>
      <button onClick={onClick} disabled={disabled} role="switch" aria-checked={on} className="flex w-full items-start gap-2.5 text-left disabled:cursor-not-allowed">
        <span className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition ${on ? "bg-ink" : "bg-black/15"}`}>
          <span className={`size-3 rounded-full bg-white shadow transition ${on ? "translate-x-3" : ""}`} />
        </span>
        <span>
          <span className="block font-medium leading-tight">{label}</span>
          <span className="block text-[11px] text-ink-3">{hint}</span>
        </span>
      </button>
      {on && children && <div className="pl-[38px]">{children}</div>}
    </div>
  );
}
