import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { placeLabel, resolvePlace, suggestPlaces, type Place } from "@/lib/client/places";

// Real index built from U.S. Census TIGERweb (npm run gis:fetch).
const places = (JSON.parse(readFileSync("public/gis/ca-places.json", "utf8")) as { places: Place[] }).places;

describe("resolving a typed city or county", () => {
  it("finds cities regardless of accents, case, and common suffixes", () => {
    for (const q of ["San Jose", "san josé", "  SAN JOSE, CA ", "City of San Jose", "San Jose, California"]) {
      expect(resolvePlace(q, places)).toMatchObject({ name: "San Jose", kind: "city" });
    }
  });
  it("prefers the city over a same-named county unless 'County' is typed", () => {
    expect(resolvePlace("Fresno", places)?.kind).toBe("city");
    expect(resolvePlace("Fresno County", places)).toMatchObject({ name: "Fresno County", kind: "county" });
    expect(resolvePlace("County of Santa Clara", places)).toMatchObject({ name: "Santa Clara County", kind: "county" });
  });
  it("resolves counties that have no same-named city", () => {
    expect(resolvePlace("Kern", places)).toMatchObject({ name: "Kern County", kind: "county" });
  });
  it("resolves an exact suggestion label to that place", () => {
    const p = suggestPlaces("Mountain View", places).find((x) => x.kind === "community");
    if (p) expect(resolvePlace(placeLabel(p), places)).toEqual(p);
  });
  it("returns null for places outside the index instead of guessing", () => {
    expect(resolvePlace("Springfield", places)).toBeNull();
    expect(resolvePlace("", places)).toBeNull();
    expect(resolvePlace("Kern Countyy", places)).toBeNull();
  });
  it("gives every place a usable California bounding box", () => {
    for (const p of places) {
      const [w, s, e, n] = p.bbox;
      expect(w).toBeLessThan(e);
      expect(s).toBeLessThan(n);
      expect(w).toBeGreaterThan(-125);
      expect(e).toBeLessThan(-114);
    }
  });
});

describe("suggestions", () => {
  it("lists prefix matches with cities before counties and communities", () => {
    const s = suggestPlaces("san jo", places);
    expect(s[0]).toMatchObject({ name: "San Jose", kind: "city" });
    expect(s.length).toBeLessThanOrEqual(8);
  });
  it("only suggests counties when 'county' is typed", () => {
    expect(suggestPlaces("los angeles county", places).every((p) => p.kind === "county")).toBe(true);
  });
  it("waits for at least two characters", () => {
    expect(suggestPlaces("s", places)).toEqual([]);
  });
});
