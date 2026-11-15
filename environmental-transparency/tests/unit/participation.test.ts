import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionTier,
  commentState,
  daysUntilPacific,
  formatPacific,
  hearingUpcoming,
  inBounds,
  pacificDate,
  participationGuide,
  prioritize,
  type Prioritizable,
} from "@/lib/participation";
import { endOfDayPacific } from "@/lib/pipeline/validate";
import { decodeFeed, groupBySch, mailingAddress, parseFeed } from "@/lib/campaign/ceqa-feed";
import { commentsFromFilings, contactFromFilings } from "@/lib/campaign/participation-records";
import type { DocumentRecord, FactRecord, ParticipationRecord, ProjectDetail } from "@/types/project";

const at = (iso: string) => Date.parse(iso);

describe("deadlines and timezones (Pacific calendar)", () => {
  // Agencies close comment periods at end of day Pacific: Dec 7 → 2026-12-08T07:59:59Z (PST).
  const dec7 = endOfDayPacific("2026-12-07");
  it("stores the deadline as 11:59:59 PM Pacific, across DST", () => {
    expect(dec7).toBe("2026-12-07T23:59:59-08:00");
    expect(endOfDayPacific("2026-07-15")).toBe("2026-07-15T23:59:59-07:00");
    expect(formatPacific(dec7)).toMatch(/Dec 7, 2026.*11:59\s?PM PST/);
  });
  it("is open through the last Pacific second and closed after", () => {
    expect(commentState(dec7, "2026-11-01", at("2026-12-08T07:59:58Z"))).toBe("open");
    expect(commentState(dec7, "2026-11-01", at("2026-12-08T08:00:00Z"))).toBe("closed");
  });
  it("is upcoming before its stated start day, even though the deadline is in the future", () => {
    expect(commentState(dec7, "2026-11-20", at("2026-11-19T20:00:00Z"))).toBe("upcoming");
    // 4:30 PM Pacific on Nov 19 is already Nov 20 in UTC; still Nov 19 in California.
    expect(commentState(dec7, "2026-11-20", at("2026-11-20T00:30:00Z"))).toBe("upcoming");
    expect(commentState(dec7, "2026-11-20", at("2026-11-20T08:30:00Z"))).toBe("open");
  });
  it("counts days left on the Pacific calendar, not the viewer's", () => {
    // 9 PM Pacific on Dec 6 (= 05:00Z Dec 7): the deadline is tomorrow.
    expect(daysUntilPacific(dec7, at("2026-12-07T05:00:00Z"))).toBe(1);
    expect(daysUntilPacific(dec7, at("2026-12-07T20:00:00Z"))).toBe(0);
    expect(pacificDate(at("2026-12-08T07:59:59Z"))).toBe("2026-12-07");
  });
  it("treats a hearing as upcoming through its Pacific calendar day", () => {
    expect(hearingUpcoming("2026-12-03", at("2026-12-04T07:00:00Z"))).toBe(true); // 11 PM Dec 3 PT
    expect(hearingUpcoming("2026-12-03", at("2026-12-04T09:00:00Z"))).toBe(false);
  });
});

describe("sidebar prioritization", () => {
  const base: Prioritizable = { id: "", canonical_name: "", status: "under_review", comment_status: "none", comment_deadline: null, comment_opens: null, next_hearing: null, latitude: 37, longitude: -122 };
  const mk = (id: string, o: Partial<Prioritizable>) => ({ ...base, id, canonical_name: id, ...o });
  const list = [
    mk("unknown", { status: "unknown" }),
    mk("approved", { status: "approved", comment_status: "closed", comment_deadline: "2026-01-01T07:59:59Z" }),
    mk("review-far", { latitude: 34, longitude: -118 }),
    mk("review-near", { latitude: 37.01, longitude: -122.01 }),
    mk("hearing", { next_hearing: "2026-12-10" }),
    mk("open-late", { comment_status: "open", comment_deadline: "2026-12-20T07:59:59Z" }),
    mk("open-soon", { comment_status: "open", comment_deadline: "2026-12-01T07:59:59Z" }),
    mk("upcoming", { comment_status: "upcoming", comment_deadline: "2027-01-10T07:59:59Z", comment_opens: "2026-12-05" }),
    mk("unmapped-review", { latitude: null, longitude: null }),
  ];
  it("orders: open by earliest deadline → upcoming/hearings → under review by distance → decided → unverified", () => {
    expect(prioritize(list, [-122, 37]).map((p) => p.id)).toEqual([
      "open-soon",
      "open-late",
      "upcoming",
      "hearing",
      "review-near",
      "review-far",
      "unmapped-review",
      "approved",
      "unknown",
    ]);
  });
  it("never ranks a closed or unverified window as actionable", () => {
    expect(actionTier(mk("x", { comment_status: "closed", comment_deadline: "2026-01-01T00:00:00Z" }))).toBe(3);
    expect(actionTier(mk("x", { comment_status: "unverified" }))).toBe(3);
    expect(actionTier(mk("x", { comment_status: "open", comment_deadline: null }))).toBe(3);
  });
  it("scopes to the visible map area", () => {
    expect(inBounds([-121.9, 37.4], [-122.1, 37.2, -121.7, 37.5])).toBe(true);
    expect(inBounds([-118.2, 34.0], [-122.1, 37.2, -121.7, 37.5])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Participate guide
// ---------------------------------------------------------------------------

const doc = (id: string, title: string): DocumentRecord => ({
  id,
  source_url: `https://ceqanet.lci.ca.gov/2026050302/${id}`,
  title,
  issuer: "Sacramento Municipal Utility District",
  publication_date: "2026-10-23",
  retrieved_at: "2026-11-15T00:00:00Z",
  content_hash: null,
  version: 1,
  retrieval_method: "direct_official_fetch",
  document_type: null,
});
const fact = (field: string, passage: unknown): FactRecord => ({ id: field, document_id: "d1", field, value: "x", unit: null, method: "parsed", page_or_passage: JSON.stringify(passage), review_status: "validated" });
const event = (o: Partial<ParticipationRecord>): ParticipationRecord => ({
  id: "e1",
  source_document_id: "d1",
  agency_name: "Sacramento Municipal Utility District",
  event_type: "comment_period",
  deadline_at: "2026-12-08T07:59:59Z",
  status: "open",
  official_submission_url: null,
  details: {},
  quote: "NOC Public Review End Date: 12/7/2026",
  ...o,
});
function project(o: Partial<ProjectDetail>): ProjectDetail {
  return {
    id: "p",
    canonical_name: "Jackson Bulk Substation Project",
    category: "power_infrastructure",
    status: "under_review",
    jurisdiction: "Sacramento County",
    latitude: 38.5,
    longitude: -121.3,
    location_precision: "reported_coordinates",
    last_checked_at: "2026-11-15T00:00:00Z",
    lead_agency: "Sacramento Municipal Utility District",
    comment_status: "none",
    comment_deadline: null,
    comment_opens: null,
    next_hearing: null,
    document_count: 1,
    sch_number: "2026050302",
    source_id: "SCH 2026050302",
    source_url: "https://ceqanet.lci.ca.gov/2026050302",
    index_level: "lightweight",
    description: null,
    developer: null,
    summary: null,
    documents: [doc("d1", "Jackson Bulk Substation Project (FIN)"), doc("d2", "Notice of Determination (NOD)")],
    facts: [],
    participation: [],
    impact_features: [],
    ...o,
  };
}
const NOW = at("2026-11-20T18:00:00Z");

describe("participation guide", () => {
  it("shows every item as missing when the records state nothing (never invents)", () => {
    const g = participationGuide(project({ lead_agency: null }), NOW);
    expect(g.comment).toBeNull();
    expect(g.contact).toBeNull();
    expect(g.hearings.upcoming).toEqual([]);
    expect(g.missing).toEqual(
      expect.arrayContaining(["Responsible agency", "Agency contact person, email, phone and mailing address", "Public comment period and deadline", "Online comment form or portal", "Upcoming public hearing"]),
    );
    expect(g.nextSteps).toEqual([]);
  });
  it("uses only stated official channels: portal URL vs email, and rejects malformed ones", () => {
    const portal = participationGuide(project({ participation: [event({ official_submission_url: "https://planning.saccounty.gov/comment", details: { submit_source: "stated in notice", start: "2026-11-01" } })] }), NOW);
    expect(portal.comment!.submission).toMatchObject({ kind: "portal", href: "https://planning.saccounty.gov/comment", source: "stated in notice" });
    const email = participationGuide(project({ participation: [event({ official_submission_url: "mailto:planner@smud.org" })] }), NOW);
    expect(email.comment!.submission).toMatchObject({ kind: "email", href: "mailto:planner@smud.org", display: "planner@smud.org" });
    expect(email.missing).toContain("Online comment form or portal");
    for (const bad of ["javascript:alert(1)", "mailto:not-an-email", "ftp://x.gov/a"]) {
      expect(participationGuide(project({ participation: [event({ official_submission_url: bad })] }), NOW).comment!.submission).toBeNull();
    }
  });
  it("prefers an open window over older closed ones and keeps the history", () => {
    const g = participationGuide(
      project({
        participation: [event({ id: "old", deadline_at: "2026-06-01T06:59:59Z" }), event({ id: "now", deadline_at: "2026-12-08T07:59:59Z", details: { start: "2026-11-07" } })],
      }),
      NOW,
    );
    expect(g.comment!.event.id).toBe("now");
    expect(g.comment!.state).toBe("open");
    expect(g.comment!.daysLeft).toBe(17);
    expect(g.earlierComments.map((w) => w.event.id)).toEqual(["old"]);
  });
  it("gives next steps for a closed period, different once the project is approved", () => {
    const closed = participationGuide(project({ participation: [event({ deadline_at: "2026-06-01T06:59:59Z" })] }), NOW);
    expect(closed.comment!.state).toBe("closed");
    expect(closed.nextSteps.join(" ")).toMatch(/closed on .*May 31, 2026/);
    const decided = participationGuide(project({ status: "approved", participation: [event({ deadline_at: "2026-06-01T06:59:59Z" })] }), NOW);
    expect(decided.nextSteps[0]).toMatch(/recorded a decision/);
  });
  it("reads the agency contact and department from the validated contact fact only", () => {
    const contactFact = fact("participation.lead_agency_contact", {
      details: { name: "Rob Ferrera", title: "Environmental Specialist", agency: "Sacramento Municipal Utility District", department: "Environmental Services", email: "rob@smud.org", phone: "(916) 732-6676", address: "6201 S Street, Sacramento, CA 95817" },
    });
    const g = participationGuide(project({ facts: [contactFact, { ...contactFact, id: "u", review_status: "unverified", page_or_passage: JSON.stringify({ details: { email: "fake@x.com" } }) }] }), NOW);
    expect(g.contact).toMatchObject({ name: "Rob Ferrera", email: "rob@smud.org", address: "6201 S Street, Sacramento, CA 95817" });
    expect(g.department).toBe("Environmental Services");
    expect(g.missing.some((m) => /contact|email|phone|address/i.test(m))).toBe(false);
  });
  it("splits upcoming and past hearings and keeps stated details", () => {
    const g = participationGuide(
      project({
        participation: [
          event({ id: "h1", event_type: "hearing", deadline_at: "2026-12-03T20:00:00Z", details: { date: "2026-12-03", time: "6:00 PM", body: "Board of Directors", location: "6201 S Street", virtual: "https://smud.zoom.us/j/123" } }),
          event({ id: "h0", event_type: "hearing", deadline_at: "2026-09-01T19:00:00Z", details: { date: "2026-09-01" } }),
        ],
      }),
      NOW,
    );
    expect(g.hearings.upcoming).toMatchObject([{ date: "2026-12-03", time: "6:00 PM", body: "Board of Directors", virtual: "https://smud.zoom.us/j/123" }]);
    expect(g.hearings.past.map((h) => h.date)).toEqual(["2026-09-01"]);
    expect(g.missing).not.toContain("Upcoming public hearing");
  });
  it("lists notices ahead of other source documents", () => {
    expect(participationGuide(project({}), NOW).notices[0].title).toMatch(/Notice of Determination/);
  });
});

describe("participation from statewide filings (real CEQAnet export rows)", () => {
  const filings = parseFeed(decodeFeed(readFileSync(join(__dirname, "../fixtures/ceqanet-export-sample.csv"))));
  const afton = groupBySch(filings).find((g) => g.sch === "2026110368")!.filings;
  it("reads contact person, department, email, phone and mailing address exactly as filed", () => {
    const c = contactFromFilings(afton)!;
    expect(c.details).toMatchObject({
      name: "Elena Barragan",
      title: "Principal Planner",
      agency: "San Bernardino County",
      department: "Land Use Services Planning",
      email: "elena.barragan@lus.sbcounty.gov",
      phone: "(909) 387-4422",
      address: "385 N Arrowhead, San Bernardino, CA 92415",
    });
  });
  it("creates a comment window only from a stated end date, closing 11:59 PM Pacific", () => {
    const [w] = commentsFromFilings(afton, contactFromFilings(afton));
    expect(w).toMatchObject({ start: "2026-11-05", end: "2026-12-04", deadlineAt: "2026-12-04T23:59:59-08:00", submissionUrl: "mailto:elena.barragan@lus.sbcounty.gov" });
    const nod = groupBySch(filings).find((g) => g.sch === "2026050302")!.filings.filter((f) => f.docType === "NOD");
    expect(commentsFromFilings(nod, null)).toEqual([]);
  });
  it("formats addresses without duplicating a repeated second line", () => {
    expect(mailingAddress({ "Contact Address 1": "385 N Arrowhead", "Contact Address 2": "385 N Arrowhead", "Contact City": "San Bernardino", "Contact State": "CA", "Contact Zip Code": "92415" })).toBe("385 N Arrowhead, San Bernardino, CA 92415");
    expect(mailingAddress({})).toBeNull();
  });
});
