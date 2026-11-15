"use client";

import type { ReactNode } from "react";
import { BadgeCheck, CircleDashed, Cpu, Database, Sparkles } from "lucide-react";
import { STATUS_COLORS } from "@/lib/client/gis";
import { CATEGORY_LABELS, STATUS_LABELS, type ProjectCategory, type ProjectStatus } from "@/types/project";

export function StatusBadge({ status, size = "sm" }: { status: string; size?: "sm" | "md" }) {
  const color = STATUS_COLORS[status] ?? STATUS_COLORS.unknown;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]"}`}
      style={{ color, background: `${color}14`, boxShadow: `inset 0 0 0 1px ${color}33` }}
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {STATUS_LABELS[status as ProjectStatus] ?? status}
    </span>
  );
}

export function CategoryLabel({ category }: { category: string | null }) {
  return <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{CATEGORY_LABELS[category as ProjectCategory] ?? "Development"}</span>;
}

export function CommentBadge({ status }: { status: string }) {
  if (status === "open")
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-open/10 px-2 py-0.5 text-[11px] font-semibold text-open ring-1 ring-open/25">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full rounded-full bg-open" style={{ animation: "pulse-ring 1.6s ease-out infinite" }} />
          <span className="relative inline-flex size-1.5 rounded-full bg-open" />
        </span>
        Comments open
      </span>
    );
  if (status === "closed") return <span className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] text-ink-3">Comment period closed</span>;
  return null;
}

/** Signals how much to trust a value: verified quote, parsed record, dataset, AI, or unverified. */
export function ReviewBadge({ status, method }: { status: string; method?: string | null }) {
  if (method === "dataset")
    return (
      <Pill className="text-[#24517a] bg-[#24517a]/8 ring-[#24517a]/20">
        <Database className="size-3" /> Public dataset
      </Pill>
    );
  if (status !== "validated")
    return (
      <Pill className="text-unverified bg-unverified/8 ring-unverified/25">
        <CircleDashed className="size-3" /> Unverified extraction
      </Pill>
    );
  if (method === "parsed")
    return (
      <Pill className="text-verified bg-verified/8 ring-verified/20">
        <Database className="size-3" /> From official record
      </Pill>
    );
  if (method === "derived")
    return (
      <Pill className="text-verified bg-verified/8 ring-verified/20">
        <Cpu className="size-3" /> Derived from source
      </Pill>
    );
  return (
    <Pill className="text-verified bg-verified/8 ring-verified/20">
      <BadgeCheck className="size-3" /> Quote verified
    </Pill>
  );
}

export function AiLabel({ children = "AI explanation" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ai">
      <Sparkles className="size-3" /> {children}
    </span>
  );
}

export function Pill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${className}`}>{children}</span>;
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">{children}</h3>
      {aside}
    </div>
  );
}

export function Spinner({ className = "size-4" }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} aria-hidden />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line-2 px-3 py-3 text-[13px] text-ink-3">{children}</p>;
}
