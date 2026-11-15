/**
 * Decides whether a document found by search is about a specific indexed project. Search ranking is
 * never trusted on its own: the document text must contain an official identifier of the project.
 * Pure module.
 */
import { normalizeForMatch } from "@/lib/pipeline/validate";

export interface ProjectIdentity {
  sch: string;
  title: string;
  caseNumbers: string[];
  places: string[];
}

export interface LinkVerdict {
  linked: boolean;
  basis: "sch_number" | "case_number" | "title_and_place" | null;
  quote: string | null;
}

function around(text: string, index: number, len: number) {
  const a = Math.max(0, text.lastIndexOf(" ", Math.max(0, index - 90)));
  const b = text.indexOf(" ", Math.min(text.length, index + len + 90));
  return text.slice(a, b < 0 ? text.length : b).replace(/\s+/g, " ").trim();
}

const STOP = new Set(["the", "of", "and", "project", "a", "an", "at", "for", "to", "in", "on"]);

export function linkDocumentToProject(text: string, id: ProjectIdentity): LinkVerdict {
  // SCH numbers are written 2026050302, 2026-05-0302, or "SCH# 2026050302".
  const schRe = new RegExp(`\\b${id.sch.slice(0, 4)}[-\\s]?${id.sch.slice(4, 6)}[-\\s]?${id.sch.slice(6)}\\b`);
  const m = schRe.exec(text);
  if (m) return { linked: true, basis: "sch_number", quote: around(text, m.index, m[0].length) };

  for (const c of id.caseNumbers) {
    if (c.length < 6 || !/\d/.test(c) || !/[a-z]/i.test(c)) continue; // bare numbers are too ambiguous
    const i = text.indexOf(c);
    if (i >= 0) return { linked: true, basis: "case_number", quote: around(text, i, c.length) };
  }

  const words = normalizeForMatch(id.title).split(" ").filter((w) => !STOP.has(w));
  if (words.length >= 3 && id.title.length >= 18) {
    const normText = normalizeForMatch(text);
    const normTitle = normalizeForMatch(id.title);
    const place = id.places.map(normalizeForMatch).find((p) => p.length >= 4 && normText.includes(p));
    if (normText.includes(normTitle) && place) {
      // Quote from the original text: find the title case-insensitively.
      const loose = new RegExp(id.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "i").exec(text);
      return { linked: true, basis: "title_and_place", quote: loose ? around(text, loose.index, loose[0].length) : id.title };
    }
  }
  return { linked: false, basis: null, quote: null };
}
