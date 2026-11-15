import { z } from "zod";
import { getProject } from "@/lib/data/projects";
import { searchEvidence } from "@/lib/evidence";
import { answerQuestion, ModelOutputError } from "@/lib/gemini";
import { UUID, json, rateLimit, withinDailyModelBudget } from "@/lib/http";
import { getJson, putJson, sha256 } from "@/lib/storage";

export const maxDuration = 120;

const body = z.object({
  projectId: z.string().regex(UUID),
  question: z.string().trim().min(8).max(300),
});

/** POST /api/ask — answers a question using only the project's stored source passages. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  const { projectId, question } = parsed.data;

  const project = await getProject(projectId);
  if (!project) return json({ error: "Project not found" }, 404);

  // Answers are cached per project + question + evidence set, so repeat clicks cost nothing.
  const evidenceKey = project.documents.map((d) => d.content_hash).join(",");
  const cacheKey = `answers/${projectId}/${sha256(`${question.toLowerCase()}|${evidenceKey}`)}.json`;
  const cached = await getJson(cacheKey);
  if (cached) return json({ ...cached, cached: true });

  if (!rateLimit(req, "ask", 6) || !withinDailyModelBudget()) {
    return json({ error: "Rate limit reached. Please wait a minute and try again." }, 429);
  }

  const passages = await searchEvidence(project, question);
  if (passages.length === 0) {
    const result = {
      answer: "The retrieved records for this project don't contain passages about this question.",
      answerable: false,
      citations: [],
      not_in_record: question,
      passages: [],
    };
    return json(result);
  }
  try {
    const out = await answerQuestion(project.canonical_name, question, passages);
    const result = { ...out, passages: passages.filter((p) => out.citations.includes(p.id)), generated_at: new Date().toISOString() };
    await putJson(cacheKey, result).catch(() => undefined);
    return json(result);
  } catch (err) {
    const msg = err instanceof ModelOutputError ? err.message : "Answer generation failed";
    return json({ error: msg }, 502);
  }
}
