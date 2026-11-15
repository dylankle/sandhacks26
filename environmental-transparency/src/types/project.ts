import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const PROJECT_CATEGORIES = [
  "data_center",
  "power_infrastructure",
  "warehouse_logistics",
  "industrial",
  "transportation",
  "other",
] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];

export const PROJECT_STATUSES = [
  "proposed",
  "under_review",
  "approved",
  "denied",
  "withdrawn",
  "under_construction",
  "operational",
  "unknown",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TOPICS = [
  "air_quality",
  "greenhouse_gas",
  "energy",
  "water",
  "noise",
  "traffic",
  "hazards",
  "land_use",
  "biological",
  "community",
  "economic",
  "other",
] as const;
export type Topic = (typeof TOPICS)[number];

export const TOPIC_LABELS: Record<Topic, string> = {
  air_quality: "Air quality",
  greenhouse_gas: "Greenhouse gases",
  energy: "Energy",
  water: "Water use",
  noise: "Noise",
  traffic: "Traffic",
  hazards: "Hazards",
  land_use: "Land use & scale",
  biological: "Biology & habitat",
  community: "Community",
  economic: "Economic",
  other: "Other",
};

export const CATEGORY_LABELS: Record<ProjectCategory, string> = {
  data_center: "Data center",
  power_infrastructure: "Power infrastructure",
  warehouse_logistics: "Warehouse & logistics",
  industrial: "Industrial",
  transportation: "Major transportation",
  other: "Other development",
};

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  proposed: "Proposed",
  under_review: "Under review",
  approved: "Approved",
  denied: "Denied",
  withdrawn: "Withdrawn",
  under_construction: "Under construction",
  operational: "Operational",
  unknown: "Status unverified",
};

// ---------------------------------------------------------------------------
// Gemini extraction contract: the JSON every scraped document set (Bright Data
// Web Unlocker / SERP results, CEQAnet, Legistar) is turned into.
//
// Sections: project · summary · timeline · cost_estimates · environmental_impacts
//           · other_impacts · proponents · government · public_participation
//
// Every field is required; unknown → null / []. `doc` is the 0-based index of
// the source document a claim came from and `quote` must be verbatim text from
// that document (verified deterministically in pipeline/validate.ts).
// ---------------------------------------------------------------------------

/** Environmental cost categories broken out in `environmental_impacts`. */
export const ENVIRONMENTAL_TOPICS = [
  "noise",
  "air_quality",
  "greenhouse_gas",
  "water",
  "energy",
  "traffic",
  "hazards",
  "biological",
  "land_use",
] as const satisfies readonly Topic[];
export type EnvironmentalTopic = (typeof ENVIRONMENTAL_TOPICS)[number];

export const TIMELINE_PHASES = [
  "application",
  "environmental_review",
  "public_comment",
  "hearing",
  "decision",
  "construction",
  "operation",
  "other",
] as const;
export type TimelinePhase = (typeof TIMELINE_PHASES)[number];

export const COST_CATEGORIES = [
  "total_project",
  "construction",
  "land_acquisition",
  "infrastructure_upgrades",
  "annual_operating",
  "mitigation",
  "public_funding",
  "tax_revenue",
  "fees",
  "other",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const PROPONENT_ROLES = ["applicant", "developer", "property_owner", "operator", "public_agency", "consultant", "other"] as const;
export type ProponentRole = (typeof PROPONENT_ROLES)[number];

export const GOVERNMENT_ROLES = [
  "lead_agency",
  "decision_maker",
  "elected_official",
  "appointed_commissioner",
  "agency_staff",
  "responsible_agency",
  "trustee_agency",
  "commenting_agency",
  "other",
] as const;
export type GovernmentRole = (typeof GOVERNMENT_ROLES)[number];

export const VOTES = ["yes", "no", "abstain", "absent", "recused"] as const;

const str = z.string().nullable();
const doc = z.number().int().min(0).max(20);
const quote = z.string();

const impactMetric = z.object({
  name: z.string().describe("Short metric name, e.g. 'Construction noise at nearest residence', 'Annual water demand'."),
  value: z.number(),
  unit: z.string().describe("Unit as reported, e.g. dBA, lbs/day, MTCO2e/year, gallons/day, acre-feet/year, MW, MWh/year, daily trips."),
  context: str.describe("Brief qualifier, e.g. 'construction phase', 'operational', 'each generator', 'peak'."),
  doc,
  quote,
});

const impactFinding = z.object({
  kind: z.enum(["concern", "finding", "mitigation", "benefit"]),
  statement: z.string().describe("One-sentence paraphrase faithful to the quote."),
  significance: str.describe("Stated CEQA significance finding if any, e.g. 'less than significant with mitigation'."),
  doc,
  quote,
});

const impact = (what: string) =>
  z
    .object({
      metrics: z.array(impactMetric).describe("Quantities explicitly reported. Never compute or convert."),
      findings: z.array(impactFinding),
    })
    .describe(what);

export const extractionSchema = z.object({
  project: z.object({
    name: str.describe("Official project name exactly as written."),
    category: z.enum(PROJECT_CATEGORIES).describe("Best-fitting category based only on the documents."),
    case_numbers: z.array(z.string()).describe("Planning file, permit, docket, or SCH numbers as written."),
    location: z.object({
      city: str.describe("City where the project site is located."),
      county: str,
      address: str.describe("Street address(es) of the site."),
      parcel_numbers: str.describe("Assessor parcel number(s) as written."),
    }),
  }),

  summary: z.object({
    description: str.describe("1–3 sentence factual description of what is proposed, using only document content."),
    plain_language: str.describe(
      "2–4 sentence plain-language explanation for a resident with no planning background. Explain what is proposed and where the process stands. No speculation.",
    ),
    status: z.enum(PROJECT_STATUSES).describe("Procedural status supported by the documents; 'unknown' if unclear."),
    status_quote: str.describe("Verbatim text supporting the status, else null."),
    status_doc: doc.nullable(),
  }),

  timeline: z
    .array(
      z.object({
        label: z.string().describe("What happened or is scheduled, e.g. 'Draft EIR public review begins', 'Construction expected to begin'."),
        date: z.string().describe("ISO 8601 date YYYY-MM-DD."),
        phase: z.enum(TIMELINE_PHASES),
        doc,
        quote,
      }),
    )
    .describe("Explicitly stated dates: filings, review periods, hearings, approvals, construction start/finish, operation."),

  cost_estimates: z
    .array(
      z.object({
        label: z.string().describe("What the money is for, e.g. 'Total project investment', 'PG&E substation upgrade'."),
        category: z.enum(COST_CATEGORIES),
        amount: z.number().describe("Number exactly as written in the quote (e.g. '$1.2 billion' → 1.2, '$450,000' → 450000)."),
        unit: z.string().describe("Currency and scale as written, e.g. 'USD', 'million USD', 'billion USD', 'USD/year'."),
        paid_by: str.describe("Who pays or receives it, if stated (e.g. applicant, city general fund, ratepayers)."),
        context: str.describe("Brief qualifier, e.g. 'estimated', 'annual', 'phase 1'."),
        doc,
        quote,
      }),
    )
    .describe("Monetary figures explicitly stated: project cost, public spending, fees, tax revenue. Never estimate."),

  environmental_impacts: z
    .object({
      noise: impact("Noise and vibration: dBA levels, generator/cooling noise, construction noise."),
      air_quality: impact("Air pollution: criteria pollutants (NOx, PM2.5, PM10, ROG, CO), diesel generators, toxic air contaminants, health risk."),
      greenhouse_gas: impact("Greenhouse gas emissions (MTCO2e)."),
      water: impact("Water consumption, cooling water, wastewater, stormwater, groundwater, hydrology."),
      energy: impact("Electricity demand and capacity (MW, MWh), backup generation, grid upgrades, fuel use."),
      traffic: impact("Vehicle and truck trips, VMT, transportation."),
      hazards: impact("Hazardous materials, fuel storage, fire, contamination."),
      biological: impact("Habitat, wildlife, trees, wetlands."),
      land_use: impact("Site size, building area, height, zoning, aesthetics, light."),
    })
    .describe("Environmental costs grouped by type. Leave a category's arrays empty when the documents don't address it."),

  other_impacts: z
    .array(impactFinding.extend({ topic: z.enum(["community", "economic", "other"]) }))
    .describe("Documented community or economic considerations (jobs, schools, displacement, public services)."),

  proponents: z
    .array(
      z.object({
        name: z.string().describe("Company, organization, or agency proposing the project, exactly as written."),
        role: z.enum(PROPONENT_ROLES),
        representative: str.describe("Named contact person for the proponent, if stated."),
        doc,
        quote,
      }),
    )
    .describe("Entities proposing, developing, owning, or operating the project."),

  government: z.object({
    lead_agency: str.describe("Agency reviewing / approving the project (CEQA lead agency)."),
    participants: z
      .array(
        z.object({
          name: str.describe("Person's name exactly as written; null if only a body or agency is named."),
          title: str.describe("Title as written, e.g. 'Planning Director', 'Councilmember, District 4'."),
          body: z.string().describe("Agency, department, board, commission, or council, e.g. 'San José City Council'."),
          role: z.enum(GOVERNMENT_ROLES),
          action: z.string().describe("What they did, e.g. 'Voted to approve the rezoning', 'Prepared the staff report', 'Submitted comments on the Draft EIR'."),
          vote: z.enum(VOTES).nullable().describe("Recorded vote, only if stated."),
          date: str.describe("ISO date of the action, only if stated."),
          doc,
          quote,
        }),
      )
      .describe("Government officials, bodies, and agencies that reviewed, discussed, voted on, or approved the project."),
  }),

  public_participation: z.object({
    comment_period: z
      .object({
        start: str.describe("ISO date if stated."),
        end: str.describe("ISO date the comment period closes, only if explicitly stated."),
        submit_to: str.describe("Email, mailing address, or URL for comments exactly as written."),
        doc,
        quote,
      })
      .nullable()
      .describe("Public comment / review period. Null unless explicitly stated."),
    hearings: z.array(
      z.object({
        date: z.string().describe("ISO date."),
        time: str,
        body: str.describe("e.g. Planning Commission, City Council, Development Review Hearing."),
        location: str,
        online: str.describe("Online meeting link, webinar ID, or call-in details exactly as written, else null."),
        doc,
        quote,
      }),
    ),
  }),
});

export type Extraction = z.infer<typeof extractionSchema>;

// ---------------------------------------------------------------------------
// App-facing records (API responses)
// ---------------------------------------------------------------------------

export type ReviewStatus = "validated" | "unverified";

export interface FactRecord {
  id: string;
  document_id: string | null;
  field: string;
  value: string | null;
  unit: string | null;
  method: string | null;
  page_or_passage: string | null;
  review_status: ReviewStatus | string;
}

export interface DocumentRecord {
  id: string;
  source_url: string;
  title: string | null;
  issuer: string | null;
  publication_date: string | null;
  retrieved_at: string;
  content_hash: string | null;
  version: number;
  retrieval_method: string | null;
  document_type: string | null;
}

export interface ParticipationRecord {
  id: string;
  source_document_id: string | null;
  agency_name: string | null;
  event_type: "comment_period" | "hearing" | string;
  deadline_at: string | null;
  status: string;
  official_submission_url: string | null;
  details: Record<string, string>;
  quote: string | null;
}

export interface ImpactFeatureRecord {
  id: string;
  source_document_id: string | null;
  category: string;
  geojson: GeoJSON.Feature | GeoJSON.FeatureCollection | null;
  baseline_or_proposed: "baseline" | "proposed" | string | null;
  spatial_meaning: string | null;
}

export interface ProjectSummary {
  id: string;
  canonical_name: string;
  category: ProjectCategory | string | null;
  status: ProjectStatus | string;
  jurisdiction: string | null;
  latitude: number | null;
  longitude: number | null;
  location_precision: string;
  last_checked_at: string;
  lead_agency: string | null;
  comment_status: "open" | "upcoming" | "closed" | "unverified" | "none";
  /** Verified deadline instant (UTC ISO; agencies set it as end of day Pacific). */
  comment_deadline: string | null;
  /** Verified start date (YYYY-MM-DD) of a comment window that has not opened yet. */
  comment_opens: string | null;
  /** Date (YYYY-MM-DD, Pacific) of the next verified public hearing. */
  next_hearing: string | null;
  document_count: number;
  sch_number: string | null;
  /** Stable ID of the original filing (e.g. "SCH 2024070671" or an agency case number). */
  source_id: string | null;
  /** Government URL for the original filing or posting (CEQAnet page when an SCH number exists). */
  source_url: string | null;
  /** lightweight = structured State Clearinghouse fields only; enriched = documents read and claims verified. */
  index_level: "lightweight" | "enriched";
}

export interface ProjectDetail extends ProjectSummary {
  description: string | null;
  developer: string | null;
  summary: string | null;
  documents: DocumentRecord[];
  facts: FactRecord[];
  participation: ParticipationRecord[];
  impact_features: ImpactFeatureRecord[];
}
