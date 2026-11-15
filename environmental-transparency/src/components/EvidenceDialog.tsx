"use client";

import { useEffect, useRef } from "react";
import { ExternalLink, FileText, TriangleAlert, X } from "lucide-react";
import { RETRIEVAL_LABELS, documentLabel, fmtDate, fmtNumber, type Evidence } from "@/lib/client/facts";
import { ReviewBadge } from "@/components/ui";

export default function EvidenceDialog({ evidence, onClose }: { evidence: Evidence | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (evidence && !d.open) d.showModal();
    if (!evidence && d.open) d.close();
  }, [evidence]);

  const e = evidence;
  const numeric = e?.value !== null && e?.value !== undefined && Number.isFinite(Number(e.value));
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(ev) => ev.target === ref.current && onClose()}
      className="m-auto w-[min(560px,calc(100vw-32px))] rounded-2xl border border-line bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/30 backdrop:backdrop-blur-[2px]"
      aria-labelledby="evidence-title"
    >
      {e && (
        <div className="animate-rise">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 pb-4 pt-5">
            <div className="min-w-0">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Evidence</p>
              <h2 id="evidence-title" className="font-serif text-xl leading-tight">
                {e.title}
              </h2>
              {e.value && (
                <p className="mt-2 text-2xl font-semibold tracking-tight">
                  {numeric ? fmtNumber(e.value) : e.value} {e.unit && <span className="text-base font-normal text-ink-2">{e.unit}</span>}
                </p>
              )}
              {e.context && <p className="mt-1 text-[13px] text-ink-2">{e.context}</p>}
            </div>
            <button onClick={onClose} className="rounded-full p-1.5 text-ink-3 hover:bg-black/5 hover:text-ink" aria-label="Close evidence">
              <X className="size-4" />
            </button>
          </div>

          <div className="space-y-4 px-5 py-4">
            <ReviewBadge status={e.reviewStatus} method={e.method} />
            {e.quote && (
              <figure>
                <blockquote className="quote border-l-2 border-accent/60 pl-3 text-[15px] leading-relaxed text-ink">“{e.quote}”</blockquote>
                {e.page && <figcaption className="mt-1 pl-3 text-xs text-ink-3">Page {e.page}</figcaption>}
              </figure>
            )}

            {e.document && (
              <a
                href={e.document.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-start gap-3 rounded-xl border border-line bg-paper/60 p-3 transition hover:border-line-2 hover:bg-paper"
              >
                <FileText className="mt-0.5 size-4 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium group-hover:underline">{documentLabel(e.document)}</p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {e.document.issuer ?? new URL(e.document.source_url).hostname} · retrieved {fmtDate(e.document.retrieved_at)} via{" "}
                    {RETRIEVAL_LABELS[e.document.retrieval_method ?? ""] ?? e.document.retrieval_method ?? "unknown method"}
                  </p>
                  <p className="mt-1 truncate font-mono text-[11px] text-ink-3">
                    {new URL(e.document.source_url).host}
                    {new URL(e.document.source_url).pathname} · sha256 {e.document.content_hash?.slice(0, 10)}…
                  </p>
                </div>
                <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
              </a>
            )}
            {e.dataset && (
              <a
                href={e.dataset.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-xl border border-line bg-paper/60 p-3 text-sm hover:bg-paper"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{e.dataset.name}</p>
                  <p className="text-xs text-ink-3">{e.dataset.publisher}</p>
                </div>
                <ExternalLink className="size-3.5 text-ink-3" />
              </a>
            )}

            {e.limitations.length > 0 && (
              <div className="rounded-xl bg-[#f6efe2] p-3">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-[#7a5a1e]">
                  <TriangleAlert className="size-3.5" /> Limitations
                </p>
                <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-[#5e4a22]">
                  {e.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
