/**
 * Prepares retrieved document text for the model: documents longer than the budget keep their
 * opening (project description, summary) plus the highest-signal passages from the remainder.
 */

const SIGNAL = /\b(comment|review period|hearing|deadline|megawatt|MW\b|gallons|acre-feet|generator|diesel|emission|NOx|PM2\.5|significant|mitigation|square feet|noise|dBA|trips|water|energy|school|residen|million|billion|cost|investment|applicant|developer|council|commission|board|motion|vote|ayes|approved)|\$\s?\d/gi;

export function fitToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = text.slice(0, Math.floor(budget * 0.6));
  const rest = text.slice(head.length);
  const paras = rest.split(/\n{2,}|(?=\[page \d+\])/);
  const scored = paras
    .map((p, i) => ({ i, p, score: (p.match(SIGNAL)?.length ?? 0) / Math.sqrt(p.length + 50) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  let remaining = budget - head.length;
  const picked: { i: number; p: string }[] = [];
  for (const s of scored) {
    if (s.p.length > remaining) continue;
    picked.push(s);
    remaining -= s.p.length + 8;
    if (remaining < 500) break;
  }
  picked.sort((a, b) => a.i - b.i);
  return `${head}\n\n[… excerpted passages …]\n\n${picked.map((x) => x.p).join("\n\n")}`;
}
