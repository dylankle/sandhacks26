"use client";

import { useState } from "react";
import { Check, Copy, Download, ExternalLink, Landmark, MapPin, X } from "lucide-react";
import type { CesIndicator } from "@/lib/client/gis";
import { PRECISION_LABELS, type Evidence } from "@/lib/client/facts";
import type { MapMode } from "@/components/map/ProjectMap";
import OverviewTab from "@/components/projects/OverviewTab";
import ImpactsTab from "@/components/impacts/ImpactsTab";
import CommunityTab from "@/components/projects/CommunityTab";
import ParticipateTab from "@/components/participation/ParticipateTab";
import { CategoryLabel, CommentBadge, Spinner, StatusBadge } from "@/components/ui";
import type { ProjectDetail } from "@/types/project";

export type Tab = "overview" | "impacts" | "community" | "participate";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "impacts", label: "Impacts" },
  { id: "community", label: "Community" },
  { id: "participate", label: "Participate" },
];

interface Props {
  project: ProjectDetail | null;
  loading: boolean;
  tab: Tab;
  onTab: (t: Tab) => void;
  onClose: () => void;
  mode: MapMode;
  onMode: (m: MapMode) => void;
  tract: Record<string, number> | null;
  indicator: CesIndicator;
  onIndicator: (i: CesIndicator) => void;
  onEvidence: (e: Evidence) => void;
}

/** The official filing this record traces back to: an ID to cite and a link to the government page. */
function SourceLink({ p }: { p: ProjectDetail }) {
  const [copied, setCopied] = useState(false);
  if (!p.source_id && !p.source_url) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(p.source_id ?? p.source_url!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="mt-2.5 flex items-center gap-1.5 text-[12px]">
      <span className="text-ink-3">Source:</span>
      {p.source_url ? (
        <a
          href={p.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1 font-medium text-accent hover:underline"
          title={p.source_url}
        >
          <span className={`truncate ${p.source_id ? "font-mono" : ""}`}>{p.source_id ?? new URL(p.source_url).hostname.replace(/^www\./, "")}</span>
          <ExternalLink className="size-3 shrink-0" />
        </a>
      ) : (
        <span className="font-mono font-medium">{p.source_id}</span>
      )}
      <button
        onClick={copy}
        className="rounded p-1 text-ink-3 hover:bg-black/5 hover:text-ink"
        title={p.source_id ? "Copy record ID" : "Copy source URL"}
        aria-label={p.source_id ? "Copy record ID" : "Copy source URL"}
      >
        {copied ? <Check className="size-3 text-verified" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}

export default function ProjectDrawer(props: Props) {
  const { project: p, loading, tab, onTab, onClose } = props;
  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 flex w-full flex-col border-l border-line bg-panel shadow-[-12px_0_40px_-20px_rgba(0,0,0,0.25)] sm:w-[480px]"
      aria-label="Project details"
    >
      {!p ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-3">{loading ? <Spinner /> : null} Loading record…</div>
      ) : (
        <>
          <header className="border-b border-line px-5 pb-0 pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CategoryLabel category={p.category} />
                <h2 className="mt-0.5 font-serif text-[26px] leading-[1.1] tracking-tight">{p.canonical_name}</h2>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <a
                  href={`/api/projects/${p.id}/export?format=json`}
                  className="rounded-full p-2 text-ink-3 hover:bg-black/5 hover:text-ink"
                  title="Export structured record (JSON)"
                  aria-label="Export structured record as JSON"
                >
                  <Download className="size-4" />
                </a>
                <button onClick={onClose} className="rounded-full p-2 text-ink-3 hover:bg-black/5 hover:text-ink" aria-label="Close details">
                  <X className="size-4" />
                </button>
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <StatusBadge status={p.status} size="md" />
              <CommentBadge status={p.comment_status} />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5 text-ink-3" />
                {p.jurisdiction ?? "—"}
                {p.location_precision === "geocoded_address" && <span className="text-ink-3">· approximate</span>}
              </span>
              {p.lead_agency && (
                <span className="inline-flex items-center gap-1">
                  <Landmark className="size-3.5 text-ink-3" /> {p.lead_agency}
                </span>
              )}
            </div>
            <SourceLink p={p} />
            <nav className="-mb-px mt-4 flex gap-5" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => onTab(t.id)}
                  className={`border-b-2 pb-2.5 text-[14px] font-medium transition ${tab === t.id ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </header>
          <div className="scroll-thin flex-1 overflow-y-auto px-5 py-5" role="tabpanel" key={`${p.id}-${tab}`}>
            <div className="animate-rise">
              {tab === "overview" && <OverviewTab p={p} onEvidence={props.onEvidence} />}
              {tab === "impacts" && (
                <ImpactsTab
                  p={p}
                  mode={props.mode}
                  onMode={props.onMode}
                  tract={props.tract}
                  indicator={props.indicator}
                  onIndicator={props.onIndicator}
                  onEvidence={props.onEvidence}
                />
              )}
              {tab === "community" && <CommunityTab p={p} />}
              {tab === "participate" && <ParticipateTab p={p} />}
            </div>
            <p className="mt-8 border-t border-line pt-3 text-[11px] leading-relaxed text-ink-3">
              {PRECISION_LABELS[p.location_precision]}. Built from official public records retrieved by this site. Verify details with the lead agency before relying on them.
            </p>
          </div>
        </>
      )}
    </aside>
  );
}
