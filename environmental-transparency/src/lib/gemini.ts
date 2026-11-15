import "server-only";
import { GoogleGenAI } from "@google/genai";
import type { ProjectExtraction } from "@/types/project";

export const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

export async function testGemini() {
  const response = await gemini.models.generateContent({
    model: process.env.GEMINI_MODEL!,
    contents: "Reply with exactly: Gemini connected",
  });

  return response.text;
}

// ---------------------------------------------------------------------------
// Structured extraction schema
// ---------------------------------------------------------------------------

const nullableString = (description: string) => ({
  type: ["string", "null"],
  description,
});

const nullableNumber = (description: string) => ({
  type: ["number", "null"],
  description,
});

const sourceQuote = nullableString(
  "Verbatim excerpt from the document that states this value. Null if the value is null.",
);

/** Builds an object schema where every property is required (so missing data comes back as null, not omitted). */
function object(properties: Record<string, unknown>, nullable = false, description?: string) {
  return {
    type: nullable ? ["object", "null"] : "object",
    ...(description ? { description } : {}),
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function list(items: Record<string, unknown>, description: string) {
  return { type: "array", description, items: object(items) };
}

const measurement = (description: string) =>
  object(
    {
      value: nullableNumber("Numeric amount exactly as reported."),
      unit: nullableString("Unit as reported, e.g. MW, MWh/yr, gallons/day, acre-feet/yr."),
      period: nullableString("Time basis if stated, e.g. annual, peak, daily."),
      description: nullableString("Short description of what the figure measures."),
      source_quote: sourceQuote,
    },
    true,
    description,
  );

export const projectExtractionSchema = object({
  project_name: nullableString("Official project name as written in the document."),
  project_type: nullableString(
    "Type of facility or project, e.g. data center, natural gas power plant, solar farm, warehouse, mine.",
  ),
  location: object(
    {
      address: nullableString("Street address."),
      city: nullableString("City or town."),
      county: nullableString("County."),
      state: nullableString("State or province."),
      country: nullableString("Country."),
      parcel_id: nullableString("Assessor parcel number(s), if listed."),
      latitude: nullableNumber("Latitude only if explicitly given in the document."),
      longitude: nullableNumber("Longitude only if explicitly given in the document."),
    },
    true,
    "Project site location.",
  ),
  reviewing_agency: object(
    {
      name: nullableString("Agency reviewing or permitting the project."),
      jurisdiction_level: {
        type: ["string", "null"],
        enum: ["federal", "state", "regional", "county", "municipal", "tribal", "other", null],
        description: "Level of government of the reviewing agency.",
      },
      case_or_permit_number: nullableString("Case, docket, application, or permit number."),
      contact: nullableString("Named contact person, email, or phone for the agency."),
    },
    true,
    "Lead agency reviewing the project.",
  ),
  reported_equipment: list(
    {
      name: nullableString("Equipment name as described."),
      equipment_type: nullableString("Category, e.g. backup diesel generator, cooling tower, turbine, transformer."),
      quantity: nullableNumber("Number of units as reported."),
      capacity: nullableString("Rated capacity with units, e.g. '3 MW each'."),
      fuel_type: nullableString("Fuel used, if stated."),
      source_quote: sourceQuote,
    },
    "Equipment explicitly listed in the document. Empty array if none.",
  ),
  emissions: list(
    {
      pollutant: nullableString("Pollutant or greenhouse gas, e.g. NOx, PM2.5, CO2e."),
      value: nullableNumber("Reported emission amount."),
      unit: nullableString("Unit, e.g. tons/year, lbs/day."),
      period: nullableString("Time basis, e.g. annual, operational, construction."),
      emission_source: nullableString("What produces the emission, e.g. generators, construction vehicles."),
      source_quote: sourceQuote,
    },
    "Reported emission figures. Empty array if none.",
  ),
  power_consumption: measurement("Reported electricity demand or consumption. Null if not reported."),
  water_consumption: measurement("Reported water use or consumption. Null if not reported."),
  air_quality_effects: list(
    {
      pollutant: nullableString("Pollutant concerned, if specified."),
      description: nullableString("Air quality impact described in the document."),
      significance: nullableString(
        "Significance finding as stated, e.g. 'less than significant', 'significant and unavoidable'.",
      ),
      mitigation: nullableString("Mitigation measures stated for this effect."),
      source_quote: sourceQuote,
    },
    "Air quality impacts described in the document. Empty array if none.",
  ),
  other_metrics: list(
    {
      name: nullableString("Metric name, e.g. building square footage, acreage, noise level, jobs, traffic trips."),
      value: nullableNumber("Reported numeric value."),
      unit: nullableString("Unit as reported."),
      description: nullableString("Context for the metric."),
      source_quote: sourceQuote,
    },
    "Other quantitative metrics reported in the document. Empty array if none.",
  ),
  associated_sources: list(
    {
      title: nullableString("Document or page title."),
      url: nullableString("URL exactly as it appears in the document or as provided."),
      document_type: nullableString("e.g. EIR, initial study, permit application, staff report, notice."),
      publisher: nullableString("Organization that published it."),
      publication_date: nullableString("Publication date in ISO 8601 (YYYY-MM-DD) if stated."),
    },
    "The source document itself plus any referenced documents. Empty array if none.",
  ),
  public_comment: object(
    {
      deadline: nullableString("Comment deadline in ISO 8601 (YYYY-MM-DD or full datetime) exactly as stated."),
      submission_method: nullableString("How to submit comments, e.g. email, mail, online portal."),
      submission_contact: nullableString("Email, mailing address, or URL for submitting comments."),
      source_quote: sourceQuote,
    },
    true,
    "Public comment period. Null unless the document explicitly states it.",
  ),
  hearings: list(
    {
      date: nullableString("Hearing date in ISO 8601 (YYYY-MM-DD)."),
      time: nullableString("Start time as stated, including time zone if given."),
      location: nullableString("Physical venue and address."),
      virtual_access: nullableString("Zoom/webcast link or dial-in, if given."),
      hearing_body: nullableString("Body holding the hearing, e.g. Planning Commission."),
      description: nullableString("Purpose of the hearing."),
      source_quote: sourceQuote,
    },
    "Scheduled public hearings explicitly stated in the document. Empty array if none.",
  ),
});

const EXTRACTION_INSTRUCTIONS = `You extract structured facts from environmental review and permitting documents.

Rules:
- Use ONLY information explicitly stated in the provided document. Never estimate, infer, calculate, or use outside knowledge.
- If a value is not stated, return null. For lists with nothing reported, return an empty array.
- Copy numbers exactly as reported; do not convert units or round.
- For every item with a source_quote field, include the verbatim excerpt that supports it. If you cannot quote it, the value must be null.
- Public comment deadlines and hearing details must be explicitly stated with a specific date. Do not guess dates from phrases like "in the coming weeks". If unclear, return null / an empty array.
- Dates use ISO 8601 when a full date is stated.`;

/**
 * Drops comment/hearing data that isn't backed by a quote from the document,
 * so unverifiable dates never reach the UI.
 */
function enforceVerifiable(data: ProjectExtraction): ProjectExtraction {
  const hasQuote = (q: string | null) => typeof q === "string" && q.trim().length > 0;

  return {
    ...data,
    public_comment:
      data.public_comment && hasQuote(data.public_comment.source_quote) ? data.public_comment : null,
    hearings: (data.hearings ?? []).filter((h) => hasQuote(h.source_quote) && h.date),
  };
}

export async function extractProjectData(
  documentText: string,
  sourceUrl?: string,
): Promise<ProjectExtraction> {
  const response = await gemini.models.generateContent({
    model: process.env.GEMINI_MODEL!,
    contents: [
      sourceUrl ? `Source URL: ${sourceUrl}` : "",
      "Document:",
      documentText,
    ]
      .filter(Boolean)
      .join("\n\n"),
    config: {
      systemInstruction: EXTRACTION_INSTRUCTIONS,
      temperature: 0,
      responseMimeType: "application/json",
      responseJsonSchema: projectExtractionSchema,
    },
  });

  if (!response.text) {
    throw new Error("Gemini returned an empty response");
  }

  return enforceVerifiable(JSON.parse(response.text) as ProjectExtraction);
}
