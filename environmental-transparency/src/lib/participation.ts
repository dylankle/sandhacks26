/**
 * Participation logic shared by the read API, the sidebar and the Participate tab. Pure and
 * timezone-explicit: California agencies set deadlines in Pacific time, so every "today",
 * "days left" and "upcoming" decision is made on the Pacific calendar, whatever the viewer's zone.
 */
import type { DocumentRecord, FactRecord, ParticipationRecord, ProjectDetail, ProjectStatus } from "@/types/project";

export const PACIFIC = "America/Los_Angeles";

/** Calendar date (YYYY-MM-DD) of an instant in Pacific time. */
export function pacificDate(at: string | number | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  return new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

const dayNumber = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 864e5;

/** Whole Pacific calendar days from `now` until the deadline's date (0 = closes today, negative = past). */
export function daysUntilPacific(deadlineIso: string, now: number | Date = Date.now()): number {
  return dayNumber(pacificDate(deadlineIso)) - dayNumber(pacificDate(now));
}

/** "Mon, Dec 7, 2026, 11:59 PM PST": the instant shown in Pacific time with its zone. */
export function formatPacific(iso: string, withTime = true): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" } : {}),
  }).format(new Date(iso));
}

/** A date-only value (YYYY-MM-DD) formatted without timezone drift. */
export function formatDay(ymd: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${ymd.slice(0, 10)}T00:00:00Z`));
}

export type CommentState = "upcoming" | "open" | "closed";

/** A comment window is upcoming before its stated start day (Pacific), open through the deadline instant, then closed. */
export function commentState(deadlineIso: string, start: string | null | undefined, now: number | Date = Date.now()): CommentState {
  const t = now instanceof Date ? now.getTime() : now;
  if (start && /^\d{4}-\d{2}-\d{2}/.test(start) && pacificDate(t) < start.slice(0, 10)) return "upcoming";
  return Date.parse(deadlineIso) >= t ? "open" : "closed";
}

/** Hearings are stored by date; one is upcoming through the end of its Pacific calendar day. */
export function hearingUpcoming(dateOrIso: string, now: number | Date = Date.now()): boolean {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dateOrIso) ? dateOrIso : pacificDate(dateOrIso);
  return day >= pacificDate(now);
}

// ---------------------------------------------------------------------------
// Sidebar prioritization
// ---------------------------------------------------------------------------

export interface Prioritizable {
  id: string;
  canonical_name: string;
  status: ProjectStatus | string;
  comment_status: "open" | "upcoming" | "closed" | "none" | "unverified";
  comment_deadline: string | null;
  comment_opens: string | null;
  next_hearing: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * 1 verified open comment window · 2 verified upcoming comment window or hearing ·
 * 3 other proposed / under-review · 4 decided (approved, completed, denied, withdrawn) ·
 * 5 procedural status not verified.
 */
export function actionTier(p: Prioritizable): 1 | 2 | 3 | 4 | 5 {
  if (p.comment_status === "open" && p.comment_deadline) return 1;
  if ((p.comment_status === "upcoming" && p.comment_opens) || p.next_hearing) return 2;
  if (p.status === "proposed" || p.status === "under_review") return 3;
  if (["approved", "under_construction", "operational", "denied", "withdrawn"].includes(p.status)) return 4;
  return 5;
}

export const TIER_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "Open for public comment",
  2: "Upcoming comment period or hearing",
  3: "Under review",
  4: "Decided",
  5: "Status not verified",
};

export type StatusFilter = "action" | "review" | "decided" | "unverified";
/** Optional sidebar/map status filters, each a group of action tiers. */
export const STATUS_FILTERS: { id: StatusFilter; label: string; tiers: number[] }[] = [
  { id: "action", label: "Action available", tiers: [1, 2] },
  { id: "review", label: "Under review", tiers: [3] },
  { id: "decided", label: "Decided", tiers: [4] },
  { id: "unverified", label: "Status not verified", tiers: [5] },
];

/** Point-in-viewport test for [west, south, east, north] bounds. */
export function inBounds([lng, lat]: [number, number], [w, s, e, n]: [number, number, number, number]): boolean {
  return lat >= s && lat <= n && (w <= e ? lng >= w && lng <= e : lng >= w || lng <= e);
}

/** Equirectangular distance in km (ranking only). */
function km(a: [number, number], b: [number, number]) {
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  return Math.hypot((a[0] - b[0]) * 111.32 * Math.cos(lat), (a[1] - b[1]) * 110.57);
}

/**
 * Orders projects for the sidebar. Actionable tiers sort by the soonest verified date; the rest by
 * distance from the map's center (geographic relevance), with unmapped projects after mapped ones.
 */
export function prioritize<T extends Prioritizable>(list: T[], center: [number, number] | null): T[] {
  const soonest = (p: T) => {
    if (actionTier(p) === 1) return Date.parse(p.comment_deadline!);
    const dates = [p.comment_status === "upcoming" ? p.comment_opens : null, p.next_hearing].filter(Boolean) as string[];
    return dates.length ? Math.min(...dates.map((d) => Date.parse(d.length === 10 ? `${d}T12:00:00Z` : d))) : Infinity;
  };
  const dist = (p: T) => (center && p.latitude !== null && p.longitude !== null ? km(center, [p.longitude, p.latitude]) : p.latitude !== null ? 0 : Infinity);
  return [...list].sort((a, b) => {
    const ta = actionTier(a);
    const tb = actionTier(b);
    if (ta !== tb) return ta - tb;
    if (ta <= 2) return soonest(a) - soonest(b) || a.canonical_name.localeCompare(b.canonical_name);
    return dist(a) - dist(b) || a.canonical_name.localeCompare(b.canonical_name);
  });
}

// ---------------------------------------------------------------------------
// Participate guide (built only from stored official-record facts)
// ---------------------------------------------------------------------------

export interface Contact {
  name: string | null;
  title: string | null;
  agency: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  fact: FactRecord;
  document: DocumentRecord | null;
}

export interface Submission {
  kind: "portal" | "email";
  href: string;
  display: string;
  /** Where the channel comes from, e.g. "stated in notice" or "CEQAnet lead agency contact". */
  source: string | null;
}

export interface CommentWindow {
  event: ParticipationRecord;
  state: CommentState;
  start: string | null;
  deadline: string;
  daysLeft: number;
  submission: Submission | null;
  document: DocumentRecord | null;
}

export interface Hearing {
  event: ParticipationRecord;
  date: string;
  upcoming: boolean;
  time: string | null;
  body: string | null;
  location: string | null;
  virtual: string | null;
  document: DocumentRecord | null;
}

export interface Guide {
  agency: string | null;
  department: string | null;
  contact: Contact | null;
  /** Most relevant window: open, else upcoming, else most recent closed. */
  comment: CommentWindow | null;
  earlierComments: CommentWindow[];
  hearings: { upcoming: Hearing[]; past: Hearing[] };
  notices: DocumentRecord[];
  nextSteps: string[];
  missing: string[];
}

const NOTICE = /\b(notice|NOP|NOC|NOI|NOA|NOD|NOE|hearing|agenda)\b/i;

function parsePassage(f: FactRecord | undefined): { quote?: string; details?: Record<string, string | null> } {
  if (!f?.page_or_passage) return {};
  try {
    return JSON.parse(f.page_or_passage);
  } catch {
    return {};
  }
}

function submissionOf(e: ParticipationRecord): Submission | null {
  const url = e.official_submission_url;
  if (!url) return null;
  const source = (e.details?.submit_source as string | undefined) ?? null;
  if (url.startsWith("mailto:")) {
    const addr = url.slice(7).split("?")[0];
    return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(addr) ? { kind: "email", href: `mailto:${addr}`, display: addr, source } : null;
  }
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? { kind: "portal", href: u.toString(), display: u.hostname, source } : null;
  } catch {
    return null;
  }
}

export function participationGuide(p: ProjectDetail, now: number | Date = Date.now()): Guide {
  const docById = new Map(p.documents.map((d) => [d.id, d]));
  const contactFact = p.facts.filter((f) => f.field === "participation.lead_agency_contact" && f.review_status === "validated").at(-1);
  const cd = parsePassage(contactFact).details ?? null;
  const contact: Contact | null =
    contactFact && cd && (cd.email || cd.phone || cd.address || cd.name)
      ? {
          name: cd.name ?? null,
          title: cd.title ?? null,
          agency: cd.agency ?? null,
          department: cd.department ?? null,
          email: cd.email ?? null,
          phone: cd.phone ?? null,
          address: cd.address ?? null,
          fact: contactFact,
          document: contactFact.document_id ? docById.get(contactFact.document_id) ?? null : null,
        }
      : null;

  const windows: CommentWindow[] = p.participation
    .filter((e) => e.event_type === "comment_period" && e.deadline_at)
    .map((e) => {
      const start = (e.details?.start as string | undefined) ?? null;
      return {
        event: e,
        state: commentState(e.deadline_at!, start, now),
        start,
        deadline: e.deadline_at!,
        daysLeft: daysUntilPacific(e.deadline_at!, now),
        submission: submissionOf(e),
        document: e.source_document_id ? docById.get(e.source_document_id) ?? null : null,
      };
    })
    .sort((a, b) => Date.parse(b.deadline) - Date.parse(a.deadline));
  const rank = { open: 0, upcoming: 1, closed: 2 } as const;
  const comment = [...windows].sort((a, b) => rank[a.state] - rank[b.state] || Date.parse(b.deadline) - Date.parse(a.deadline))[0] ?? null;

  const hearings: Hearing[] = p.participation
    .filter((e) => e.event_type === "hearing" && (e.details?.date || e.deadline_at))
    .map((e) => {
      const date = ((e.details?.date as string | undefined) ?? pacificDate(e.deadline_at!)).slice(0, 10);
      return {
        event: e,
        date,
        upcoming: hearingUpcoming(date, now),
        time: (e.details?.time as string | undefined) ?? null,
        body: (e.details?.body as string | undefined) ?? e.agency_name ?? null,
        location: (e.details?.location as string | undefined) ?? null,
        virtual: (e.details?.virtual as string | undefined) ?? null,
        document: e.source_document_id ? docById.get(e.source_document_id) ?? null : null,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const notices = [...p.documents]
    .sort((a, b) => (b.publication_date ?? b.retrieved_at).localeCompare(a.publication_date ?? a.retrieved_at))
    .sort((a, b) => Number(NOTICE.test(`${b.title} ${b.document_type}`)) - Number(NOTICE.test(`${a.title} ${a.document_type}`)));

  const agency = p.lead_agency ?? comment?.event.agency_name ?? contact?.agency ?? null;
  const department = contact?.department && contact.department !== agency ? contact.department : contact?.agency && contact.agency !== agency ? contact.agency : null;
  const upcomingHearings = hearings.filter((h) => h.upcoming);

  const nextSteps: string[] = [];
  if (comment?.state === "closed") {
    if (p.status === "approved") {
      nextSteps.push("The lead agency has recorded a decision on this project. Contact the agency to ask what approvals or permits remain and how its appeal procedures work.");
    } else {
      nextSteps.push(`The comment period closed on ${formatPacific(comment.deadline, false)}. Comments received are addressed in the agency's later environmental document or staff report.`);
      nextSteps.push("Watch for a final environmental document, a hearing notice, or a decision notice. Each is filed with the State Clearinghouse and will appear here when indexed.");
    }
    if (upcomingHearings.length) nextSteps.push("A public hearing is scheduled (below). Hearings usually accept public testimony; check the agency's notice for how to speak.");
    if (contact?.email || contact?.phone) nextSteps.push("You can still send questions to the agency contact listed below.");
  }

  const missing: string[] = [];
  if (!agency) missing.push("Responsible agency");
  if (!contact) missing.push("Agency contact person, email, phone and mailing address");
  else {
    if (!contact.email) missing.push("Contact email");
    if (!contact.phone) missing.push("Contact phone");
    if (!contact.address) missing.push("Mailing address");
  }
  if (!comment) missing.push("Public comment period and deadline");
  else if (!comment.submission) missing.push("Official submission channel for comments");
  if (!comment?.submission || comment.submission.kind !== "portal") missing.push("Online comment form or portal");
  if (!upcomingHearings.length) missing.push("Upcoming public hearing");

  return { agency, department, contact, comment, earlierComments: windows.filter((w) => w !== comment), hearings: { upcoming: upcomingHearings, past: hearings.filter((h) => !h.upcoming).reverse() }, notices, nextSteps, missing };
}
