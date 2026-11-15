"use client";

import { useState } from "react";
import { ChevronRight, ExternalLink, FileText, MapPin } from "lucide-react";
import {
  COST_CATEGORY_LABELS,
  GOVERNMENT_ROLE_LABELS,
  PRECISION_LABELS,
  PROPONENT_ROLE_LABELS,
  RETRIEVAL_LABELS,
  considerations,
  costs,
  documentLabel,
  documentedTopics,
  evidenceFromFact,
  factValue,
  fmtDate,
  fmtMoney,
  fmtNumber,
  governmentParticipants,
  metrics,
  passageOf,
  proponents,
  timeline,
  topicOfField,
  type Evidence,
} from "@/lib/client/facts";
import { AiLabel, Empty, ReviewBadge, SectionTitle } from "@/components/ui";
import { TOPIC_LABELS, type FactRecord, type ProjectDetail, type Topic } from "@/types/project";

const CORE_TOPICS: Topic[] = ["energy", "water", "air_quality", "noise", "traffic"];

export function MetricCard({ f, p, onEvidence }: { f: FactRecord; p: ProjectDetail; onEvidence: (e: Evidence) => void }) {
  const pass = passageOf(f);
  const verified = f.review_status === "validated";
  return (
    <button
      onClick={() => onEvidence(evidenceFromFact(f, p.documents))}
      className="group flex flex-col items-start rounded-xl border border-line bg-panel p-3 text-left transition hover:-translate-y-px hover:border-line-2 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">{TOPIC_LABELS[topicOfField(f.field) ?? "other"]}</span>
      <span className="mt-1 text-xl font-semibold tracking-tight">
        {fmtNumber(f.value)} <span className="text-sm font-normal text-ink-2">{f.unit}</span>
      </span>
      <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-ink-2">
        {pass.label}
        {pass.context ? ` · ${pass.context}` : ""}
      </span>
      <span className={`mt-2 inline-flex items-center gap-1 text-[11px] font-medium ${verified ? "text-verified" : "text-unverified"}`}>
        {verified ? "Quote verified" : "Unverified"} <ChevronRight className="size-3 transition group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

function CostCard({ f, category, p, onEvidence }: { f: FactRecord; category: string; p: ProjectDetail; onEvidence: (e: Evidence) => void }) {
  const pass = passageOf(f);
  const verified = f.review_status === "validated";
  const paidBy = pass.details?.paid_by;
  return (
    <button
      onClick={() => onEvidence(evidenceFromFact(f, p.documents))}
      className="group flex flex-col items-start rounded-xl border border-line bg-panel p-3 text-left transition hover:-translate-y-px hover:border-line-2 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">{COST_CATEGORY_LABELS[category] ?? category}</span>
      <span className="mt-1 text-xl font-semibold tracking-tight">{fmtMoney(f.value, f.unit)}</span>
      <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-ink-2">
        {pass.label}
        {pass.context ? ` · ${pass.context}` : ""}
      </span>
      {paidBy && <span className="mt-0.5 text-[12px] text-ink-3">Paid by: {paidBy}</span>}
      <span className={`mt-2 inline-flex items-center gap-1 text-[11px] font-medium ${verified ? "text-verified" : "text-unverified"}`}>
        {verified ? "Quote verified" : "Unverified"} <ChevronRight className="size-3 transition group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

export default function OverviewTab({ p, onEvidence }: { p: ProjectDetail; onEvidence: (e: Evidence) => void }) {
  const [now] = useState(() => Date.now());
  const m = metrics(p);
  const c = considerations(p);
  const tl = timeline(p);
  const money = costs(p);
  const props_ = proponents(p);
  const gov = governmentParticipants(p);
  const topics = documentedTopics(p);
  const missing = CORE_TOPICS.filter((t) => !m.some((f) => topicOfField(f.field) === t));
  const coordFact = p.facts.find((f) => f.field === "location.coordinates") ?? p.facts.find((f) => f.field === "location.verification");
  const verification = p.facts.find((f) => f.field === "location.verification");
  const docType = factValue(p, "identity.document_type");
  const caseNumbers = [...new Set(p.facts.filter((f) => f.field === "identity.case_number" || f.field === "identity.sch_number").map((f) => f.value))];

  return (
    <div className="space-y-6">
      {p.index_level === "lightweight" && (
        <p className="rounded-xl border border-line bg-paper p-3 text-[12px] leading-relaxed text-ink-2">
          <span className="font-semibold text-ink">Basic record.</span> Title, agency, dates, status and location come from structured State Clearinghouse fields (tap any item for its source row).
          Environmental figures and participation details have not been extracted yet.
        </p>
      )}
      {p.summary && (
        <section className="rounded-xl border border-ai/15 bg-gradient-to-b from-ai/[0.05] to-transparent p-4">
          <AiLabel>Plain-language summary · AI-generated from the records below</AiLabel>
          <p className="mt-2 text-[15px] leading-relaxed">{p.summary}</p>
        </section>
      )}

      <section>
        <SectionTitle>What the records describe</SectionTitle>
        <p className="text-[14px] leading-relaxed text-ink-2">{p.description ?? "No description in retrieved records."}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
          <div>
            <dt className="text-ink-3">Lead agency</dt>
            <dd className="font-medium">{p.lead_agency ?? "Not stated"}</dd>
          </div>
          <div>
            <dt className="text-ink-3">Applicant / developer</dt>
            <dd className="font-medium">{p.developer ?? "Not stated"}</dd>
          </div>
          {docType && (
            <div>
              <dt className="text-ink-3">Latest CEQA document</dt>
              <dd className="font-medium">{docType}</dd>
            </div>
          )}
          {caseNumbers.length > 0 && (
            <div>
              <dt className="text-ink-3">Record numbers</dt>
              <dd className="font-mono text-[12px]">{caseNumbers.join(" · ")}</dd>
            </div>
          )}
          <div className="col-span-2">
            <dt className="text-ink-3">Location</dt>
            <dd>
              <button
                disabled={!coordFact}
                onClick={() => coordFact && onEvidence(evidenceFromFact(coordFact, p.documents, "Site location"))}
                className="inline-flex items-center gap-1.5 text-left font-medium hover:underline disabled:no-underline"
              >
                <MapPin className="size-3.5 text-accent" />
                {PRECISION_LABELS[p.location_precision] ?? p.location_precision}
              </button>
              {p.latitude === null && verification && <p className="mt-0.5 text-[12px] text-ink-3">{passageOf(verification).quote?.replace(/^Not mapped:\s*/, "")}</p>}
              {p.jurisdiction && <p className="mt-0.5 text-[12px] text-ink-3">{p.jurisdiction}</p>}
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <SectionTitle aside={<span className="text-[11px] text-ink-3">As stated in the records</span>}>Estimated costs</SectionTitle>
        {money.length ? (
          <div className="grid grid-cols-2 gap-2">
            {money.map((c) => (
              <CostCard key={c.fact.id} f={c.fact} category={c.category} p={p} onEvidence={onEvidence} />
            ))}
          </div>
        ) : (
          <Empty>No cost figures stated in the retrieved records.</Empty>
        )}
      </section>

      <section>
        <SectionTitle>Who&apos;s involved</SectionTitle>
        <h4 className="mb-1.5 text-[12px] font-semibold text-ink-2">Proposed by</h4>
        {props_.length ? (
          <ul className="space-y-1.5">
            {props_.map((x) => (
              <li key={x.fact.id}>
                <button
                  onClick={() => onEvidence(evidenceFromFact(x.fact, p.documents, `${PROPONENT_ROLE_LABELS[x.role] ?? x.role}: ${x.name}`))}
                  className="flex w-full items-start justify-between gap-3 rounded-lg border border-line px-3 py-2 text-left transition hover:border-line-2 hover:bg-paper/50"
                >
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium">{x.name}</span>
                    <span className="block text-[12px] text-ink-3">
                      {PROPONENT_ROLE_LABELS[x.role] ?? x.role}
                      {x.representative ? ` · contact: ${x.representative}` : ""}
                    </span>
                  </span>
                  <ReviewBadge status={x.fact.review_status} method={x.fact.method} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-2">{p.developer ?? "Not stated in the retrieved records."}</p>
        )}

        <h4 className="mb-1.5 mt-4 text-[12px] font-semibold text-ink-2">Government review &amp; decisions</h4>
        {gov.length ? (
          <ul className="space-y-1.5">
            {gov.map((g) => (
              <li key={g.fact.id}>
                <button
                  onClick={() => onEvidence(evidenceFromFact(g.fact, p.documents, g.action ?? g.body))}
                  className="w-full rounded-lg border border-line px-3 py-2 text-left transition hover:border-line-2 hover:bg-paper/50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium">
                        {g.name ?? g.body}
                        {g.title && <span className="font-normal text-ink-2"> · {g.title}</span>}
                      </span>
                      <span className="block text-[12px] text-ink-3">
                        {GOVERNMENT_ROLE_LABELS[g.role] ?? g.role}
                        {g.name ? ` · ${g.body}` : ""}
                        {g.date ? ` · ${fmtDate(g.date)}` : ""}
                      </span>
                    </span>
                    {g.vote && (
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase ${g.vote === "yes" ? "bg-verified/10 text-verified" : g.vote === "no" ? "bg-unverified/10 text-unverified" : "bg-black/[0.05] text-ink-2"}`}
                      >
                        {g.vote}
                      </span>
                    )}
                  </div>
                  {g.action && <p className="mt-1 text-[13px] leading-snug text-ink-2">{g.action}</p>}
                  <div className="mt-1.5">
                    <ReviewBadge status={g.fact.review_status} method={g.fact.method} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-2">
            {p.lead_agency ? `${p.lead_agency} (lead agency). No individual officials or votes found in the retrieved records.` : "No officials or agencies named in the retrieved records."}
          </p>
        )}
      </section>

      <section>
        <SectionTitle aside={<span className="text-[11px] text-ink-3">Tap a figure to see its source</span>}>Reported figures</SectionTitle>
        {m.length ? (
          <div className="grid grid-cols-2 gap-2">
            {m.map((f) => (
              <MetricCard key={f.id} f={f} p={p} onEvidence={onEvidence} />
            ))}
          </div>
        ) : (
          <Empty>No quantitative figures in the retrieved records.</Empty>
        )}
        {missing.length > 0 && (
          <p className="mt-2.5 text-[12px] text-ink-3">
            <span className="font-medium text-ink-2">Not reported in retrieved records:</span> {missing.map((t) => TOPIC_LABELS[t].toLowerCase()).join(", ")}.
            Unknown values are left unknown.
          </p>
        )}
      </section>

      <section>
        <SectionTitle>Documented considerations</SectionTitle>
        {c.length ? (
          <ul className="space-y-2">
            {c.map((f) => {
              const pass = passageOf(f);
              return (
                <li key={f.id}>
                  <button
                    onClick={() => onEvidence(evidenceFromFact(f, p.documents, TOPIC_LABELS[topicOfField(f.field) ?? "other"]))}
                    className="w-full rounded-xl border border-line p-3 text-left transition hover:border-line-2 hover:bg-paper/50"
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">{TOPIC_LABELS[topicOfField(f.field) ?? "other"]}</span>
                      <span className="text-[11px] text-ink-3">·</span>
                      <span className="text-[11px] capitalize text-ink-3">{pass.kind}</span>
                      {pass.significance && <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[11px] text-ink-2">{pass.significance}</span>}
                    </div>
                    <p className="text-[14px] leading-snug">{f.value}</p>
                    <div className="mt-2">
                      <ReviewBadge status={f.review_status} method={f.method} />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>No specific environmental findings extracted yet.</Empty>
        )}
        {factValue(p, "identity.project_issues") && (
          <p className="mt-2.5 text-[12px] leading-relaxed text-ink-3">
            <span className="font-medium text-ink-2">Issue areas listed in the State Clearinghouse filing:</span> {factValue(p, "identity.project_issues")}
          </p>
        )}
        {topics.length > 0 && <p className="sr-only">Topics: {topics.join(", ")}</p>}
      </section>

      <section>
        <SectionTitle>Timeline</SectionTitle>
        {tl.length ? (
          <ol className="relative ml-1.5 border-l border-line-2">
            {tl.map((t) => {
              const future = Date.parse(`${t.date}T23:59:59`) > now;
              return (
                <li key={t.fact.id} className="mb-3 ml-4 last:mb-0">
                  <span className={`absolute -left-[5px] mt-1.5 size-2.5 rounded-full ring-2 ring-panel ${future ? "bg-open" : "bg-ink-3"}`} />
                  <button onClick={() => onEvidence(evidenceFromFact(t.fact, p.documents, t.label))} className="text-left hover:underline">
                    <p className="font-mono text-[12px] text-ink-3">{fmtDate(t.date)}</p>
                    <p className="text-[13px]">{t.label}</p>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <Empty>No dated procedural steps found.</Empty>
        )}
        <p className="mt-3 text-[12px] text-ink-3">Record last checked {fmtDate(p.last_checked_at, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</p>
      </section>

      <section>
        <SectionTitle aside={<span className="text-[11px] text-ink-3">{p.documents.length} retrieved</span>}>Source documents</SectionTitle>
        <ul className="space-y-1.5">
          {p.documents.map((d) => (
            <li key={d.id}>
              <a
                href={d.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-start gap-2.5 rounded-lg px-2 py-2 transition hover:bg-paper"
              >
                <FileText className="mt-0.5 size-4 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium group-hover:underline">{documentLabel(d)}</p>
                  <p className="text-[11px] text-ink-3">
                    {d.issuer ?? new URL(d.source_url).hostname}
                    {d.version > 1 ? ` · version ${d.version}` : ""} · {RETRIEVAL_LABELS[d.retrieval_method ?? ""] ?? "retrieved"} {fmtDate(d.retrieved_at)}
                  </p>
                </div>
                <ExternalLink className="mt-1 size-3 shrink-0 text-ink-3 opacity-0 transition group-hover:opacity-100" />
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
