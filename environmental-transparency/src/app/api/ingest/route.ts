import { connection } from "next/server";
import { z } from "zod";
import { hostAllowed } from "@/lib/config";
import { isAdmin, json } from "@/lib/http";
import { runIngestion } from "@/lib/pipeline/ingest";
import { listObjects, getJson } from "@/lib/storage";

export const maxDuration = 300;

const body = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("url"),
    url: z
      .string()
      .url()
      .max(500)
      .refine((u) => hostAllowed(new URL(u)), "URL must be an https URL on the official-source allowlist"),
    force: z.boolean().optional(),
    maxDocs: z.number().int().min(1).max(5).optional(),
  }),
  z.object({
    mode: z.literal("discover"),
    query: z.string().min(8).max(200),
    force: z.boolean().optional(),
    maxDocs: z.number().int().min(1).max(5).optional(),
  }),
]);

/** POST /api/ingest — authorized, targeted ingestion of one official source. */
export async function POST(req: Request) {
  if (!isAdmin(req)) return json({ error: "Unauthorized" }, 401);
  let input: z.infer<typeof body>;
  try {
    input = body.parse(await req.json());
  } catch (err) {
    return json({ error: "Invalid request", issues: err instanceof z.ZodError ? err.issues : String(err) }, 400);
  }
  try {
    const report = await runIngestion(input);
    const status = report.outcome === "failed" ? 502 : report.outcome === "rejected" ? 422 : 200;
    return json(report, status);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
}

/** GET /api/ingest — recent ingestion run summaries (public, no secrets). */
export async function GET() {
  await connection();
  const files = await listObjects("runs", 8).catch(() => []);
  const runs = await Promise.all(
    files.filter((f) => f.name.endsWith(".json")).map((f) => getJson<Record<string, unknown>>(`runs/${f.name}`)),
  );
  return json(
    runs.filter(Boolean).map((r) => ({
      runId: r!.runId,
      startedAt: r!.startedAt,
      finishedAt: r!.finishedAt,
      outcome: r!.outcome,
      projectId: r!.projectId,
      projectName: r!.projectName,
      validation: r!.validation,
      usage: r!.usage,
      error: r!.error,
      steps: (r!.steps as { step: string; ok: boolean; detail: string; ms: number }[]).map(({ step, ok, detail, ms }) => ({ step, ok, detail, ms })),
    })),
  );
}
