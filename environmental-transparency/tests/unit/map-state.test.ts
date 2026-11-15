import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_LAYERS, LAYER_GROUPS, layerPlan, pointsNear, vicinityOf } from "@/lib/client/map-state";

const ces = JSON.parse(readFileSync("public/gis/calenviroscreen.geojson", "utf8"));
const schools = JSON.parse(readFileSync("public/gis/schools.geojson", "utf8"));
const MONTAGUE: [number, number] = [-121.930293, 37.398585]; // reported CEQAnet coordinates

const on = (plan: Record<string, boolean>, group: keyof typeof LAYER_GROUPS) => LAYER_GROUPS[group].every((id) => plan[id]);
const off = (plan: Record<string, boolean>, group: keyof typeof LAYER_GROUPS) => LAYER_GROUPS[group].every((id) => !plan[id]);

describe("layerPlan", () => {
  it("explore view shows only project markers (no baseline, no schools)", () => {
    const plan = layerPlan({ view: "explore", mode: "existing", layers: { ...DEFAULT_LAYERS, schools: true }, hasSite: false });
    expect(on(plan, "projects")).toBe(true);
    for (const g of ["ces", "schools", "reported", "ring"] as const) expect(off(plan, g)).toBe(true);
  });
  it("project view (Overview etc.) keeps the map uncluttered", () => {
    const plan = layerPlan({ view: "project", mode: "existing", layers: DEFAULT_LAYERS, hasSite: true });
    expect(off(plan, "ces")).toBe(true);
    expect(off(plan, "schools")).toBe(true);
  });
  it("impacts activates the baseline; schools stay off until enabled", () => {
    const plan = layerPlan({ view: "impacts", mode: "existing", layers: DEFAULT_LAYERS, hasSite: true });
    expect(on(plan, "ces")).toBe(true);
    expect(off(plan, "schools")).toBe(true);
    expect(off(plan, "ring")).toBe(true);
    const withSchools = layerPlan({ view: "impacts", mode: "existing", layers: { ...DEFAULT_LAYERS, schools: true }, hasSite: true });
    expect(on(withSchools, "schools")).toBe(true);
  });
  it("proposed keeps the baseline visible and adds project-record overlays", () => {
    const plan = layerPlan({ view: "impacts", mode: "proposed", layers: DEFAULT_LAYERS, hasSite: true });
    expect(on(plan, "ces")).toBe(true);
    expect(on(plan, "reported")).toBe(true);
    expect(on(plan, "ring")).toBe(true);
  });
  it("development markers are always visible in every view", () => {
    for (const view of ["explore", "project", "impacts"] as const) {
      expect(on(layerPlan({ view, mode: "proposed", layers: DEFAULT_LAYERS, hasSite: true }), "projects")).toBe(true);
    }
    expect("sites" in DEFAULT_LAYERS).toBe(false);
  });
  it("nothing environmental renders without a located site", () => {
    const plan = layerPlan({ view: "impacts", mode: "proposed", layers: DEFAULT_LAYERS, hasSite: false });
    expect(off(plan, "ces")).toBe(true);
    expect(off(plan, "reported")).toBe(true);
  });
});

describe("vicinityOf (real CalEnviroScreen tracts)", () => {
  const v = vicinityOf(ces, MONTAGUE, 3);
  it("finds the tract containing the site and its neighbors", () => {
    expect(v.siteTract).toBe(6085505006);
    expect(v.siteProps?.dieselP).toBeGreaterThan(80);
    expect(v.nearTracts.length).toBeGreaterThan(3);
    expect(v.nearTracts).not.toContain(v.siteTract);
    expect(v.nearTracts.length).toBeLessThan(ces.features.length / 2);
  });
  it("returns an empty vicinity without a site", () => {
    expect(vicinityOf(ces, null, 3)).toEqual({ siteTract: null, siteProps: null, nearTracts: [], bbox: null });
  });
  it("limits schools to the vicinity", () => {
    const near = pointsNear(schools.features, MONTAGUE, 3);
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThan(schools.features.length / 3);
  });
});
