/**
 * Participation records derived from structured State Clearinghouse filing fields, in the same
 * shape the document pipeline produces (participation_events + linked detail fact + agency contact).
 * Nothing is inferred: a comment window exists only if the filing states its end date, and a contact
 * only if the filing lists one. Pure module.
 */
import { endOfDayPacific } from "@/lib/pipeline/validate";
import { formatPhone, type CeqaFiling } from "@/lib/campaign/ceqa-feed";

export interface DerivedComment {
  filing: CeqaFiling;
  start: string | null;
  end: string;
  deadlineAt: string;
  submissionUrl: string | null;
  quote: string;
}

export interface DerivedContact {
  filing: CeqaFiling;
  details: { name: string | null; title: string | null; agency: string | null; department: string | null; types: string; email: string | null; phone: string | null; address: string | null };
  quote: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

/** Latest filing that lists a contact person or channel (filings are oldest → newest). */
export function contactFromFilings(filings: CeqaFiling[]): DerivedContact | null {
  const f = [...filings].reverse().find((x) => x.contact.email || x.contact.phone || x.contact.address);
  if (!f) return null;
  const email = f.contact.email && EMAIL.test(f.contact.email) ? f.contact.email : null;
  const details = {
    name: f.contact.name,
    title: f.contact.title,
    agency: f.leadAgency || null,
    department: f.contact.department && f.contact.department !== f.leadAgency ? f.contact.department : null,
    types: "Lead/Public Agency",
    email,
    phone: formatPhone(f.contact.phone),
    address: f.contact.address,
  };
  const quote = [details.name, details.title, f.contact.department, email, f.contact.phone, details.address].filter(Boolean).join(" · ");
  return { filing: f, details, quote };
}

/** Every comment window stated in the filings (one per distinct end date), newest first. */
export function commentsFromFilings(filings: CeqaFiling[], contact: DerivedContact | null): DerivedComment[] {
  const seen = new Set<string>();
  const out: DerivedComment[] = [];
  for (const f of [...filings].reverse()) {
    const end = f.publicReview.end;
    if (!end || seen.has(end)) continue;
    seen.add(end);
    out.push({
      filing: f,
      start: f.publicReview.start,
      end,
      deadlineAt: endOfDayPacific(end),
      // The filing's own contact email is the stated channel; never one borrowed from another filing.
      submissionUrl: f.contact.email && EMAIL.test(f.contact.email) ? `mailto:${f.contact.email}` : contact?.filing === f && contact.details.email ? `mailto:${contact.details.email}` : null,
      quote: `NOC Public Review Start Date: ${f.raw["NOC Public Review Start Date"] ?? "—"} · NOC Public Review End Date: ${f.raw["NOC Public Review End Date"] ?? end}`,
    });
  }
  return out;
}
