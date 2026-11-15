"use client";

import { ArrowRight, CalendarClock, FileText, Gavel, MapPinOff } from "lucide-react";
import { fmtDate } from "@/lib/client/facts";
import { TIER_LABELS, actionTier, daysUntilPacific, formatDay, formatPacific } from "@/lib/participation";
import { CategoryLabel, CommentBadge, StatusBadge } from "@/components/ui";
import { CategoryBadge } from "@/components/map/LayerPanel";
import type { ProjectSummary } from "@/types/project";

interface Props {
  /** Already filtered to the geographic scope and ordered by `prioritize`. */
  projects: ProjectSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onParticipate: (id: string) => void;
  freshIds: Set<string>;
  limit: number;
}

function daysText(n: number) {
  return n <= 0 ? "closes today" : n === 1 ? "1 day left" : `${n} days left`;
}

/** The verified participation opportunity that puts a project in "Action available". */
function ActionLine({ p }: { p: ProjectSummary }) {
  if (p.comment_status === "open" && p.comment_deadline) {
    const n = daysUntilPacific(p.comment_deadline);
    return (
      <div className="mt-2 rounded-lg bg-open/[0.07] px-2.5 py-2 ring-1 ring-open/20">
        <p className="flex items-center gap-1.5 text-[12px] font-semibold text-open">
          <CalendarClock className="size-3.5" /> Comments due {formatPacific(p.comment_deadline)}
        </p>
        <p className="mt-0.5 pl-5 text-[11px] font-medium text-open/90">{daysText(n)} · verified deadline</p>
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-1 rounded-lg bg-accent/[0.07] px-2.5 py-2 ring-1 ring-accent/20">
      {p.comment_status === "upcoming" && p.comment_opens && (
        <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
          <CalendarClock className="size-3.5 text-accent" /> Comment period opens {formatDay(p.comment_opens)}
        </p>
      )}
      {p.next_hearing && (
        <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
          <Gavel className="size-3.5 text-accent" /> Public hearing {formatDay(p.next_hearing)}
        </p>
      )}
    </div>
  );
}

function Card({ p, sel, fresh, actionable, onSelect, onParticipate }: { p: ProjectSummary; sel: boolean; fresh: boolean; actionable: boolean; onSelect: () => void; onParticipate: () => void }) {
  return (
    <li>
      <div
        className={`rounded-xl border transition ${sel ? "border-ink/70 bg-panel shadow-sm" : actionable ? "border-open/25 bg-panel hover:border-open/45" : "border-line bg-panel/70 hover:border-line-2 hover:bg-panel"} ${fresh ? "ring-2 ring-open/50" : ""}`}
      >
        <button onClick={onSelect} aria-current={sel} className="w-full p-3 pb-2 text-left">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <CategoryBadge category={p.category ?? "other"} size={18} />
              <CategoryLabel category={p.category} />
            </span>
            {fresh && <span className="rounded-full bg-open px-1.5 py-0.5 text-[10px] font-semibold text-white">New</span>}
          </div>
          <p className="mt-0.5 font-serif text-[17px] leading-snug">{p.canonical_name}</p>
          <p className="mt-0.5 text-[12px] text-ink-3">
            {p.jurisdiction ?? "Location not stated"} · {p.lead_agency ?? "Agency not stated"}
          </p>
          {actionable && <ActionLine p={p} />}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={p.status} />
            {!actionable && <CommentBadge status={p.comment_status} />}
            {p.index_level === "lightweight" && (
              <span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-medium text-ink-2" title="Structured State Clearinghouse fields only; not yet enriched with document evidence">
                Basic record
              </span>
            )}
            {p.latitude === null && (
              <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-2 px-2 py-0.5 text-[11px] text-ink-3" title="Location ambiguous or unverified, so no map marker">
                <MapPinOff className="size-3" /> Not mapped
              </span>
            )}
          </div>
        </button>
        <div className="flex items-center justify-between gap-2 px-3 pb-2.5 text-[11px] text-ink-3">
          <span className="inline-flex items-center gap-1">
            <FileText className="size-3" /> {p.document_count} source documents · checked {fmtDate(p.last_checked_at, { month: "short", day: "numeric" })}
          </span>
          {actionable && (
            <button onClick={onParticipate} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ink px-2.5 py-1 font-medium text-white hover:bg-ink/85">
              How to participate <ArrowRight className="size-3" />
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export default function ProjectList({ projects, selectedId, onSelect, onParticipate, freshIds, limit }: Props) {
  const action = projects.filter((p) => actionTier(p) <= 2);
  const rest = projects.filter((p) => actionTier(p) > 2);
  const shownRest = rest.slice(0, Math.max(0, limit - action.length));
  const card = (p: ProjectSummary, actionable: boolean) => (
    <Card key={p.id} p={p} sel={p.id === selectedId} fresh={freshIds.has(p.id)} actionable={actionable} onSelect={() => onSelect(p.id)} onParticipate={() => onParticipate(p.id)} />
  );
  const groups = ([3, 4, 5] as const).map((t) => ({ t, items: shownRest.filter((p) => actionTier(p) === t) })).filter((g) => g.items.length);
  return (
    <div className="space-y-5">
      <section aria-labelledby="action-available">
        <h2 id="action-available" className="mb-2 flex items-baseline justify-between px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-open">
          Action available <span className="font-mono text-[11px] font-medium normal-case tracking-normal text-ink-3">{action.length}</span>
        </h2>
        {action.length ? (
          <ul className="space-y-2">{action.map((p) => card(p, true))}</ul>
        ) : (
          <p className="rounded-xl border border-dashed border-line-2 px-3 py-2.5 text-[12px] leading-snug text-ink-3">
            No verified open comment period or upcoming hearing in this area. Opportunities appear here only when an official record states the date.
          </p>
        )}
      </section>
      {rest.length > 0 && (
        <section aria-labelledby="other-projects">
          <h2 id="other-projects" className="mb-2 flex items-baseline justify-between px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-3">
            Other projects in this area <span className="font-mono text-[11px] font-medium normal-case tracking-normal">{rest.length}</span>
          </h2>
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.t}>
                <p className="mb-1.5 px-1 text-[11px] font-medium text-ink-3">
                  {TIER_LABELS[g.t]} · {g.items.length}
                </p>
                <ul className="space-y-2">{g.items.map((p) => card(p, false))}</ul>
              </div>
            ))}
          </div>
          {rest.length > shownRest.length && (
            <p className="mt-3 px-1 text-[12px] text-ink-3">
              Showing {shownRest.length} of {rest.length.toLocaleString()} other projects. Zoom the map or search to narrow the area; the map shows every match.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
