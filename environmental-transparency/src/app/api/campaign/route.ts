import { connection } from "next/server";
import { z } from "zod";
import { isAdmin, json } from "@/lib/http";
import { approvePhase, createCampaign, pauseCampaign, resumeCampaign, runStep } from "@/lib/campaign/runner";
import { campaignReport } from "@/lib/campaign/report";
import { backfillParticipation, cleanupRecords, summarizeMissing } from "@/lib/campaign/postprocess";
import { currentCampaignId } from "@/lib/campaign/store";

export const maxDuration = 300;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    from: isoDate,
    to: isoDate,
    maxRequests: z.number().int().min(1).max(10_000),
    maxUsd: z.number().positive().max(1000),
    pilotRequests: z.number().int().min(0),
    pilotGeminiCalls: z.number().int().min(0).max(5000),
    pilotEnrichments: z.number().int().min(0).max(5000),
  }),
  z.object({ action: z.literal("step"), id: z.string().optional(), maxMs: z.number().int().min(10_000).max(270_000).optional() }),
  z.object({
    action: z.literal("approve"),
    id: z.string().optional(),
    requests: z.number().int().min(1),
    geminiCalls: z.number().int().min(0),
    enrichments: z.number().int().min(0),
  }),
  z.object({ action: z.literal("pause"), id: z.string().optional() }),
  z.object({ action: z.literal("cleanup") }),
  z.object({ action: z.literal("backfill_participation") }),
  z.object({ action: z.literal("summarize"), maxMs: z.number().int().min(10_000).max(600_000).optional(), maxGeminiCalls: z.number().int().min(1).max(200).optional() }),
  z.object({ action: z.literal("resume"), id: z.string().optional() }),
]);

let stepping = false;

/** POST /api/campaign — protected control of the statewide indexing campaign. */
export async function POST(req: Request) {
  if (!isAdmin(req)) return json({ error: "Unauthorized" }, 401);
  let input: z.infer<typeof body>;
  try {
    input = body.parse(await req.json());
  } catch (err) {
    return json({ error: "Invalid request", issues: err instanceof z.ZodError ? err.issues : String(err) }, 400);
  }
  try {
    if (input.action === "cleanup") return json(await cleanupRecords());
    if (input.action === "backfill_participation") return json(await backfillParticipation());
    if (input.action === "summarize") return json(await summarizeMissing({ maxMs: input.maxMs ?? 240_000, maxGeminiCalls: input.maxGeminiCalls ?? 40 }));
    if (input.action === "create") return json(await campaignReport((await createCampaign(input)).config.id));
    const id = input.id ?? (await currentCampaignId());
    if (!id) return json({ error: "No campaign" }, 404);
    if (input.action === "step") {
      if (stepping) return json({ error: "A step is already running in this server" }, 409);
      stepping = true;
      try {
        const r = await runStep(id, { maxMs: input.maxMs ?? 240_000 });
        return json(r);
      } finally {
        stepping = false;
      }
    }
    if (input.action === "approve") await approvePhase(id, input);
    if (input.action === "pause") await pauseCampaign(id, "Paused by operator");
    if (input.action === "resume") await resumeCampaign(id);
    return json(await campaignReport(id));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
}

/** GET /api/campaign — campaign report (protected: includes budget details). */
export async function GET(req: Request) {
  await connection();
  if (!isAdmin(req)) return json({ error: "Unauthorized" }, 401);
  const id = new URL(req.url).searchParams.get("id") ?? (await currentCampaignId());
  if (!id) return json({ error: "No campaign" }, 404);
  try {
    return json(await campaignReport(id));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 404);
  }
}
