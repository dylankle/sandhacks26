import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attachmentPriority, htmlToText, parseCeqaNet, parseDmsPair, parseLegistar } from "@/lib/sources/parse";

const ceqaHtml = readFileSync("tests/fixtures/ceqanet-2024070671.html", "utf8");
const legistarHtml = readFileSync("tests/fixtures/legistar-21-956.html", "utf8");

describe("parseDmsPair", () => {
  it("converts DMS coordinates to signed decimal degrees", () => {
    const c = parseDmsPair(`37°22'29.8"N 121°57'17.3"W`)!;
    expect(c.lat).toBeCloseTo(37.374944, 5);
    expect(c.lng).toBeCloseTo(-121.954806, 5);
  });
  it("accepts decimal pairs and rejects garbage", () => {
    expect(parseDmsPair("37.381, -121.934")).toEqual({ lat: 37.381, lng: -121.934 });
    expect(parseDmsPair("somewhere in Santa Clara")).toBeNull();
  });
});

describe("parseCeqaNet (real State Clearinghouse page)", () => {
  const p = parseCeqaNet(ceqaHtml, "https://ceqanet.lci.ca.gov/2024070671");
  it("extracts identity and procedural fields", () => {
    expect(p.schNumber).toBe("2024070671");
    expect(p.title).toBe("1231 Comstock Prime Data Center");
    expect(p.fields["Document Type"]).toMatch(/^MND/);
    expect(p.fields["Schools"]).toContain("Bracher Elementary School");
  });
  it("extracts machine-readable review dates", () => {
    expect(p.dates["Public Review Period Start"]).toBe("2024-07-19");
    expect(p.dates["Public Review Period End"]).toBe("2024-08-19");
  });
  it("extracts reported coordinates", () => {
    expect(p.coordinates?.lat).toBeCloseTo(37.3749, 3);
    expect(p.coordinates?.lng).toBeCloseTo(-121.9548, 3);
  });
  it("extracts the lead agency contact separately from consultants", () => {
    const lead = p.contacts.find((c) => /Lead\/Public Agency/.test(c.types ?? ""));
    expect(lead?.email).toBe("dsobczak@santaclaraca.gov");
    expect(p.contacts.some((c) => /Consulting/.test(c.types ?? ""))).toBe(true);
  });
  it("lists attachments with sizes and ranks notices first", () => {
    expect(p.attachments.length).toBe(6);
    const notice = p.attachments.find((a) => /NOI/.test(a.title))!;
    expect(notice.sizeKb).toBe(113);
    expect(attachmentPriority(notice.title)).toBeGreaterThan(attachmentPriority("Appendices A-I _Compiled"));
  });
});

describe("parseLegistar (real City of Santa Clara record)", () => {
  const l = parseLegistar(legistarHtml, "https://santaclara.legistar.com/LegislationDetail.aspx?ID=5065822");
  it("extracts file number, title, and absolute attachment URLs", () => {
    expect(l.fileNumber).toBe("21-956");
    expect(l.title).toMatch(/2600 De La Cruz/);
    expect(l.attachments.length).toBeGreaterThanOrEqual(5);
    expect(l.attachments[0].url).toMatch(/^https:\/\/santaclara\.legistar\.com\/View\.ashx\?M=F&ID=\d+/);
  });
});

describe("htmlToText", () => {
  it("drops scripts and decodes entities", () => {
    expect(htmlToText("<p>A&amp;B</p><script>alert(1)</script><div>37&#176;</div>")).toBe("A&B\n37°");
  });
});
