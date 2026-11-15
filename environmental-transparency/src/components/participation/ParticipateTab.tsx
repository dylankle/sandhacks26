"use client";

import { useState, type ReactNode } from "react";
import { Building2, CalendarClock, CircleHelp, ExternalLink, FileText, Gavel, Globe, Mail, MapPin, Phone, ShieldCheck, UserRound, Video } from "lucide-react";
import { documentLabel, fmtDate } from "@/lib/client/facts";
import { formatDay, formatPacific, participationGuide, type CommentWindow, type Submission } from "@/lib/participation";
import { SectionTitle } from "@/components/ui";
import type { DocumentRecord, ProjectDetail } from "@/types/project";

/**
 * A guide to official participation channels, built only from stored official-record facts.
 * No model calls; nothing is submitted from this site; missing items are shown as missing.
 */

const NOT_LISTED = "Not listed in the official records retrieved";

function Unverified({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-[12px] leading-snug text-ink-3">
      <CircleHelp className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function SourceLink({ doc, label = "Source" }: { doc: DocumentRecord | null; label?: string }) {
  if (!doc) return null;
  return (
    <a href={doc.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-2 underline decoration-line-2 underline-offset-2 hover:text-ink">
      {label}: {documentLabel(doc)} <ExternalLink className="size-3" />
    </a>
  );
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 py-1.5">
      <span className="mt-0.5 text-ink-3">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">{label}</p>
        <div className="text-[13px]">{children}</div>
      </div>
    </div>
  );
}

function CommentStatus({ w }: { w: CommentWindow | null }) {
  if (!w) {
    return (
      <section className="rounded-xl border border-dashed border-line-2 p-4">
        <p className="flex items-center gap-2 text-[15px] font-semibold">
          <CalendarClock className="size-5 text-ink-3" /> No verified comment period
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
          The official records retrieved don&apos;t state a public comment window for this project, so no deadline is shown. Contact the agency below to ask whether one is planned.
        </p>
      </section>
    );
  }
  const tone = w.state === "open" ? "border-open/30 bg-open/[0.05]" : w.state === "upcoming" ? "border-accent/30 bg-accent/[0.05]" : "border-line bg-paper/60";
  const n = w.daysLeft;
  return (
    <section className={`rounded-xl border p-4 ${tone}`}>
      <p className={`flex items-center gap-2 text-[15px] font-semibold ${w.state === "open" ? "text-open" : ""}`}>
        <CalendarClock className="size-5 shrink-0" />
        {w.state === "open" && `Public comment is open · ${n <= 0 ? "closes today" : n === 1 ? "1 day left" : `${n} days left`}`}
        {w.state === "upcoming" && `Public comment opens ${formatDay(w.start!)}`}
        {w.state === "closed" && "Public comment period has closed"}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        {w.start && (
          <>
            <dt className="text-ink-3">Opens</dt>
            <dd>{formatDay(w.start)}</dd>
          </>
        )}
        <dt className="text-ink-3">{w.state === "closed" ? "Closed" : "Deadline"}</dt>
        <dd className="font-semibold">{formatPacific(w.deadline)}</dd>
      </dl>
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-3">
        <ShieldCheck className="size-3.5 text-verified" /> Verified date from the official record{w.event.quote ? `: “${w.event.quote}”` : ""}
      </p>
      <div className="mt-1">
        <SourceLink doc={w.document} />
      </div>
    </section>
  );
}

function SubmitChannel({ s, open }: { s: Submission | null; open: boolean }) {
  if (!s) return <Unverified>No official submission form, portal, or email is stated in the records retrieved. Use the agency contact below to ask how to submit.</Unverified>;
  return (
    <div className="space-y-2">
      <a
        href={s.href}
        {...(s.kind === "portal" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className={`flex items-center justify-between gap-3 rounded-xl px-3.5 py-3 text-[14px] font-semibold transition ${open ? "bg-ink text-white hover:bg-ink/85" : "border border-line-2 hover:bg-paper"}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {s.kind === "portal" ? <Globe className="size-4 shrink-0" /> : <Mail className="size-4 shrink-0" />}
          <span className="truncate">{s.kind === "portal" ? `Official comment portal · ${s.display}` : `Email comments to ${s.display}`}</span>
        </span>
        <ExternalLink className="size-4 shrink-0 opacity-80" />
      </a>
      <p className="text-[11px] text-ink-3">
        {s.kind === "email" ? "Email address" : "Portal"} {s.source === "stated in notice" ? "stated in the public notice" : s.source ? `from the ${s.source}` : "from the official record"}.
        {s.kind === "email" ? " Opens your own email app; IMBY never sends anything for you." : " Opens the agency's site; IMBY never submits anything for you."}
      </p>
    </div>
  );
}

export default function ParticipateTab({ p }: { p: ProjectDetail }) {
  const [now] = useState(() => Date.now());
  const g = participationGuide(p, now);
  const c = g.contact;
  const open = g.comment?.state === "open";

  return (
    <div className="space-y-6">
      <CommentStatus w={g.comment} />

      <section>
        <SectionTitle>{open ? "Submit a comment" : "Official submission channel"}</SectionTitle>
        <SubmitChannel s={g.comment?.submission ?? null} open={open} />
      </section>

      <section>
        <SectionTitle>Responsible agency</SectionTitle>
        <div className="divide-y divide-line rounded-xl border border-line px-3 py-1">
          <Row icon={<Building2 className="size-4" />} label="Lead agency">
            <p className="font-medium">{g.agency ?? <span className="text-ink-3">{NOT_LISTED}</span>}</p>
            {g.department && <p className="text-ink-2">{g.department}</p>}
          </Row>
          <Row icon={<UserRound className="size-4" />} label="Contact person">
            {c?.name ? (
              <p>
                {c.name}
                {c.title ? <span className="text-ink-2">, {c.title}</span> : null}
              </p>
            ) : (
              <p className="text-ink-3">{NOT_LISTED}</p>
            )}
          </Row>
          <Row icon={<Mail className="size-4" />} label="Email">
            {c?.email ? (
              <a href={`mailto:${c.email}`} className="break-all font-mono text-[12px] underline decoration-line-2 underline-offset-2 hover:text-ink">
                {c.email}
              </a>
            ) : (
              <p className="text-ink-3">{NOT_LISTED}</p>
            )}
          </Row>
          <Row icon={<Phone className="size-4" />} label="Phone">
            {c?.phone ? (
              <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} className="font-mono text-[12px] underline decoration-line-2 underline-offset-2 hover:text-ink">
                {c.phone}
              </a>
            ) : (
              <p className="text-ink-3">{NOT_LISTED}</p>
            )}
          </Row>
          <Row icon={<MapPin className="size-4" />} label="Mailing address">
            {c?.address ? <p>{c.address}</p> : <p className="text-ink-3">{NOT_LISTED}</p>}
          </Row>
        </div>
        {c && (
          <div className="mt-1.5">
            <SourceLink doc={c.document} label="Contact listed in" />
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Public hearings</SectionTitle>
        {g.hearings.upcoming.length ? (
          <ul className="space-y-2">
            {g.hearings.upcoming.map((h) => (
              <li key={h.event.id} className="rounded-xl border border-accent/30 bg-accent/[0.04] p-3">
                <p className="flex items-center gap-2 text-[14px] font-semibold">
                  <Gavel className="size-4 text-accent" /> {formatDay(h.date)}
                  {h.time ? ` · ${h.time}` : ""}
                </p>
                <div className="mt-1 space-y-0.5 pl-6 text-[13px] text-ink-2">
                  <p>{h.body ?? "Public hearing"}</p>
                  <p className="flex items-start gap-1.5">
                    <MapPin className="mt-0.5 size-3.5 shrink-0" /> {h.location ?? <span className="text-ink-3">Location not stated in the record</span>}
                  </p>
                  {h.virtual && (
                    <p className="flex items-start gap-1.5 break-all">
                      <Video className="mt-0.5 size-3.5 shrink-0" />
                      {/^https?:\/\//.test(h.virtual) ? (
                        <a href={h.virtual} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                          {h.virtual}
                        </a>
                      ) : (
                        h.virtual
                      )}
                    </p>
                  )}
                  {!h.time && <p className="text-[11px] text-ink-3">Time not stated in the record. Confirm with the agency before attending.</p>}
                  <SourceLink doc={h.document} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Unverified>No upcoming public hearing is stated in the official records retrieved. Hearings are shown only when a notice or agenda gives the date.</Unverified>
        )}
        {g.hearings.past.length > 0 && (
          <details className="mt-2 text-[12px] text-ink-3">
            <summary className="cursor-pointer">Past hearings ({g.hearings.past.length})</summary>
            <ul className="mt-1.5 space-y-1 pl-4">
              {g.hearings.past.map((h) => (
                <li key={h.event.id}>
                  {formatDay(h.date)} · {h.body ?? "Public hearing"}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {g.nextSteps.length > 0 && (
        <section>
          <SectionTitle>What you can still do</SectionTitle>
          <ul className="space-y-1.5 text-[13px] leading-relaxed text-ink-2">
            {g.nextSteps.map((s) => (
              <li key={s} className="flex gap-2">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3" />
                {s}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <SectionTitle aside={<span className="text-[11px] text-ink-3">{g.notices.length}</span>}>Official notices &amp; source documents</SectionTitle>
        <ul className="space-y-1">
          {g.notices.map((d) => (
            <li key={d.id}>
              <a href={d.source_url} target="_blank" rel="noopener noreferrer" className="group flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-paper">
                <FileText className="mt-0.5 size-4 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium group-hover:underline">{documentLabel(d)}</span>
                  <span className="block text-[11px] text-ink-3">
                    {d.issuer ?? new URL(d.source_url).hostname}
                    {d.publication_date ? ` · ${fmtDate(d.publication_date)}` : ""}
                  </span>
                </span>
                <ExternalLink className="mt-1 size-3 shrink-0 text-ink-3" />
              </a>
            </li>
          ))}
        </ul>
      </section>

      {g.missing.length > 0 && (
        <section className="rounded-xl bg-paper p-3">
          <p className="text-[12px] font-semibold text-ink-2">Not found in the official records retrieved</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{g.missing.join(" · ")}. IMBY doesn&apos;t fill these in or guess them. Ask the agency directly.</p>
        </section>
      )}

      <p className="flex gap-1.5 text-[11px] leading-snug text-ink-3">
        <ShieldCheck className="mt-px size-3.5 shrink-0" />
        IMBY only points to official channels. It doesn&apos;t send, file, or store comments for you. Deadlines are in Pacific time, as set by the agency.
      </p>
    </div>
  );
}
