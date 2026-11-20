import { MOCK_PLACES } from "./mock-data.js";
import {
  InvalidRequestError,
  PlaceNotFoundError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  QuotaExceededError,
  type GeoPoint,
  type Place,
  type PlaceDetails,
  type PlaceSearchQuery,
  type PlaceSearchResult,
  type PlacesProvider,
} from "./types.js";

/** Simulated provider behavior: `ok` (default) or a failure applied to every call. */
export type PlacesScenario = "ok" | "quota_exceeded" | "unavailable" | "timeout";

/** Reserved search texts that trigger a failure regardless of the configured scenario. */
export const MOCK_QUOTA_QUERY = "__quota_exceeded__";
export const MOCK_UNAVAILABLE_QUERY = "__unavailable__";
export const MOCK_TIMEOUT_QUERY = "__timeout__";

/** Reserved place id that triggers a provider failure in `getPlaceDetails`. */
export const MOCK_UNAVAILABLE_PLACE_ID = "__unavailable__";

/** Default cap when `maxResults` is omitted. */
export const DEFAULT_MAX_RESULTS = 20;
/** Upper bound accepted for `maxResults`. */
export const MAX_ALLOWED_RESULTS = 60;

/** Lowercases and strips accents so matching is case- and accent-insensitive. */
export function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function failFor(scenario: PlacesScenario): void {
  if (scenario === "quota_exceeded") throw new QuotaExceededError("Places quota exceeded");
  if (scenario === "unavailable") throw new ProviderUnavailableError("Places provider unavailable");
  if (scenario === "timeout") throw new ProviderTimeoutError("Places provider timed out");
}

function validate(query: PlaceSearchQuery): void {
  if (typeof query?.text !== "string" || query.text.trim() === "") {
    throw new InvalidRequestError("Search text is required");
  }
  const max = query.maxResults;
  if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > MAX_ALLOWED_RESULTS)) {
    throw new InvalidRequestError("maxResults must be a positive integer within the allowed range");
  }
  if (query.area !== undefined) {
    const { center, radiusMeters } = query.area;
    const ok =
      Number.isFinite(radiusMeters) &&
      radiusMeters > 0 &&
      Number.isFinite(center?.latitude) &&
      Math.abs(center.latitude) <= 90 &&
      Number.isFinite(center?.longitude) &&
      Math.abs(center.longitude) <= 180;
    if (!ok) throw new InvalidRequestError("Search area is invalid");
  }
}

/** Deterministic in-memory places provider. Never touches the network. */
export class MockPlacesProvider implements PlacesProvider {
  constructor(private readonly options: { readonly scenario?: PlacesScenario } = {}) {}

  async searchPlaces(query: PlaceSearchQuery): Promise<PlaceSearchResult> {
    validate(query);
    const text = normalizeText(query.text);
    if (text === normalizeText(MOCK_QUOTA_QUERY)) failFor("quota_exceeded");
    if (text === normalizeText(MOCK_UNAVAILABLE_QUERY)) failFor("unavailable");
    if (text === normalizeText(MOCK_TIMEOUT_QUERY)) failFor("timeout");
    failFor(this.options.scenario ?? "ok");

    const tokens = text.split(/\s+/);
    const category = query.category === undefined ? undefined : normalizeText(query.category);
    const places: Place[] = [];
    for (const { place, keywords } of MOCK_PLACES) {
      const haystack = normalizeText([place.name, ...place.categories, ...keywords].join(" "));
      if (!tokens.every((t) => haystack.includes(t))) continue;
      if (category && !place.categories.some((c) => normalizeText(c) === category)) continue;
      if (query.area && distanceMeters(query.area.center, place.location) > query.area.radiusMeters) continue;
      places.push(structuredClone(place));
    }
    return { places: places.slice(0, query.maxResults ?? DEFAULT_MAX_RESULTS) };
  }

  async getPlaceDetails(placeId: string): Promise<PlaceDetails> {
    if (typeof placeId !== "string" || placeId.trim() === "") throw new InvalidRequestError("Place id is required");
    if (placeId === MOCK_UNAVAILABLE_PLACE_ID) failFor("unavailable");
    failFor(this.options.scenario ?? "ok");
    const found = MOCK_PLACES.find((e) => e.place.placeId === placeId);
    if (!found) throw new PlaceNotFoundError("Place not found");
    return structuredClone(found.place);
  }
}
