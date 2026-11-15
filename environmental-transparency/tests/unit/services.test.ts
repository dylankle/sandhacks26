import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelOutputError, parseModelJson } from "@/lib/gemini";
import { BrightDataError, BrightDataPolicyBlock, serpSearch, unlockerFetch } from "@/lib/brightdata";
import { FetchRefused, safeFetch } from "@/lib/net/safe-fetch";
import { hostAllowed } from "@/lib/config";
import { featureKey } from "@/lib/pipeline/persist";
import { extractionSchema } from "@/types/project";

const emptyImpact = { metrics: [], findings: [] };
const validExtraction = {
  project: { name: "Test", category: "data_center", case_numbers: [], location: { city: null, county: null, address: null, parcel_numbers: null } },
  summary: { description: null, plain_language: null, status: "unknown", status_quote: null, status_doc: null },
  timeline: [],
  cost_estimates: [],
  environmental_impacts: Object.fromEntries(
    ["noise", "air_quality", "greenhouse_gas", "water", "energy", "traffic", "hazards", "biological", "land_use"].map((t) => [t, emptyImpact]),
  ),
  other_impacts: [],
  proponents: [],
  government: { lead_agency: null, participants: [] },
  public_participation: { comment_period: null, hearings: [] },
};

describe("Gemini output validation", () => {
  it("accepts schema-conformant output with unknowns left null", () => {
    const out = parseModelJson(extractionSchema, JSON.stringify(validExtraction));
    expect(out.proponents).toEqual([]);
    expect(out.government.lead_agency).toBeNull();
    expect(out.public_participation.comment_period).toBeNull();
  });
  it("rejects invalid JSON", () => {
    expect(() => parseModelJson(extractionSchema, "{not json")).toThrow(ModelOutputError);
  });
  it("rejects empty responses", () => {
    expect(() => parseModelJson(extractionSchema, "")).toThrow(/empty/);
  });
  it("rejects schema violations instead of patching them", () => {
    expect(() => parseModelJson(extractionSchema, JSON.stringify({ ...validExtraction, project: { ...validExtraction.project, category: "spaceport" } }))).toThrow(/schema/);
    const { cost_estimates: _c, ...missing } = validExtraction;
    void _c;
    expect(() => parseModelJson(extractionSchema, JSON.stringify(missing))).toThrow(/schema/);
    expect(() =>
      parseModelJson(extractionSchema, JSON.stringify({
          ...validExtraction,
          cost_estimates: [{ label: "x", category: "construction", amount: "lots", unit: "USD", paid_by: null, context: null, doc: 0, quote: "q" }],
        })),
    ).toThrow(/schema/);
  });
});

describe("Bright Data client failure handling", () => {
  afterEach(() => vi.unstubAllGlobals());
  process.env.BRIGHTDATA_API_KEY = "test";
  process.env.BRIGHTDATA_SERP_ZONE = "serp";
  process.env.BRIGHTDATA_UNLOCKER_ZONE = "unlocker";

  it("classifies government-policy refusals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200, headers: { "x-brd-error": "Access denied: x.gov is classified as Government and blocked" } })));
    await expect(unlockerFetch("https://ceqanet.lci.ca.gov/1")).rejects.toBeInstanceOf(BrightDataPolicyBlock);
  });
  it("retries transient 5xx once then fails explicitly", async () => {
    const f = vi.fn(async () => new Response("", { status: 502 }));
    vi.stubGlobal("fetch", f);
    await expect(unlockerFetch("https://santaclara.legistar.com/x")).rejects.toBeInstanceOf(BrightDataError);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("parses SERP JSON envelopes", async () => {
    const body = JSON.stringify({ organic: [{ rank: 1, title: "A", link: "https://ceqanet.lci.ca.gov/2024070671", description: "d", source: "CEQAnet" }] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status_code: 200, body })));
    const r = await serpSearch("data center");
    expect(r[0]).toMatchObject({ rank: 1, link: "https://ceqanet.lci.ca.gov/2024070671" });
  });
  it("reports SERP HTTP failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(serpSearch("x")).rejects.toThrow(/HTTP 401/);
  });
});

describe("SSRF guard & allowlist", () => {
  it("only allows https official hosts", () => {
    expect(hostAllowed(new URL("https://ceqanet.lci.ca.gov/1"))).toBe(true);
    expect(hostAllowed(new URL("http://ceqanet.lci.ca.gov/1"))).toBe(false);
    expect(hostAllowed(new URL("https://evil.example.com/"))).toBe(false);
    expect(hostAllowed(new URL("https://ceqanet.lci.ca.gov.evil.com/"))).toBe(false);
  });
  it("refuses IP literals and private resolutions before any request", async () => {
    await expect(safeFetch("https://127.0.0.1/", () => true)).rejects.toBeInstanceOf(FetchRefused);
    await expect(safeFetch("https://169.254.169.254/latest/meta-data", () => true)).rejects.toBeInstanceOf(FetchRefused);
    await expect(safeFetch("https://localhost/", () => true)).rejects.toBeInstanceOf(FetchRefused);
    await expect(safeFetch("https://example.com/", () => false)).rejects.toThrow(/allowlist/);
  });
});

describe("dedupe keys", () => {
  it("is insensitive to jsonb key reordering", () => {
    const a = { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: { a: 1, b: 2 } };
    const b = { properties: { b: 2, a: 1 }, geometry: { coordinates: [1, 2], type: "Point" }, type: "Feature" };
    expect(featureKey("site", a)).toBe(featureKey("site", b));
  });
});
