import "server-only";
import { documentTextPath, getObject } from "@/lib/storage";
import type { ProjectDetail } from "@/types/project";
import type { Passage } from "@/lib/gemini";

const STOP = new Set("a an the of and or to in on for is are be will would what how does do this that with by from at as it its project".split(" "));
const terms = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));

const SYNONYMS: Record<string, string[]> = {
  air: ["emissions", "diesel", "nox", "pm2.5", "particulate", "pollutant", "toxic", "baaqmd"],
  water: ["gallons", "cooling", "potable", "recycled", "acre-feet", "stormwater"],
  energy: ["megawatts", "mw", "electricity", "power", "substation", "generators", "kilovolt"],
  noise: ["dba", "decibel", "sound", "wall"],
  traffic: ["trips", "vmt", "vehicle", "trucks", "parking", "transportation"],
  schools: ["school", "students", "sensitive", "receptors"],
  health: ["risk", "cancer", "sensitive", "receptors", "toxic"],
  jobs: ["employees", "jobs", "employment"],
};

function expand(q: string[]): string[] {
  const out = new Set(q);
  for (const t of q) for (const [k, v] of Object.entries(SYNONYMS)) if (t.startsWith(k) || v.includes(t)) v.concat(k).forEach((x) => out.add(x));
  return [...out];
}

interface Chunk {
  text: string;
  page: number | null;
  docTitle: string;
  url: string;
}

function chunkDoc(text: string, docTitle: string, url: string): Chunk[] {
  const out: Chunk[] = [];
  const parts = text.split(/\[page (\d+)\]/);
  const pages: { page: number | null; text: string }[] =
    parts.length > 2 ? Array.from({ length: (parts.length - 1) / 2 }, (_, i) => ({ page: Number(parts[i * 2 + 1]), text: parts[i * 2 + 2] })) : [{ page: null, text }];
  for (const p of pages) {
    const sentences = p.text.replace(/\s+/g, " ").split(/(?<=[.;:])\s+(?=[A-Z0-9(])/);
    let buf = "";
    for (const s of sentences) {
      if ((buf + s).length > 700 && buf) {
        out.push({ text: buf.trim(), page: p.page, docTitle, url });
        buf = "";
      }
      buf += s + " ";
    }
    if (buf.trim().length > 40) out.push({ text: buf.trim(), page: p.page, docTitle, url });
  }
  return out;
}

/** Keyword retrieval over the stored text of a project's documents. */
export async function searchEvidence(project: ProjectDetail, question: string, k = 8): Promise<Passage[]> {
  const q = expand(terms(question));
  const chunks: Chunk[] = [];
  for (const d of project.documents) {
    if (!d.content_hash) continue;
    const buf = await getObject(documentTextPath(d.content_hash));
    if (buf) chunks.push(...chunkDoc(buf.toString("utf8"), d.title ?? "Source document", d.source_url));
  }
  const scored = chunks
    .map((c) => {
      const low = c.text.toLowerCase();
      let score = 0;
      for (const t of q) {
        const n = low.split(t).length - 1;
        if (n) score += 1 + Math.log(n);
      }
      if (/\d/.test(c.text)) score *= 1.1;
      return { c, score: score / Math.sqrt(1 + c.text.length / 700) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored.map((x, i) => ({ id: `P${i + 1}`, text: x.c.text, documentTitle: x.c.docTitle, sourceUrl: x.c.url, page: x.c.page }));
}
