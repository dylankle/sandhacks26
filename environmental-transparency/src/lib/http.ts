import "server-only";
import { timingSafeEqual } from "node:crypto";

export function json(data: unknown, init?: number | ResponseInit) {
  return Response.json(data, typeof init === "number" ? { status: init } : init);
}

/** Bearer-token check for privileged routes (constant-time). */
export function isAdmin(req: Request): boolean {
  const expected = process.env.INGEST_ADMIN_TOKEN;
  if (!expected || expected.length < 16) return false;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const buckets = new Map<string, { tokens: number; at: number }>();

/** Small in-memory token bucket per client+route to keep AI endpoints from uncontrolled use. */
export function rateLimit(req: Request, route: string, perMinute: number): boolean {
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const key = `${route}:${ip}`;
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

/** Global daily ceiling on model calls from public endpoints. */
let day = new Date().toDateString();
let publicModelCalls = 0;
export function withinDailyModelBudget(limit = Number(process.env.PUBLIC_AI_DAILY_LIMIT ?? 300)): boolean {
  const today = new Date().toDateString();
  if (today !== day) {
    day = today;
    publicModelCalls = 0;
  }
  if (publicModelCalls >= limit) return false;
  publicModelCalls++;
  return true;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
