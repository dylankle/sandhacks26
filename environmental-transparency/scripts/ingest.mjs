#!/usr/bin/env node
/**
 * Triggers a protected ingestion on the running app.
 *
 *   npm run ingest -- --url https://ceqanet.lci.ca.gov/2026070839
 *   npm run ingest -- --discover "santaclara.legistar.com data center mitigated negative declaration"
 *   options: --force (bypass cache/dedupe)  --max-docs 3  --host http://localhost:3000
 *
 * Reads INGEST_ADMIN_TOKEN from the environment or .env.local; the token never leaves this machine
 * except as the Authorization header to the host you specify.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

function token() {
  if (process.env.INGEST_ADMIN_TOKEN) return process.env.INGEST_ADMIN_TOKEN;
  try {
    const line = readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("INGEST_ADMIN_TOKEN="));
    return line?.slice("INGEST_ADMIN_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

const host = opt("host") ?? "http://localhost:3000";
const url = opt("url");
const query = opt("discover");
if (!url && !query) {
  console.error("Usage: npm run ingest -- --url <official url> | --discover \"<search query>\" [--force] [--max-docs N]");
  process.exit(1);
}
const t = token();
if (!t) {
  console.error("INGEST_ADMIN_TOKEN not found in env or .env.local");
  process.exit(1);
}

const body = url ? { mode: "url", url } : { mode: "discover", query };
if (flag("force")) body.force = true;
if (opt("max-docs")) body.maxDocs = Number(opt("max-docs"));

const ICON = { true: "✔", false: "✖" };
console.log(`→ POST ${host}/api/ingest`, JSON.stringify(body));
const started = Date.now();
const res = await fetch(`${host}/api/ingest`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
  body: JSON.stringify(body),
});
const report = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
if (report.steps) {
  for (const s of report.steps) console.log(`  ${ICON[s.ok]} ${s.step.padEnd(9)} ${s.detail}  (${(s.ms / 1000).toFixed(1)}s)`);
}
if (report.validation?.issues?.length) {
  console.log("  validation issues:");
  for (const i of report.validation.issues) console.log(`    - [${i.level}] ${i.message}`);
}
console.log(`\nOutcome: ${report.outcome ?? "error"}${report.projectName ? ` — ${report.projectName}` : ""}${report.projectId ? ` (${report.projectId})` : ""}`);
if (report.usage) console.log(`Usage: Bright Data SERP ${report.usage.brightData.serp}, Unlocker ${report.usage.brightData.unlocker}; Gemini calls ${report.usage.gemini.calls}`);
if (report.error) console.log(`Error: ${report.error}`);
console.log(`Elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(res.ok ? 0 : 1);
