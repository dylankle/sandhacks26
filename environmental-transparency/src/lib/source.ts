/**
 * The official record a project traces back to: one stable ID plus a government URL.
 * Pure module, shared by the data layer, exports, and client components.
 *
 * Preference order:
 *   1. State Clearinghouse number → its CEQAnet page (permanent, statewide, one per project).
 *   2. The earliest retrieved official document, labelled with a local case/file number if one was extracted.
 */

export interface PrimarySource {
  /** Human-readable identifier, e.g. "SCH 2024070671" or "PDC24-012". Null if none is known. */
  id: string | null;
  /** Government page for the original filing or posting. */
  url: string | null;
  /** Where the ID comes from, e.g. "State Clearinghouse (CEQAnet)". */
  label: string;
}

export const ceqanetUrl = (sch: string) => `https://ceqanet.lci.ca.gov/${encodeURIComponent(sch)}`;

export function primarySource(input: {
  sch_number: string | null;
  /** Documents in retrieval order (earliest first). */
  documents?: { source_url: string; retrieved_at?: string | null }[];
  case_numbers?: (string | null)[];
}): PrimarySource {
  const sch = input.sch_number?.trim();
  if (sch && /^\d{10}$/.test(sch)) return { id: `SCH ${sch}`, url: ceqanetUrl(sch), label: "State Clearinghouse (CEQAnet)" };

  const docs = [...(input.documents ?? [])].sort((a, b) => (Date.parse(a.retrieved_at ?? "") || 0) - (Date.parse(b.retrieved_at ?? "") || 0));
  const url = docs.find((d) => /^https?:\/\//.test(d.source_url))?.source_url ?? null;
  const caseNo = input.case_numbers?.find((c) => c && c.trim())?.trim() ?? null;
  let host: string | null = null;
  try {
    host = url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    /* malformed URL */
  }
  return { id: caseNo, url, label: caseNo ? "Agency case / file number" : host ? `Original posting (${host})` : "No official source recorded" };
}
