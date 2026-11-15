import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCeqaNet } from "@/lib/sources/parse";
import { dateInText, endOfDayPacific, locateQuote, numberInQuote, statusFromCeqaDocType, unitLooksValid, validateExtraction } from "@/lib/pipeline/validate";
import type { Extraction } from "@/types/project";

const DOC = `[page 1]
NOTICE OF PREPARATION
The Northtown Backup Generating Facility (NTBGF) would consist of a total of forty two (42) diesel-fired generators
that would be used exclusively to provide up to 97.3 megawatts (mw) of backup emergency generation.
[page 2]
The entire project site is approximately 28.5 acres. Comments may be sent to Elizabeth.Huber@energy.ca.gov.
The applicant, Northtown Data LLC, estimates a total construction cost of $450 million.
On December 3, 2026 the California Energy Commission voted 4-0 to approve the exemption, with Commissioner Jane Doe presiding.`;

const emptyImpact = () => ({ metrics: [], findings: [] });
const base: Extraction = {
  project: {
    name: "Northtown Backup Generating Facility",
    category: "power_infrastructure",
    case_numbers: [],
    location: { city: null, county: null, address: null, parcel_numbers: null },
  },
  summary: { description: null, plain_language: null, status: "unknown", status_quote: null, status_doc: null },
  timeline: [],
  cost_estimates: [],
  environmental_impacts: {
    noise: emptyImpact(),
    air_quality: emptyImpact(),
    greenhouse_gas: emptyImpact(),
    water: emptyImpact(),
    energy: emptyImpact(),
    traffic: emptyImpact(),
    hazards: emptyImpact(),
    biological: emptyImpact(),
    land_use: emptyImpact(),
  },
  other_impacts: [],
  proponents: [],
  government: { lead_agency: null, participants: [] },
  public_participation: { comment_period: null, hearings: [] },
};
const withImpacts = (impacts: Partial<Extraction["environmental_impacts"]>): Extraction => ({
  ...base,
  environmental_impacts: { ...base.environmental_impacts, ...impacts },
});
const docs = [{ url: "https://ceqanet.lci.ca.gov/2026070839", title: "NOP", text: DOC, documentType: "NOP" }];
const NOW = new Date("2026-11-15T12:00:00Z");

describe("quote verification", () => {
  it("finds quotes across line breaks and reports the page", () => {
    expect(locateQuote("up to 97.3 megawatts (mw) of backup emergency generation", DOC)).toEqual({ found: true, page: 1 });
    expect(locateQuote("The entire project site is approximately 28.5 acres.", DOC)).toEqual({ found: true, page: 2 });
  });
  it("rejects paraphrases", () => {
    expect(locateQuote("the facility will produce about 100 megawatts of power", DOC).found).toBe(false);
  });
  it("checks numbers appear in the quote", () => {
    expect(numberInQuote(42, "a total of forty two (42) diesel-fired generators")).toBe(true);
    expect(numberInQuote(109520, "approximately 109,520 square-foot data center")).toBe(true);
    expect(numberInQuote(50, "up to 97.3 megawatts")).toBe(false);
  });
  it("recognizes reported units", () => {
    expect(unitLooksValid("MW")).toBe(true);
    expect(unitLooksValid("Megawatts (MW)")).toBe(true);
    expect(unitLooksValid("square-foot")).toBe(true);
    expect(unitLooksValid("bananas")).toBe(false);
  });
});

describe("validateExtraction", () => {
  it("marks verified metrics as validated and fabricated ones as unverified", () => {
    const v = validateExtraction({
      extraction: withImpacts({
        energy: { metrics: [{ name: "Backup capacity", value: 97.3, unit: "MW", context: null, doc: 0, quote: "up to 97.3 megawatts (mw) of backup emergency generation" }], findings: [] },
        water: { metrics: [{ name: "Water use", value: 500000, unit: "gallons/day", context: null, doc: 0, quote: "would use 500,000 gallons per day of water" }], findings: [] },
      }),
      docs,
      now: NOW,
    });
    const energy = v.facts.find((f) => f.field === "metric.energy.backup_capacity")!;
    const water = v.facts.find((f) => f.field === "metric.water.water_use")!;
    expect(energy.review_status).toBe("validated");
    expect(energy.passage?.page).toBe(1);
    expect(water.review_status).toBe("unverified");
    expect(v.stats).toMatchObject({ validated: 1, unverified: 1 });
  });

  it("keeps missing facts unknown: no metrics, no deadline, no status invented", () => {
    const v = validateExtraction({ extraction: { ...base, summary: { ...base.summary, status: "approved", status_quote: null } }, docs, now: NOW });
    expect(v.project.status).toBe("unknown");
    expect(v.events).toHaveLength(0);
    expect(v.facts.filter((f) => f.field.startsWith("metric."))).toHaveLength(0);
    expect(v.project.latitude).toBeNull();
    expect(v.project.location_precision).toBe("unlocated");
  });

  it("drops claims citing documents that don't exist", () => {
    const v = validateExtraction({
      extraction: withImpacts({ energy: { metrics: [{ name: "x", value: 42, unit: "generators", context: null, doc: 5, quote: "forty two (42)" }], findings: [] } }),
      docs,
      now: NOW,
    });
    expect(v.stats.dropped).toBe(1);
    expect(v.facts.some((f) => f.field.startsWith("metric."))).toBe(false);
  });

  it("never shows an unverifiable hearing", () => {
    const v = validateExtraction({
      extraction: {
        ...base,
        public_participation: {
          comment_period: null,
          hearings: [{ date: "2026-12-01", time: "6 PM", body: "Planning Commission", location: "City Hall", online: null, doc: 0, quote: "A hearing will be held December 1, 2026" }],
        },
      },
      docs,
      now: NOW,
    });
    expect(v.events.filter((e) => e.event_type === "hearing")).toHaveLength(0);
  });

  it("only uses a submission email that appears in the source", () => {
    const v = validateExtraction({
      extraction: {
        ...base,
        public_participation: {
          hearings: [],
          comment_period: { start: null, end: "2026-12-17", submit_to: "Elizabeth.Huber@energy.ca.gov", doc: 0, quote: "Comments may be sent to Elizabeth.Huber@energy.ca.gov." },
        },
      },
      docs,
      now: NOW,
    });
    // Quote is verified, but the end date isn't in the quote, so no deadline is asserted.
    expect(v.events).toHaveLength(0);
    expect(v.issues.some((i) => /no verifiable end date/.test(i.message))).toBe(true);
  });

  it("uses CEQAnet structured data: coordinates, review period, lead contact, status", () => {
    const html = readFileSync("tests/fixtures/ceqanet-2024070671.html", "utf8");
    const page = parseCeqaNet(html, "https://ceqanet.lci.ca.gov/2024070671");
    const v = validateExtraction({
      extraction: {
        ...base,
        project: { ...base.project, name: "1231 Comstock Prime Data Center" },
        summary: { ...base.summary, status: "approved", status_quote: "approved by council", status_doc: 0 },
      },
      docs: [{ url: "https://ceqanet.lci.ca.gov/2024070671", title: page.title, text: "Summary text without the quote", documentType: "MND" }],
      ceqa: { docIndex: 0, page },
      now: NOW,
    });
    expect(v.project.location_precision).toBe("reported_coordinates");
    expect(v.project.status).toBe("under_review"); // MND, not an NOD; unverified "approved" claim discarded
    const cp = v.events.find((e) => e.event_type === "comment_period")!;
    expect(cp.status).toBe("closed");
    expect(cp.official_submission_url).toBe("mailto:dsobczak@santaclaraca.gov");
    expect(v.facts.find((f) => f.field === "identity.sch_number")?.value).toBe("2024070671");
  });

  it("verifies cost estimates, proponents, and government participants against the source", () => {
    const v = validateExtraction({
      extraction: {
        ...base,
        cost_estimates: [
          { label: "Total construction cost", category: "construction", amount: 450, unit: "million USD", paid_by: "Northtown Data LLC", context: "estimated", doc: 0, quote: "estimates a total construction cost of $450 million" },
          { label: "Public subsidy", category: "public_funding", amount: 20, unit: "million USD", paid_by: null, context: null, doc: 0, quote: "estimates a total construction cost of $450 million" },
        ],
        proponents: [
          { name: "Northtown Data LLC", role: "applicant", representative: null, doc: 0, quote: "The applicant, Northtown Data LLC, estimates" },
          { name: "Acme Holdings", role: "property_owner", representative: null, doc: 0, quote: "The applicant, Northtown Data LLC, estimates" },
        ],
        government: {
          lead_agency: "California Energy Commission",
          participants: [
            {
              name: null,
              title: null,
              body: "California Energy Commission",
              role: "decision_maker",
              action: "Voted 4-0 to approve the exemption",
              vote: "yes",
              date: "2026-12-03",
              doc: 0,
              quote: "On December 3, 2026 the California Energy Commission voted 4-0 to approve the exemption",
            },
            { name: "Jane Doe", title: "Commissioner", body: "California Energy Commission", role: "appointed_commissioner", action: "Presided", vote: null, date: "2026-12-09", doc: 0, quote: "with Commissioner Jane Doe presiding" },
          ],
        },
      },
      docs,
      now: NOW,
    });
    const cost = v.facts.filter((f) => f.field.startsWith("cost."));
    expect(cost.find((f) => f.field === "cost.construction.total_construction_cost")).toMatchObject({ value: "450", unit: "million USD", review_status: "validated" });
    expect(cost.find((f) => f.field === "cost.public_funding.public_subsidy")?.review_status).toBe("unverified"); // 20 isn't in the quote

    expect(v.facts.find((f) => f.field === "proponent.applicant")).toMatchObject({ value: "Northtown Data LLC", review_status: "validated" });
    expect(v.facts.find((f) => f.field === "proponent.property_owner")?.review_status).toBe("unverified"); // name not in quote
    expect(v.project.developer).toBe("Northtown Data LLC");
    expect(v.project.lead_agency).toBe("California Energy Commission");

    const decision = v.facts.find((f) => f.field === "government.decision_maker")!;
    expect(decision).toMatchObject({ value: "California Energy Commission", review_status: "validated" });
    expect(decision.passage?.details).toMatchObject({ vote: "yes", date: "2026-12-03" });
    expect(v.facts.find((f) => f.field === "government.appointed_commissioner")?.review_status).toBe("unverified"); // date not in quote
  });

  it("files environmental findings and community impacts under their topic", () => {
    const v = validateExtraction({
      extraction: {
        ...withImpacts({
          air_quality: {
            metrics: [],
            findings: [{ kind: "concern", statement: "Forty-two diesel generators would be installed.", significance: null, doc: 0, quote: "a total of forty two (42) diesel-fired generators" }],
          },
        }),
        other_impacts: [{ topic: "community", kind: "finding", statement: "Site is 28.5 acres.", significance: null, doc: 0, quote: "The entire project site is approximately 28.5 acres." }],
      },
      docs,
      now: NOW,
    });
    expect(v.facts.find((f) => f.field === "consideration.air_quality.concern")?.review_status).toBe("validated");
    expect(v.facts.find((f) => f.field === "consideration.community.finding")?.review_status).toBe("validated");
  });
});

describe("dateInText", () => {
  it("matches common US date formats", () => {
    expect(dateInText("2026-12-17", "Comments due by December 17, 2026 at 5 p.m.")).toBe(true);
    expect(dateInText("2026-12-17", "Review period ends 12/17/2026")).toBe(true);
    expect(dateInText("2026-12-17", "Review period ends Dec. 17")).toBe(true);
    expect(dateInText("2026-12-17", "Review period ends December 7, 2026")).toBe(false);
  });
});

describe("status & deadlines", () => {
  it("maps CEQA document types", () => {
    expect(statusFromCeqaDocType("NOD - Notice of Determination")).toBe("approved");
    expect(statusFromCeqaDocType("EIR - Draft EIR")).toBe("under_review");
    expect(statusFromCeqaDocType("NOP - Notice of Preparation of a Draft EIR")).toBe("under_review");
    expect(statusFromCeqaDocType(null)).toBeNull();
  });
  it("uses Pacific end-of-day for date-only deadlines (DST aware)", () => {
    expect(endOfDayPacific("2026-12-17")).toBe("2026-12-17T23:59:59-08:00");
    expect(endOfDayPacific("2026-08-20")).toBe("2026-08-20T23:59:59-07:00");
  });
});
