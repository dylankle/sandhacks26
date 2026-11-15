export interface Project {
  id: string;
  name: string;
}

/**
 * Structured data Gemini extracts from a source document.
 * Every field is always present; anything the document does not state is `null`
 * (or an empty array for lists). Values are never estimated.
 */

/** A reported quantity. `source_quote` is the verbatim text it came from. */
export interface Measurement {
  value: number | null;
  unit: string | null;
  period: string | null;
  description: string | null;
  source_quote: string | null;
}

export interface ProjectLocation {
  address: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  country: string | null;
  parcel_id: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ReviewingAgency {
  name: string | null;
  jurisdiction_level: "federal" | "state" | "regional" | "county" | "municipal" | "tribal" | "other" | null;
  case_or_permit_number: string | null;
  contact: string | null;
}

export interface Equipment {
  name: string | null;
  equipment_type: string | null;
  quantity: number | null;
  capacity: string | null;
  fuel_type: string | null;
  source_quote: string | null;
}

export interface Emission {
  pollutant: string | null;
  value: number | null;
  unit: string | null;
  period: string | null;
  emission_source: string | null;
  source_quote: string | null;
}

export interface AirQualityEffect {
  pollutant: string | null;
  description: string | null;
  significance: string | null;
  mitigation: string | null;
  source_quote: string | null;
}

export interface OtherMetric {
  name: string | null;
  value: number | null;
  unit: string | null;
  description: string | null;
  source_quote: string | null;
}

export interface AssociatedSource {
  title: string | null;
  url: string | null;
  document_type: string | null;
  publisher: string | null;
  publication_date: string | null;
}

export interface PublicComment {
  deadline: string | null;
  submission_method: string | null;
  submission_contact: string | null;
  source_quote: string | null;
}

export interface Hearing {
  date: string | null;
  time: string | null;
  location: string | null;
  virtual_access: string | null;
  hearing_body: string | null;
  description: string | null;
  source_quote: string | null;
}

export interface ProjectExtraction {
  project_name: string | null;
  project_type: string | null;
  location: ProjectLocation | null;
  reviewing_agency: ReviewingAgency | null;
  reported_equipment: Equipment[];
  emissions: Emission[];
  power_consumption: Measurement | null;
  water_consumption: Measurement | null;
  air_quality_effects: AirQualityEffect[];
  other_metrics: OtherMetric[];
  associated_sources: AssociatedSource[];
  public_comment: PublicComment | null;
  hearings: Hearing[];
}
