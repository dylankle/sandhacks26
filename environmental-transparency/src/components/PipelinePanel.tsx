"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleX, Database, FileSearch, Globe, ScanText, ShieldCheck, Sparkles, Terminal, X } from "lucide-react";
import { fmtDate } from "@/lib/client/facts";
import { Spinner } from "@/components/ui";

interface Run {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  outcome: string;
  projectId?: string;
  projectName?: string;
  validation?: { stats: { claims: number; validated: number; unverified: number; dropped: number } };
  usage?: { brightData: { serp: number; unlocker: number }; gemini: { calls: number } };
  error?: string;
  steps: { step: string; ok: boolean; detail: string; ms: number }[];
}

const STEP_ICON: Record<string, typeof Globe> = {
  discover: FileSearch,
  retrieve: Globe,
  dedupe: ScanText,
  extract: Sparkles,
  validate: ShieldCheck,
  geocode: Globe,
  persist: Database,
  cache: Database,
};

const OUTCOME: Record<string, string> = {
  created: "bg-open/10 text-open",
  updated: "bg-ai/10 text-ai",
  unchanged: "bg-black/5 text-ink-3",
  rejected: "bg-unverified/10 text-unverified",
  failed: "bg-red-50 text-red-700",
};

export default function PipelinePanel({ onClose, onOpenProject }: { onClose: () => void; onOpenProject: (id: string) => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/ingest")
        .then((r) => r.json())
        .then((d) => alive && Array.isArray(d) && setRuns(d))
        .catch(() => alive && setRuns([]));
    load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-line bg-panel shadow-2xl sm:w-[520px]">
      <header className="flex items-start justify-between border-b border-line px-5 py-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Data pipeline</p>
          <h2 className="font-serif text-2xl">How records get here</h2>
        </div>
        <button onClick={onClose} className="rounded-full p-2 text-ink-3 hover:bg-black/5" aria-label="Close pipeline">
          <X className="size-4" />
        </button>
      </header>
      <div className="scroll-thin flex-1 space-y-5 overflow-y-auto px-5 py-5">
        <ol className="grid grid-cols-5 gap-1 text-center text-[11px] text-ink-2">
          {[
            ["Discover", "Bright Data SERP", FileSearch],
            ["Retrieve", "Web Unlocker", Globe],
            ["Extract", "Gemini JSON", Sparkles],
            ["Validate", "Quotes vs. source", ShieldCheck],
            ["Store", "Supabase", Database],
          ].map(([a, b, Icon], i) => {
            const I = Icon as typeof Globe;
            return (
              <li key={String(a)} className="rounded-lg bg-paper px-1 py-2">
                <I className="mx-auto mb-1 size-4 text-ink" />
                <p className="font-semibold text-ink">
                  {i + 1}. {String(a)}
                </p>
                <p className="text-[10px] text-ink-3">{String(b)}</p>
              </li>
            );
          })}
        </ol>
        <div className="rounded-xl bg-ink px-3 py-2.5 font-mono text-[11px] leading-relaxed text-white/85">
          <p className="mb-1 flex items-center gap-1.5 text-white/50">
            <Terminal className="size-3" /> protected trigger (admin token, server-side only)
          </p>
          <p>npm run ingest -- --url https://ceqanet.lci.ca.gov/&lt;SCH#&gt;</p>
          <p>npm run ingest -- --discover &quot;&lt;search query&gt;&quot;</p>
        </div>

        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Recent ingestion runs · auto-refreshing</p>
          {!runs && (
            <p className="flex items-center gap-2 text-sm text-ink-3">
              <Spinner /> Loading…
            </p>
          )}
          {runs?.length === 0 && <p className="text-sm text-ink-3">No runs yet.</p>}
          <ul className="space-y-3">
            {runs?.map((r) => (
              <li key={r.runId} className="animate-rise rounded-xl border border-line p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium">{r.projectName ?? "Unidentified source"}</p>
                    <p className="text-[11px] text-ink-3">{fmtDate(r.startedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${OUTCOME[r.outcome] ?? ""}`}>{r.outcome}</span>
                </div>
                <ul className="mt-2 space-y-1">
                  {r.steps.map((s, i) => {
                    const I = STEP_ICON[s.step] ?? Globe;
                    return (
                      <li key={i} className="flex gap-2 text-[12px] leading-snug">
                        {s.ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0 text-verified" /> : <CircleX className="mt-px size-3.5 shrink-0 text-red-600" />}
                        <I className="mt-px size-3.5 shrink-0 text-ink-3" />
                        <span className="min-w-0 break-words text-ink-2">
                          <span className="font-medium capitalize text-ink">{s.step}</span> {s.detail}
                          <span className="text-ink-3"> · {(s.ms / 1000).toFixed(1)}s</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-[11px] text-ink-3">
                  <span>
                    {r.usage ? `Bright Data: ${r.usage.brightData.serp} SERP · ${r.usage.brightData.unlocker} Unlocker · Gemini: ${r.usage.gemini.calls}` : ""}
                    {r.validation ? ` · ${r.validation.stats.validated}/${r.validation.stats.claims} claims verified` : ""}
                  </span>
                  {r.projectId && (r.outcome === "created" || r.outcome === "updated" || r.outcome === "unchanged") && (
                    <button onClick={() => onOpenProject(r.projectId!)} className="font-medium text-ink hover:underline">
                      Open record →
                    </button>
                  )}
                </div>
                {r.error && <p className="mt-1 text-[12px] text-red-700">{r.error}</p>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
