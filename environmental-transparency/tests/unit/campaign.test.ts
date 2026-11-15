import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeFeed, groupBySch, monthWindows, parseCsv, parseFeed, usDateToIso, type CeqaFiling } from "@/lib/campaign/ceqa-feed";
import { classifyProject, parseDevelopmentTypes, statusFromDocType } from "@/lib/campaign/classify";
import { coordinatePrecisionOk, sharedCoordinates, verifyLocation, type CountyFC } from "@/lib/campaign/locate";
import { accountDelta, canSpend, emptyLedger, parseZoneCost, rateFromAccount, reserve, spent } from "@/lib/campaign/budget";
import { linkDocumentToProject } from "@/lib/campaign/link";
import { officialHost, brightDataRefusesHost } from "@/lib/config";

// Real rows from the CEQAnet statewide search export (Windows-1252 encoded, as served).
const fixture = readFileSync(join(__dirname, "../fixtures/ceqanet-export-sample.csv"));
const filings = parseFeed(decodeFeed(fixture));
const counties = JSON.parse(readFileSync(join(__dirname, "../../public/gis/ca-counties.geojson"), "utf8")) as CountyFC;
const bySch = (sch: string) => groupBySch(filings).find((g) => g.sch === sch)!;

describe("CEQAnet export parsing", () => {
  it("parses quoted fields with commas, quotes and newlines", () => {
    expect(parseCsv('a,b\r\n"x, ""y""\nz",2\r\n')).toEqual([["a", "b"], ['x, "y"\nz', "2"]]);
    // Bare quotes inside unquoted fields are data (DMS seconds marks).
    expect(parseCsv(`1,35°4'32.3"N 116°24'29.7"W,x\n2,y,z\n`)).toEqual([["1", `35°4'32.3"N 116°24'29.7"W`, "x"], ["2", "y", "z"]]);
  });
  it("decodes Windows-1252 so DMS coordinates keep their degree signs", () => {
    const montague = filings.find((f) => f.sch === "2026020144")!;
    expect(montague.coordinatesRaw).toBe(`37°23'54.906"N 121°55'49.056"W`);
  });
  it("normalizes dates and lists", () => {
    expect(usDateToIso("11/5/2026")).toBe("2026-11-05");
    expect(usDateToIso("")).toBeNull();
    const i580 = filings.find((f) => f.sch === "2026101227")!;
    expect(i580.counties).toEqual(["Contra Costa", "Marin"]);
  });
  it("groups filings by SCH number: a later filing is a new document of the same project", () => {
    const g = bySch("2026050302");
    const dates = g.filings.map((f) => f.received ?? "");
    expect(dates).toEqual([...dates].sort()); // oldest → newest
    expect(new Set(g.filings.map((f) => f.docType))).toEqual(new Set(["NOD", "FIN"]));
    expect(g.filings).toHaveLength(2);
    expect(new Set(g.filings.map((f) => f.portalUrl)).size).toBe(2);
    // Overlapping export windows repeat rows; they collapse to one document.
    expect(groupBySch([...filings, ...filings]).find((x) => x.sch === "2026050302")!.filings).toHaveLength(2);
  });
  it("builds month windows newest-first covering the range exactly", () => {
    expect(monthWindows("2026-09-10", "2026-11-15")).toEqual([
      { start: "2026-11-01", end: "2026-11-15" },
      { start: "2026-10-01", end: "2026-10-31" },
      { start: "2026-09-10", end: "2026-09-30" },
    ]);
  });
  it("rejects an export whose header changed", () => {
    expect(() => parseFeed("Foo,Bar\n1,2\n")).toThrow(/header/);
  });
});

describe("relevance classification", () => {
  it("parses NOC development types including multiple parenthetical groups", () => {
    const d = parseDevelopmentTypes("Commercial (Sq. Ft. 30163, Acres 23.82, Employees 40), Power:Other Power Type (Bulk Substation)(Megawatts 230)");
    expect(d[0]).toMatchObject({ type: "Commercial", attrs: { "Sq. Ft.": 30163, Acres: 23.82, Employees: 40 } });
    expect(d[1]).toMatchObject({ type: "Power", subtype: "Other Power Type — Bulk Substation", attrs: { Megawatts: 230 } });
  });
  it("maps CEQA document types to procedural status", () => {
    expect(statusFromDocType("NOD")).toBe("approved");
    expect(statusFromDocType("MND ")).toBe("under_review");
    expect(statusFromDocType("CON")).toBe("proposed");
  });
  it("keeps real developments and records why", () => {
    const sub = classifyProject(bySch("2026050302"), "2026-11-15");
    expect(sub.relevant).toBe(true);
    expect(sub.category).toBe("power_infrastructure");
    expect(sub.reasons.some((r) => /substation/i.test(r.matched))).toBe(true);
    const montague = classifyProject(bySch("2026020144"), "2026-11-15");
    expect(montague).toMatchObject({ relevant: true, category: "industrial", status: "under_review", active: true });
    const afton = classifyProject(bySch("2026110368"), "2026-11-15");
    expect(afton.relevant).toBe(true);
    expect(afton.category).toBe("warehouse_logistics"); // title "Travel Center" outranks a description mention
  });
  it("excludes data-center moratoria and zoning amendments (policy, not developments)", () => {
    expect(classifyProject(bySch("2026101138")).excludedBecause).toMatch(/Policy/);
    expect(classifyProject(bySch("2026101098")).excludedBecause).toMatch(/Policy/);
  });
  it("treats an industrial park as a development, not a park", () => {
    const f = { ...filings.find((x) => x.sch === "2026020144")!, sch: "2026109999", docTitle: "Kelsey and Hurley Industrial Park", projectTitle: "Kelsey and Hurley Industrial Park", portalUrl: "https://ceqanet.lci.ca.gov/2026109999" };
    expect(classifyProject({ sch: f.sch, filings: [f] }).relevant).toBe(true);
  });
  it("excludes jurisdiction-wide plans, regulations, and prohibitions but keeps site amendments", () => {
    const base = filings.find((x) => x.sch === "2026020144")!;
    const as = (title: string) => classifyProject({ sch: "2026109998", filings: [{ ...base, docTitle: title, projectTitle: title }] });
    expect(as("Modesto 2050 General Plan").relevant).toBe(false);
    expect(as("Lake County General Plan 2050").relevant).toBe(false);
    expect(as("PROHIBITION ON DATA CENTERS").relevant).toBe(false);
    expect(as("Proposed Regulations for the Plastic Pollution Prevention Act").relevant).toBe(false);
    expect(as("Chhina General Plan Amendment and Rezone").relevant).toBe(true);
  });
  it("excludes routine repair exemptions", () => {
    expect(classifyProject(bySch("2026101197")).relevant).toBe(false);
  });
});

describe("location verification (no markers for ambiguous locations)", () => {
  const verify = (sch: string, shared = new Set<string>()) => {
    const g = bySch(sch);
    const c = classifyProject(g);
    return verifyLocation(c.primary, c.latest.projectTitle, counties, shared);
  };
  it("maps a precise point inside the listed county", () => {
    const v = verify("2026020144");
    expect(v.mapReady).toBe(true);
    expect(v.county).toBe("Santa Clara County");
    expect(v.lat).toBeCloseTo(37.398585, 5);
  });
  it("does not map a filing that spans several counties", () => {
    const v = verify("2026101227");
    expect(v.mapReady).toBe(false);
    expect(v.reason).toMatch(/several counties/);
  });
  it("does not map filings without coordinates", () => {
    expect(verify("2026101138").mapReady).toBe(false);
  });
  it("does not map a point outside the county the filing names", () => {
    const f = { ...filings.find((x) => x.sch === "2026020144")!, counties: ["Kern"] } as CeqaFiling;
    const v = verifyLocation(f, "Montague Point Industrial Project", counties, new Set());
    expect(v.mapReady).toBe(false);
    expect(v.checks.at(-1)!.check).toBe("county_match");
  });
  it("does not map linear or area-wide scopes", () => {
    const f = filings.find((x) => x.sch === "2026020144")!;
    expect(verifyLocation(f, "Countywide Pipeline Replacement Program", counties, new Set()).mapReady).toBe(false);
  });
  it("does not map coordinates shared by unrelated filings (placeholders)", () => {
    const base = filings.find((x) => x.sch === "2026020144")!;
    const clones = ["1", "2", "3"].map((n) => ({ ...base, sch: `202602014${n}`, projectTitle: `Unrelated ${n}`, docTitle: `Unrelated ${n}` }));
    const shared = sharedCoordinates([base, ...clones]);
    expect(verifyLocation(base, base.projectTitle, counties, shared).mapReady).toBe(false);
  });
  it("requires seconds-level precision", () => {
    expect(coordinatePrecisionOk(`37°23'54.906"N 121°55'49.056"W`)).toBe(true);
    expect(coordinatePrecisionOk(`37°23'N 121°55'W`)).toBe(false);
    expect(coordinatePrecisionOk("37.39, -121.93")).toBe(false);
  });
});

describe("Bright Data budget", () => {
  const cfg = { maxRequests: 10, maxUsd: 20, phaseCap: 3 };
  it("refuses requests past the phase cap (pilot) and the campaign cap", () => {
    const l = emptyLedger();
    for (let i = 0; i < 3; i++) {
      expect(canSpend(l, cfg, "serp").ok).toBe(true);
      reserve(l, "serp", "q");
    }
    expect(canSpend(l, cfg, "unlocker")).toMatchObject({ ok: false, reason: "phase_cap" });
    expect(canSpend(l, { ...cfg, phaseCap: 100 }, "serp", 8)).toMatchObject({ ok: false, reason: "campaign_requests" });
  });
  it("refuses requests past the USD cap", () => {
    const l = emptyLedger();
    l.rates.serp = { usdPerRequest: 1, source: "account" };
    reserve(l, "serp", "q");
    expect(canSpend(l, { maxRequests: 100, maxUsd: 1.5, phaseCap: 100 }, "serp")).toMatchObject({ ok: false, reason: "campaign_usd" });
  });
  it("uses the account's own counts when they exceed the local ledger", () => {
    const l = emptyLedger();
    const snap = (n: number) => ({ at: "", requests: { serp: n, unlocker: 0 }, usd: { serp: 0, unlocker: 0 }, months: { "serp:Nov-2026": n }, monthsUsd: { "serp:Nov-2026": n * 0.0015 } });
    l.accountBaseline = snap(21);
    l.accountLatest = snap(26);
    reserve(l, "serp", "q");
    expect(accountDelta(l)!.requests).toBe(5);
    expect(spent(l)).toMatchObject({ requests: 5, basis: "account" });
    expect(canSpend(l, cfg, "serp")).toMatchObject({ ok: false, reason: "phase_cap" });
  });
  it("parses the zone cost API and derives the billed rate", () => {
    const z = parseZoneCost(
      { hl_1: { back_m0: { cost: 0.0225, reqs_unblocker: 15, range: { from: "Nov-2026" } }, back_m1: { cost: 0, range: { from: "Oct-2026" } }, back_d0: { cost: 9 } } },
      "unlocker",
    );
    expect(z).toMatchObject({ requests: 15, usd: 0.0225 });
    expect(rateFromAccount(z.usd, z.requests)).toEqual({ usdPerRequest: 0.0015, source: "account" });
  });
});

describe("linking search results to projects", () => {
  const id = { sch: "2026050302", title: "Jackson Bulk Substation Project", caseNumbers: ["PLNP2025-00012"], places: ["Sacramento County"] };
  it("links by SCH number in any common format", () => {
    expect(linkDocumentToProject("… State Clearinghouse No. 2026-05-0302 …", id)).toMatchObject({ linked: true, basis: "sch_number" });
    expect(linkDocumentToProject("SCH# 2026050302", id).linked).toBe(true);
  });
  it("links by case number or by exact title plus place", () => {
    expect(linkDocumentToProject("File PLNP2025-00012 staff report", id).basis).toBe("case_number");
    expect(linkDocumentToProject("Item 4: Jackson Bulk Substation Project, Sacramento County Board of Supervisors", id).basis).toBe("title_and_place");
  });
  it("does not link on a title alone or a partial match", () => {
    expect(linkDocumentToProject("Jackson Bulk Substation Project discussed", id).linked).toBe(false);
    expect(linkDocumentToProject("Jackson substation in Sacramento County", id).linked).toBe(false);
    expect(linkDocumentToProject("SCH 2026050303", id).linked).toBe(false);
  });
});

describe("official source rules", () => {
  it("accepts government and agency meeting-record hosts with a recorded basis", () => {
    expect(officialHost(new URL("https://ceqanet.lci.ca.gov/1"))?.basis).toMatch(/allowlist/);
    expect(officialHost(new URL("https://www.energy.ca.gov/x"))).not.toBeNull();
    expect(officialHost(new URL("https://www.cityofsomewhere.ca.us/x"))?.kind).toBe("city");
    expect(officialHost(new URL("https://fresno.legistar.com/x"))?.kind).toBe("meeting_platform");
    expect(officialHost(new URL("https://valleyair.org/x"))?.kind).toBe("agency");
  });
  it("refuses look-alikes and non-https", () => {
    expect(officialHost(new URL("https://ca.gov.evil.com/"))).toBeNull();
    expect(officialHost(new URL("https://legistar.com.evil.io/"))).toBeNull();
    expect(officialHost(new URL("http://www.energy.ca.gov/"))).toBeNull();
    expect(officialHost(new URL("https://example.org/"))).toBeNull();
  });
  it("routes government hosts away from Bright Data (refused by its policy)", () => {
    expect(brightDataRefusesHost("www.energy.ca.gov")).toBe(true);
    expect(brightDataRefusesHost("www.city.ca.us")).toBe(true);
    expect(brightDataRefusesHost("fresno.legistar.com")).toBe(false);
  });
});

describe("negated mentions", () => {
  it("ignores 'would not include … data centers'", async () => {
    const { firstAffirmed } = await import("@/lib/campaign/classify");
    expect(firstAffirmed(/data centers?/i, "The proposed warehouse buildings would not include cold storage or data centers.")).toBeNull();
    expect(firstAffirmed(/data centers?/i, "No data center is proposed. The project is a 40 MW data center campus.")?.index).toBeGreaterThan(30);
  });
});

describe("post-processing cleanup and summary grounding", () => {
  it("cleans names without changing their substance", async () => {
    const { cleanName, developerFromTitle, cleanDescription } = await import("@/lib/campaign/clean");
    expect(cleanName("HAZEL AVENUE/U.S. 50 INTERCHANGE PROJECT")).toBe("Hazel Avenue/U.S. 50 Interchange Project");
    expect(cleanName("LAS CAMAS SOLAR PROJECT")).toBe("Las Camas Solar Project");
    expect(cleanName("*Withdrawn Per Lead* DRC2019-00132 Rocky Canyon Quarry Expansion CUP")).toBe("DRC2019-00132 Rocky Canyon Quarry Expansion CUP");
    expect(cleanName("Use Permit 460-88A -  Graniterock")).toBe("Use Permit 460-88A - Graniterock");
    expect(cleanName("Application No. PLN2026-0068 \x96 Amanece Hybrid Solar")).toBe("Application No. PLN2026-0068 – Amanece Hybrid Solar");
    expect(cleanName("Jackson Bulk Substation Project")).toBe("Jackson Bulk Substation Project");
    expect(developerFromTitle("Winston Solar Project by Winston Solar, LLC")).toBe("Winston Solar, LLC");
    expect(developerFromTitle("Galaxy Solar PV and Storage Project by Galaxy Solar Storage, LLC (Terra-Gen)")).toBe("Galaxy Solar Storage, LLC");
    expect(developerFromTitle("Powered by the Sun Project")).toBeNull();
    expect(cleanDescription("A  project\r\n\r\n\r\n  with\tgaps ")).toBe("A project\n\nwith gaps");
  });
  it("discards summaries with numbers not in the source or health claims", async () => {
    const { checkSummary } = await import("@/lib/campaign/clean");
    const src = "Description: a 2,170-acre solar energy facility generating 300 megawatts.";
    expect(checkSummary("A 2,170-acre solar facility of 300 megawatts is proposed.", src).ok).toBe(true);
    expect(checkSummary("A 2,200-acre solar facility is proposed.", src).problems[0]).toMatch(/2200/);
    expect(checkSummary("The solar facility may cause asthma.", src).ok).toBe(false);
  });
});
