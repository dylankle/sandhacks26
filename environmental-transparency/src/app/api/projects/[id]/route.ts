import { connection } from "next/server";
import { getProject } from "@/lib/data/projects";
import { UUID, json } from "@/lib/http";

/** GET /api/projects/[id] — full source-backed record. */
export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  await connection();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json({ error: "Invalid project id" }, 400);
  const project = await getProject(id);
  if (!project) return json({ error: "Not found" }, 404);
  return json(project);
}
