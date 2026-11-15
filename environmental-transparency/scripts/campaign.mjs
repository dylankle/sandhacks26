#!/usr/bin/env node
/**
 * Controls the statewide California indexing campaign on the running app (protected API).
 *
 *   npm run campaign -- create --from 2025-11-15 --to 2026-11-15 --max-requests 2489 --max-usd 20 \
 *                              --pilot-requests 100 --pilot-gemini 150 --pilot-enrichments 75
 *   npm run campaign -- run          # steps until the campaign pauses itself (pilot cap, budget, done)
 *   npm run campaign -- report
 *   npm run campaign -- approve --requests 2389 --gemini 1500 --enrichments 800
 *   npm run campaign -- pause | resume
 *   npm run campaign -- backfill-participation       # comment windows + contacts from cached exports
 *   npm run campaign -- cleanup                      # deterministic name/description/encoding cleanup
 *   npm run campaign -- summarize --max-gemini 20    # grounded summaries for records without one
 *   options: --host http://localhost:3000  --step-ms 240000
 *
 * The server enforces every cap; this script only drives bounded steps one at a time.
 */
import { readFileSync } from "node:fs";

const [cmd, ...args] = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const num = (name, dflt) => {
  const v = opt(name);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
};

function token() {
  if (process.env.INGEST_ADMIN_TOKEN) return process.env.INGEST_ADMIN_TOKEN;
  try {
    const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("INGEST_ADMIN_TOKEN="));
    return line?.slice("INGEST_ADMIN_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

const host = opt("host", "http://localhost:3000");
const t = token();
if (!t) {
  console.error("INGEST_ADMIN_TOKEN not found in env or .env.local");
  process.exit(1);
}
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${t}` };

async function post(body) {
  const res = await fetch(`${host}/api/campaign`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(900_000) });
  const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}
async function report() {
  const res = await fetch(`${host}/api/campaign`, { headers });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

function printReport(r) {
  const b = r.budget;
  console.log(`\nCampaign ${r.campaign.id} — ${r.campaign.status}${r.campaign.statusReason ? ` (${r.campaign.statusReason})` : ""}`);
  console.log(`  Bright Data: ${b.consumed.requests} requests (basis: ${b.consumed.basis}; ledger SERP ${b.consumed.ledger.serp} / Unlocker ${b.consumed.ledger.unlocker}; account Δ ${b.consumed.account?.requests ?? "n/a"}) · $${b.consumed.usd} · phase cap ${b.caps.phaseRequests} · campaign cap ${b.caps.requests} / $${b.caps.usd}`);
  console.log(`  Discovery: ${r.discovery.feedWindowsDone}/${r.discovery.feedWindows} export windows (${r.discovery.directOfficialRequests} direct requests) · ${r.discovery.filings} filings · ${r.discovery.uniqueProjects} unique projects · ${r.discovery.relevant} relevant (${r.discovery.relevantActive} active)`);
  console.log(`  Lightweight: ${r.lightweight.indexed} indexed (${r.lightweight.created} new, ${r.lightweight.updatedExisting} existing updated) · ${r.lightweight.mapReady} map-ready · ${r.lightweight.notMapped} not mapped`);
  console.log(`  Enrichment: CEQAnet ${r.enrichment.ceqaEnriched} ok / ${r.enrichment.ceqaRejected} rejected / ${r.enrichment.ceqaFailed} failed · municipal ${r.enrichment.municipalLinked} linked of ${r.enrichment.municipalSearched} searched · Gemini ${r.enrichment.geminiCalls} calls`);
  console.log(`  Efficiency: ${r.efficiency.requestsPerUsableProject ?? "—"} req/usable project · ${r.efficiency.requestsPerMunicipalSearch ?? "—"} req/municipal search · ${r.efficiency.requestsPerLinkedMunicipalRecord ?? "—"} req/linked record`);
  console.log(`  Capacity left: ${r.capacity.requestsRemaining} requests ≈ ${r.capacity.estimatedMunicipalSearches ?? "?"} searches ≈ ${r.capacity.estimatedLinkedRecords ?? "?"} linked records · queue ${JSON.stringify(r.queue)}`);
}

try {
  if (cmd === "create") {
    printReport(
      await post({
        action: "create",
        from: opt("from"),
        to: opt("to"),
        maxRequests: num("max-requests"),
        maxUsd: num("max-usd"),
        pilotRequests: num("pilot-requests", 100),
        pilotGeminiCalls: num("pilot-gemini", 150),
        pilotEnrichments: num("pilot-enrichments", 75),
      }),
    );
  } else if (cmd === "run") {
    const stepMs = num("step-ms", 240_000);
    for (let i = 1; ; i++) {
      const r = await post({ action: "step", maxMs: stepMs });
      console.log(`step ${i}: ${r.tasksRun} tasks, ${r.brightDataThisStep} Bright Data requests → ${r.status}${r.statusReason ? ` (${r.statusReason})` : ""} · queue ${JSON.stringify(r.remainingTasks)}`);
      if (r.status !== "running") break;
      if (r.tasksRun === 0) await new Promise((res) => setTimeout(res, 20_000)); // only retry-delayed tasks left
    }
    printReport(await report());
  } else if (cmd === "report") {
    const r = await report();
    if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else printReport(r);
  } else if (cmd === "approve") {
    printReport(await post({ action: "approve", requests: num("requests"), geminiCalls: num("gemini"), enrichments: num("enrichments") }));
  } else if (cmd === "backfill-participation") {
    console.log(JSON.stringify(await post({ action: "backfill_participation" }), null, 2));
  } else if (cmd === "cleanup") {
    console.log(JSON.stringify(await post({ action: "cleanup" }), null, 2));
  } else if (cmd === "summarize") {
    console.log(JSON.stringify(await post({ action: "summarize", maxMs: num("max-ms", 240_000), maxGeminiCalls: num("max-gemini", 20) }), null, 2));
  } else if (cmd === "pause" || cmd === "resume") {
    printReport(await post({ action: cmd }));
  } else {
    console.error("Usage: npm run campaign -- create|run|report|approve|pause|resume|cleanup|summarize|backfill-participation [options]");
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
