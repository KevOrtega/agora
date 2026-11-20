/** Contracts for the places (maps) integration used by business discovery. Google Maps is the only planned source. */

/** Raised for malformed requests (empty query, invalid max results, invalid location, empty place id). */
export class InvalidRequestError extends Error {
  override readonly name = "InvalidRequestError";
}

/** Raised when a place id is unknown to the provider. */
export class PlaceNotFoundError extends Error {
  override readonly name = "PlaceNotFoundError";
}

/** Raised when the provider quota or rate limit is exceeded; retry later. */
export class QuotaExceededError extends Error {
  override readonly name = "QuotaExceededError";
}

/** Raised when the provider is temporarily unavailable; retry later. */
export class ProviderUnavailableError extends Error {
  override readonly name = "ProviderUnavailableError";
}

/** Raised when the provider call did not answer in time. */
export class ProviderTimeoutError extends Error {
  override readonly name = "ProviderTimeoutError";
}

/** Raised when the adapter configuration is unsupported. */
export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

/** A geographic point in WGS84 degrees. */
export interface GeoPoint {
  /** Latitude, -90..90. */
  readonly latitude: number;
  /** Longitude, -180..180. */
  readonly longitude: number;
}

/** Restricts a search to a circular area. */
export interface SearchArea {
  /** Center of the area. */
  readonly center: GeoPoint;
  /** Radius in meters; positive. */
  readonly radiusMeters: number;
}

export interface PlaceSearchQuery {
  /** Free text (e.g. "ice cream"); required, non-blank. */
  readonly text: string;
  /** Optional category filter (e.g. "ice_cream_shop"). */
  readonly category?: string;
  /** Optional area filter. */
  readonly area?: SearchArea;
  /** Optional cap on results; positive integer. Providers apply their own default when omitted. */
  readonly maxResults?: number;
}

/** Whether the place is currently operating, as reported by the provider. */
export type BusinessStatus = "operational" | "closed_temporarily" | "closed_permanently";

export interface Place {
  /** Stable provider place id. */
  readonly placeId: string;
  /** Display name. */
  readonly name: string;
  /** Formatted address. */
  readonly address: string;
  /** Approximate coordinates. */
  readonly location: GeoPoint;
  /** Category identifiers, most specific first. */
  readonly categories: readonly string[];
  /** Contact phone, when published. */
  readonly phone?: string;
  /** Website URL, when published. */
  readonly website?: string;
  /** Average rating, 1..5, when available. */
  readonly rating?: number;
  /** Operating status. */
  readonly businessStatus: BusinessStatus;
  /** True when the place is fictitious test data and must never be treated as a real business. */
  readonly isTestData: boolean;
}

export interface PlaceSearchResult {
  /** Matching places, in a stable provider order. May be empty (a normal outcome). */
  readonly places: readonly Place[];
}

/** Details of one place. Currently the same shape as a search hit; may grow (hours, reviews) later. */
export type PlaceDetails = Place;

export interface PlacesProvider {
  /** Searches places. Zero matches resolves with an empty list; failures reject with the typed errors above. */
  searchPlaces(query: PlaceSearchQuery): Promise<PlaceSearchResult>;
  /** Returns details for a place id; rejects with PlaceNotFoundError when unknown. */
  getPlaceDetails(placeId: string): Promise<PlaceDetails>;
}
