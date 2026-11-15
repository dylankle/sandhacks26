import "server-only";
import { LOOKUP_ALLOWLIST } from "@/lib/config";
import { safeFetch } from "@/lib/net/safe-fetch";
import { inCalifornia } from "@/lib/pipeline/validate";

export interface GeocodeResult {
  lat: number;
  lng: number;
  matchedAddress: string;
  source: string;
}

/** U.S. Census Bureau geocoder (address → point). Returns null when there is no confident match. */
export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const q = new URLSearchParams({ address, benchmark: "Public_AR_Current", format: "json" });
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${q}`;
  try {
    const r = await safeFetch(url, (u) => LOOKUP_ALLOWLIST.has(u.hostname), { maxBytes: 512_000, accept: "application/json" });
    const j = JSON.parse(r.body.toString("utf8"));
    const m = j?.result?.addressMatches?.[0];
    if (!m) return null;
    const lat = Number(m.coordinates?.y);
    const lng = Number(m.coordinates?.x);
    if (!inCalifornia(lat, lng)) return null;
    return { lat, lng, matchedAddress: String(m.matchedAddress), source: "U.S. Census Bureau Geocoder (Public_AR_Current)" };
  } catch {
    return null;
  }
}
