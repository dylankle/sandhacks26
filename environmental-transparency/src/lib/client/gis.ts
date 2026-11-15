/** Baseline GIS layer metadata and indicator definitions (client-safe). */

export type CesIndicator = "CIscoreP" | "dieselP" | "pmP" | "trafficP" | "asthmaP";

export interface IndicatorMeta {
  label: string;
  short: string;
  description: string;
  /** Raw (non-percentile) field in the dataset and how to present it. */
  raw: string;
  unit: string;
  digits: number;
}

/**
 * The map is shaded by each indicator's statewide percentile (0–100), which is how OEHHA ranks tracts.
 * Raw values are shown with units in tract popups. Units follow OEHHA's CalEnviroScreen 4.0 documentation.
 */
export const CES_INDICATORS: Record<CesIndicator, IndicatorMeta> = {
  CIscoreP: {
    label: "CalEnviroScreen score",
    short: "Overall burden",
    description: "Combined pollution burden × population characteristics score, ranked statewide. Higher = more burdened relative to other California tracts.",
    raw: "CIscore",
    unit: "score (unitless)",
    digits: 1,
  },
  dieselP: {
    label: "Diesel particulate matter",
    short: "Diesel PM",
    description: "Modeled diesel PM emissions from on-road and non-road sources (2016), ranked statewide.",
    raw: "diesel",
    unit: "tons/yr (2016 emissions, per OEHHA 4.0)",
    digits: 2,
  },
  pmP: {
    label: "PM2.5 concentration",
    short: "PM2.5",
    description: "Annual mean fine particulate concentration averaged over 2015–2017 (monitors + satellite), ranked statewide.",
    raw: "pm",
    unit: "µg/m³ annual mean",
    digits: 2,
  },
  trafficP: {
    label: "Traffic density",
    short: "Traffic",
    description: "Traffic volume on roads within 150 m of the tract divided by road length (2017), ranked statewide.",
    raw: "traffic",
    unit: "vehicle-km per road-km",
    digits: 0,
  },
  asthmaP: {
    label: "Asthma ED visits",
    short: "Asthma",
    description: "Age-adjusted rate of emergency department visits for asthma, 2015–2017, ranked statewide.",
    raw: "asthma",
    unit: "visits per 10,000 (age-adjusted)",
    digits: 1,
  },
};

export function formatRaw(ind: CesIndicator, props: Record<string, unknown>): string {
  const meta = CES_INDICATORS[ind];
  const v = Number(props[meta.raw]);
  return Number.isFinite(v) && v >= 0 ? `${v.toLocaleString("en-US", { maximumFractionDigits: meta.digits, minimumFractionDigits: meta.digits })} ${meta.unit}` : "No data";
}

export const DATASETS = {
  ces: {
    name: "CalEnviroScreen 4.0",
    publisher: "California Office of Environmental Health Hazard Assessment (OEHHA)",
    url: "https://oehha.ca.gov/calenviroscreen/report/calenviroscreen-40",
    limitations: [
      "Describes existing cumulative conditions by census tract, published October 2021 with data mostly from 2015–2019.",
      "It does not measure, predict, or attribute effects of any proposed project.",
      "Tract-level values smooth over block-by-block differences.",
    ],
  },
  schools: {
    name: "California Public Schools 2025-26",
    publisher: "California Department of Education",
    url: "https://catalog.data.gov/dataset/california-public-schools-2025-26",
    limitations: [
      "Active public K-12 school sites only. Private schools and childcare centers are not included.",
      "Distance to a school is a geographic relationship, not evidence of exposure.",
    ],
  },
} as const;

/** Percentile ramp (light → dark), matching OEHHA's convention of darker = more burdened. */
export const CES_RAMP: [number, string][] = [
  [0, "#f4efe4"],
  [20, "#ead9b8"],
  [40, "#e2b98a"],
  [60, "#d68f5e"],
  [80, "#c0603f"],
  [90, "#9c3a2c"],
];

export const STATUS_COLORS: Record<string, string> = {
  proposed: "#b7791f",
  under_review: "#6d4bd8",
  approved: "#2f6f5e",
  denied: "#6b7280",
  withdrawn: "#6b7280",
  under_construction: "#1f5fa8",
  operational: "#334155",
  unknown: "#6b7280",
};

/** Category landmark styles (marker fill + lucide icon name). */
export const CATEGORY_STYLES: Record<string, { color: string; icon: "server" | "zap" | "factory" | "warehouse" | "route" | "building" }> = {
  data_center: { color: "#2b4c7e", icon: "server" },
  power_infrastructure: { color: "#c2410c", icon: "zap" },
  industrial: { color: "#5b4636", icon: "factory" },
  warehouse_logistics: { color: "#0f766e", icon: "warehouse" },
  transportation: { color: "#7c3aed", icon: "route" },
  other: { color: "#57534e", icon: "building" },
};

export const SCHOOL_COLOR = "#24517a";
/** Vicinity used for neighboring tracts and school context around a selected site. */
export const VICINITY_KM = 3;
/** Envelope used by scripts/fetch-gis.mjs; the "Full region" baseline view frames this area. */
export const STUDY_AREA: [number, number, number, number] = [-122.1, 37.28, -121.78, 37.47];
