/**
 * Live integration tests. Run with the app running:  npm run test:integration
 * (APP_URL defaults to http://localhost:3000). Reads .env.local for Supabase keys.
 * These do NOT spend Bright Data or Gemini credits: the re-ingestion test hits the raw
 * cache + content-hash dedupe and must short-circuit before extraction.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const BASE = process.env.APP_URL ?? "http://localhost:3000";
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const pub = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

interface Summary {
  id: string;
  canonical_name: string;
  latitude: number | null;
  comment_status: string;
}
let projects: Summary[] = [];

beforeAll(async () => {
  const r = await fetch(`${BASE}/api/projects`);
  projects = (await r.json()).projects;
});

describe("Supabase", () => {
  it("connects and queries project records with the server key", async () => {
    const { data, error } = await admin.from("projects").select("id, canonical_name").limit(10);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
  });
  it("blocks privileged writes from the public (publishable) key", async () => {
    const ins = await pub.from("projects").insert({ canonical_name: "rls probe" });
    expect(ins.error?.code).toBe("42501");
    const fact = await pub.from("facts").insert({ field: "x", value: "y" });
    expect(fact.error).not.toBeNull();
    const upd = await pub.from("projects").update({ canonical_name: "hacked" }).neq("id", "00000000-0000-0000-0000-000000000000").select();
    expect(upd.data ?? []).toHaveLength(0);
  });
  it("every document keeps provenance (source URL, hash, retrieval time)", async () => {
    const { data } = await admin.from("documents").select("source_url, content_hash, retrieved_at");
    expect(data!.length).toBeGreaterThan(0);
    for (const d of data!) {
      expect(d.source_url).toMatch(/^https:\/\//);
      expect(d.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(d.retrieved_at).toBeTruthy();
    }
  });
});

describe("API", () => {
  it("lists ≥2 source-backed projects with map geometry", async () => {
    const r = await fetch(`${BASE}/api/projects`);
    const d = await r.json();
    expect(d.projects.length).toBeGreaterThanOrEqual(2);
    expect(d.geojson.features.length).toBeGreaterThanOrEqual(2);
    for (const f of d.geojson.features) {
      const [lng, lat] = f.geometry.coordinates;
      expect(lat).toBeGreaterThan(32);
      expect(lng).toBeLessThan(-114);
    }
  });
  it("returns the selected project's details with documents that link to official sources", async () => {
    const p = projects[0];
    const d = await (await fetch(`${BASE}/api/projects/${p.id}`)).json();
    expect(d.id).toBe(p.id);
    expect(d.canonical_name).toBe(p.canonical_name);
    expect(d.documents.length).toBeGreaterThan(0);
    for (const doc of d.documents) expect(new URL(doc.source_url).hostname).toMatch(/(ca\.gov|legistar\.com)$/);
  });
  it("reports participation status consistently with the stored deadline", async () => {
    for (const p of projects) {
      const d = await (await fetch(`${BASE}/api/projects/${p.id}`)).json();
      const cp = d.participation.find((e: { event_type: string }) => e.event_type === "comment_period");
      if (!cp) {
        expect(p.comment_status).toBe("none");
        continue;
      }
      expect(cp.status).toBe(Date.parse(cp.deadline_at) >= Date.now() ? "open" : "closed");
    }
  });
  it("rejects bad input and unknown ids", async () => {
    expect((await fetch(`${BASE}/api/projects/not-a-uuid`)).status).toBe(400);
    expect((await fetch(`${BASE}/api/projects/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    const ask = await fetch(`${BASE}/api/ask`, { method: "POST", body: JSON.stringify({ projectId: projects[0].id, question: "hi" }) });
    expect(ask.status).toBe(400);
  });
  it("exports JSON and GeoJSON", async () => {
    const j = await (await fetch(`${BASE}/api/projects/${projects[0].id}/export?format=json`)).json();
    expect(j.project.id).toBe(projects[0].id);
    expect(Array.isArray(j.facts)).toBe(true);
    const g = await (await fetch(`${BASE}/api/export`)).json();
    expect(g.type).toBe("FeatureCollection");
    expect(g.features.length).toBe(projects.filter((p) => p.latitude !== null).length);
  });
});

describe("Ingestion security & dedupe", () => {
  const url = "https://ceqanet.lci.ca.gov/2026070839";
  it("requires the admin token", async () => {
    const r = await fetch(`${BASE}/api/ingest`, { method: "POST", body: JSON.stringify({ mode: "url", url }) });
    expect(r.status).toBe(401);
    const bad = await fetch(`${BASE}/api/ingest`, { method: "POST", headers: { Authorization: "Bearer wrong-token-wrong-token" }, body: JSON.stringify({ mode: "url", url }) });
    expect(bad.status).toBe(401);
  });
  it("refuses non-allowlisted and internal URLs", async () => {
    for (const target of ["https://example.com/", "http://169.254.169.254/latest", "https://localhost:3000/api/projects"]) {
      const r = await fetch(`${BASE}/api/ingest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.INGEST_ADMIN_TOKEN}` },
        body: JSON.stringify({ mode: "url", url: target }),
      });
      expect(r.status).toBe(400);
    }
  });
  it("re-ingesting an already-stored source is a no-op (no duplicates, no model call)", async () => {
    const before = await admin.from("documents").select("id", { count: "exact", head: true });
    const r = await fetch(`${BASE}/api/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.INGEST_ADMIN_TOKEN}` },
      body: JSON.stringify({ mode: "url", url }),
    });
    const report = await r.json();
    expect(report.outcome).toBe("unchanged");
    expect(report.steps.some((s: { step: string }) => s.step === "extract")).toBe(false);
    expect(report.usage.gemini.calls).toBe(0);
    const after = await admin.from("documents").select("id", { count: "exact", head: true });
    expect(after.count).toBe(before.count);
  });
});
