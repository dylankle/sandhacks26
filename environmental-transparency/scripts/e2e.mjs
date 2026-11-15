#!/usr/bin/env node
/**
 * End-to-end UI check against a running app (default http://localhost:3000).
 *   npm run test:e2e            (set APP_URL / CHROME_PATH to override)
 * Uses Gemini for one Q&A answer and one draft (both rate-limited; Q&A answers are cached).
 * Screenshots are written to ./e2e-artifacts/.
 */
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { chromium } from "playwright-core";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const OUT = "e2e-artifacts";
mkdirSync(OUT, { recursive: true });
const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  `${homedir()}/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error("No Chrome found; set CHROME_PATH");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const api = await (await fetch(`${BASE}/api/projects`)).json();
const M = (fn, arg) => page.evaluate(fn, arg);
const mapReady = async () => {
  await page.waitForFunction(() => window.__imbyMap?.getSource("projects") && window.__imbyMap.loaded(), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
};

// 0. Landing: introduction, statistics, and a city/county prompt; no map until a place is chosen
await page.goto(BASE, { waitUntil: "load" });
const landingTitle = page.getByRole("heading", { level: 1, name: /What.s being built near you/ });
await landingTitle.waitFor({ timeout: 30000 });
check("starts on the landing screen with the introduction", (await landingTitle.count()) === 1 && (await M(() => !window.__imbyMap)));
await page.getByText(api.projects.length.toLocaleString(), { exact: true }).first().waitFor({ timeout: 30000 });
check("landing shows development statistics from stored records", await page.getByText("developments tracked").isVisible(), `${api.projects.length} tracked`);
const prompt = page.getByRole("combobox", { name: /Where do you live/ });
await prompt.fill("Atlantis");
await page.getByRole("button", { name: /Show projects/ }).click();
check("unknown places are reported, not guessed", /couldn.t find/i.test((await page.locator("form [role=alert]").textContent()) ?? ""));
await prompt.fill("san jos");
await page.getByRole("option", { name: /San Jose/ }).first().waitFor({ timeout: 5000 });
await prompt.fill("San José");
await page.getByRole("button", { name: /Show projects/ }).click();
await mapReady();
const sj = await M(() => window.__imbyMap.getBounds().contains([-121.89, 37.34]) && window.__imbyMap.getZoom() > 9);
check("entering a city opens the map framed on that city", sj && new URL(page.url()).searchParams.get("place") === "0668000", page.url());
check("home view has no introduction text; it names the chosen place", (await page.getByText(/What.s being built near you/).count()) === 0 && /San Jose/.test((await page.locator("aside h1").textContent()) ?? ""));
await page.screenshot({ path: `${OUT}/0-city.png` });
await page.reload({ waitUntil: "load" });
await mapReady();
check("the chosen place survives a reload (shareable URL)", /San Jose/.test((await page.locator("aside h1").textContent()) ?? ""));
await page.getByRole("button", { name: "Change", exact: true }).click();
await landingTitle.waitFor({ timeout: 10000 });
await page.getByRole("button", { name: /browse all of California/i }).click();
await mapReady();

const vis = (id) => M((l) => window.__imbyMap.getLayoutProperty(l, "visibility") ?? "visible", id);
const layerIndex = (id) => M((l) => window.__imbyMap.getStyle().layers.findIndex((x) => x.id === l), id);

// 1. Category landmark markers render from stored records; Explore view is uncluttered
// Statewide markers cluster at low zoom: count individual sites plus the sites inside each cluster.
const rendered = await M(() => {
  const seen = new Map();
  for (const f of window.__imbyMap.querySourceFeatures("projects")) {
    const k = f.properties.cluster ? `c${f.properties.cluster_id}` : f.properties.id;
    seen.set(k, f.properties.cluster ? f.properties.point_count : 1);
  }
  return [...seen.values()].reduce((a, b) => a + b, 0);
});
check("project markers render from stored records (clustered statewide)", rendered === api.geojson.features.length, `${rendered}/${api.geojson.features.length}`);
check("development markers are always visible (no hide toggle)", (await vis("projects-icon")) === "visible" && (await page.getByRole("switch", { name: /Developments/ }).count()) === 0);
check("sidebar leads with Action available", /Action available/i.test((await page.locator("aside h2").first().textContent()) ?? ""));
const iconExpr = JSON.stringify(await M(() => window.__imbyMap.getLayoutProperty("projects-icon", "icon-image")));
const images = await M(() => ["cat-data_center", "cat-power_infrastructure", "cat-industrial", "school"].map((i) => window.__imbyMap.hasImage(i)));
check("markers use category icons (server / bolt / factory) with a separate status dot", iconExpr.includes("cat-data_center") && images.every(Boolean) && (await vis("projects-status")) === "visible");
check("Explore view hides baseline polygons and schools", (await vis("ces-fill")) === "none" && (await vis("schools-icon")) === "none");
check("project markers stack above environmental polygons", (await layerIndex("projects-icon")) > (await layerIndex("ces-fill")) && (await layerIndex("projects-icon")) > (await layerIndex("ces-site-line")));
await page.screenshot({ path: `${OUT}/1-explore.png` });

// 2. Clicking a project opens the correct details
// Baseline GIS layers (CalEnviroScreen, schools) cover the original Bay Area study area only.
const inStudy = (p) => p.latitude !== null && p.longitude >= -122.1 && p.longitude <= -121.78 && p.latitude >= 37.28 && p.latitude <= 37.47;
const target = api.projects.find((p) => inStudy(p) && p.comment_status === "open") ?? api.projects.find(inStudy) ?? api.projects[0];
await page.getByRole("button", { name: new RegExp(target.canonical_name) }).first().click();
const heading = page.locator("aside[aria-label='Project details'] h2");
await heading.waitFor({ timeout: 20000 });
check("selecting a project opens its details", (await heading.textContent())?.trim() === target.canonical_name, target.canonical_name);
await page.waitForTimeout(1400);
check("Project (Overview) view keeps the baseline hidden", (await vis("ces-fill")) === "none");
await page.screenshot({ path: `${OUT}/2-project.png` });

// 3. Evidence links point to real source documents
const detail = await (await fetch(`${BASE}/api/projects/${target.id}`)).json();
const sources = new Set(detail.documents.map((d) => d.source_url));
const firstMetric = page.locator("aside[aria-label='Project details'] button:has-text('Quote verified')").first();
if (await firstMetric.count()) {
  await firstMetric.click();
  const href = await page.locator("dialog a[href^='https://']").first().getAttribute("href");
  check("evidence card links to a stored official source", sources.has(href), href ?? "none");
  await page.keyboard.press("Escape");
}

// 4. Explore → Project → Impacts: baseline activates around the site
await page.getByRole("tab", { name: "Impacts" }).click();
await page.waitForTimeout(1600);
check("Impacts activates the CalEnviroScreen baseline", (await vis("ces-fill")) === "visible" && (await vis("ces-site-line")) === "visible");
const filters = await M(() => ({ fill: window.__imbyMap.getFilter("ces-fill"), site: window.__imbyMap.getFilter("ces-site-line") }));
const vicinityCount = filters.fill?.[2]?.[1]?.length ?? 0;
check("baseline limited to the site tract + neighbors, site tract outlined", filters.fill?.[0] === "in" && vicinityCount > 1 && filters.site?.[2] > 0, `${vicinityCount} tracts, site tract ${filters.site?.[2]}`);
const tractShown = await page.locator("[role=tabpanel]").textContent();
check("Impacts panel reports the same site tract", tractShown.includes(String(filters.site?.[2])));
check("schools stay hidden until enabled", (await vis("schools-icon")) === "none");
await page.getByRole("switch", { name: /Public schools/ }).click();
await page.waitForTimeout(600);
const schoolCount = await M(() => window.__imbyMap.getSource("schools").serialize().data.features.length);
check("enabling schools shows only vicinity schools (clustered source)", (await vis("schools-icon")) === "visible" && schoolCount > 0 && schoolCount < 120, `${schoolCount} schools within vicinity`);
await page.screenshot({ path: `${OUT}/3-impacts-existing.png` });

// Tract click shows real indicator values
const siteXY = await M(([lng, lat]) => window.__imbyMap.project([lng, lat]), [detail.longitude, detail.latitude]);
const box = await page.locator(".maplibregl-canvas").boundingBox();
await page.mouse.click(box.x + siteXY.x + 18, box.y + siteXY.y + 28);
await page.waitForTimeout(500);
const popupText = (await page.locator(".maplibregl-popup-content").textContent().catch(() => "")) ?? "";
check("clicking a tract shows its real CalEnviroScreen values", /Tract \d+/.test(popupText) && /µg\/m³/.test(popupText) && /Statewide pct/.test(popupText), popupText.slice(0, 90));
await page.screenshot({ path: `${OUT}/4-tract-popup.png` });

// Indicator switch recolors with actual dataset field
await page.getByLabel("CalEnviroScreen indicator").selectOption("dieselP");
await page.waitForTimeout(300);
check("indicator selector recolors by the chosen field", JSON.stringify(await M(() => window.__imbyMap.getPaintProperty("ces-fill", "fill-color"))).includes("dieselP"));

// Proposed keeps the baseline legible and adds project overlays
const opacityBefore = JSON.stringify(await M(() => window.__imbyMap.getPaintProperty("ces-fill", "fill-opacity")));
await page.getByRole("radio", { name: "proposed", exact: true }).click();
await page.waitForTimeout(900);
const opacityAfter = JSON.stringify(await M(() => window.__imbyMap.getPaintProperty("ces-fill", "fill-opacity")));
check("Proposed view keeps the baseline visible (no fade-out)", (await vis("ces-fill")) === "visible" && opacityBefore === opacityAfter);
check("Proposed view shows reference ring and filing-named schools", (await vis("ring-line")) === "visible" && (await vis("reported-icon")) === "visible");
await page.screenshot({ path: `${OUT}/5-impacts-proposed.png` });

// Full regional baseline on demand
await page.getByRole("radio", { name: "Full region" }).click();
await page.waitForTimeout(1200);
check("'Full region' shows the whole regional baseline", (await M(() => window.__imbyMap.getFilter("ces-fill"))) == null);
await page.screenshot({ path: `${OUT}/6-region.png` });
await page.getByRole("radio", { name: /Near site/ }).click();

// Leaving Impacts hides environmental layers again
await page.getByRole("tab", { name: "Overview" }).click();
await page.waitForTimeout(500);
check("leaving Impacts hides baseline/schools deterministically", (await vis("ces-fill")) === "none" && (await vis("schools-icon")) === "none" && (await vis("ring-line")) === "none");

// 5. Participation guide: status matches stored deadline; channels are official; no AI composer
await page.getByRole("tab", { name: "Participate" }).click();
const statusText = await page.locator("[role=tabpanel] section").first().textContent();
const expected =
  target.comment_status === "open" ? /Public comment is open/ : target.comment_status === "upcoming" ? /Public comment opens/ : target.comment_status === "closed" ? /has closed/ : /No verified comment period/;
check("participation status matches stored deadline", expected.test(statusText ?? ""), statusText?.slice(0, 80));
const hrefs = await page.locator("[role=tabpanel] a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
check("participation links are official sources, mailto or tel only", hrefs.every((h) => /^(mailto:|tel:)/.test(h) || sources.has(h) || /\.gov\b|\.ca\.us\b|legistar\.com/.test(h)), hrefs.join(" ").slice(0, 160));
check("no AI comment composer in Participate", (await page.getByRole("button", { name: /Generate|draft/i }).count()) === 0);
await page.screenshot({ path: `${OUT}/7-participate.png` });

// 7. Community question → grounded answer with source passage
await page.getByRole("tab", { name: "Community" }).click();
await page.locator("[role=tabpanel] li button").first().click();
const passage = page.locator("[role=tabpanel] figcaption a").first();
await passage.waitFor({ timeout: 120000 }).catch(() => {});
const passHref = (await passage.count()) ? await passage.getAttribute("href") : null;
check("community question returns an answer citing a stored source", !!passHref && sources.has(passHref), passHref ?? "no citation");
await page.screenshot({ path: `${OUT}/8-community.png` });

check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
