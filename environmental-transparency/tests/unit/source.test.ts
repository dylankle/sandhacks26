import { describe, expect, it } from "vitest";
import { primarySource } from "@/lib/source";
import { fmtMoney } from "@/lib/client/facts";

describe("primarySource", () => {
  it("prefers the State Clearinghouse number and its CEQAnet page", () => {
    expect(primarySource({ sch_number: "2024070671", documents: [{ source_url: "https://sanjoseca.gov/doc.pdf" }], case_numbers: ["PDC24-012"] })).toEqual({
      id: "SCH 2024070671",
      url: "https://ceqanet.lci.ca.gov/2024070671",
      label: "State Clearinghouse (CEQAnet)",
    });
  });
  it("falls back to the earliest official document and a local case number", () => {
    const s = primarySource({
      sch_number: null,
      documents: [
        { source_url: "https://sanjose.legistar.com/later", retrieved_at: "2026-11-10T00:00:00Z" },
        { source_url: "https://www.sanjoseca.gov/first.pdf", retrieved_at: "2026-10-01T00:00:00Z" },
      ],
      case_numbers: ["PDC24-012"],
    });
    expect(s).toEqual({ id: "PDC24-012", url: "https://www.sanjoseca.gov/first.pdf", label: "Agency case / file number" });
  });
  it("labels the posting by host when no ID is known, and stays null with nothing to go on", () => {
    expect(primarySource({ sch_number: null, documents: [{ source_url: "https://www.sanjoseca.gov/a.pdf" }] }).label).toBe("Original posting (sanjoseca.gov)");
    expect(primarySource({ sch_number: null })).toEqual({ id: null, url: null, label: "No official source recorded" });
  });
});

describe("fmtMoney", () => {
  it("formats stated amounts without converting them", () => {
    expect(fmtMoney("450", "million USD")).toBe("$450 million");
    expect(fmtMoney("1.2", "billion USD")).toBe("$1.2 billion");
    expect(fmtMoney("450000", "USD")).toBe("$450,000");
    expect(fmtMoney("2.5", "million USD/year")).toBe("$2.5 million/year");
    expect(fmtMoney("10", "euros")).toBe("10 euros");
  });
});
