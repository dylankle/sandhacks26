/**
 * Deterministic cleanup of stored records and grounding checks for generated summaries.
 * Cleanup only changes presentation (case, whitespace, encoding artifacts); it never rewrites
 * the substance of an official title or description. Pure module.
 */
import { fixC1 } from "@/lib/campaign/ceqa-feed";

const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "via", "with"]);
/** Tokens kept upper-case when title-casing an ALL-CAPS title. */
const KEEP_UPPER = /^(?:[IVX]+|U\.S\.|US|SR|CA|LLC|LP|BESS|PV|EIR|MND|NOP|CUP|APN|DRC|LAX|SFO|HVAC|MW|KV|II|III|IV|[A-Z]{1,4}\d[\w-]*|\d[\w-]*|[A-Z]+-\d[\w-]*)$/;

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/(\s+|\/|-)/)
    .map((w, i, all) => {
      const up = w.toUpperCase();
      if (KEEP_UPPER.test(up)) return up;
      if (i > 0 && SMALL.has(w) && all[i - 1] !== "/") return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join("");
}

export function cleanName(name: string): string {
  let s = fixC1(name).replace(/^\W*withdrawn per lead\W*/i, "").replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 6 && letters === letters.toUpperCase()) s = titleCase(s);
  return s;
}

/** Collapses runs of spaces/tabs and stray CRs; keeps paragraph breaks. */
export function cleanDescription(d: string): string {
  return fixC1(d)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "Winston Solar Project by Winston Solar, LLC" → "Winston Solar, LLC" (only an explicit "by <entity>" suffix). */
export function developerFromTitle(title: string): string | null {
  const m = title.match(/\bby\s+([A-Z0-9][^()]*?(?:,?\s*(?:LLC|L\.L\.C\.|Inc\.?|LP|L\.P\.|Corporation|Corp\.?|Company)))\.?(?:\s*\(([^)]+)\))?\s*$/);
  return m ? m[1].trim() : null;
}

/** Numbers as written (digits, separators, decimals) normalized for comparison. */
const numbersIn = (s: string) => [...s.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "").replace(/\.0+$/, ""));

export interface GroundingVerdict {
  ok: boolean;
  problems: string[];
}

/**
 * A generated summary is kept only if every number it states appears in the source material,
 * it makes no health claims, and it is 1–4 sentences. Anything else is discarded, never patched.
 */
export function checkSummary(summary: string, source: string): GroundingVerdict {
  const problems: string[] = [];
  const src = new Set(numbersIn(source));
  for (const n of numbersIn(summary)) if (!src.has(n)) problems.push(`number "${n}" not in source`);
  if (/\b(health|cancer|asthma|disease|illness|dangerous|toxic|harmful|unsafe)\b/i.test(summary)) problems.push("health or harm claim");
  const sentences = summary.split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;
  if (sentences < 1 || sentences > 4 || summary.length > 700) problems.push(`length (${sentences} sentences, ${summary.length} chars)`);
  return { ok: problems.length === 0, problems };
}
