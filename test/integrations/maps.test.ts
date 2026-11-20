import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  ConfigurationError,
  InvalidRequestError,
  MOCK_PLACES,
  MOCK_QUOTA_QUERY,
  MOCK_TIMEOUT_QUERY,
  MOCK_UNAVAILABLE_PLACE_ID,
  MOCK_UNAVAILABLE_QUERY,
  MockPlacesProvider,
  PlaceNotFoundError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  QuotaExceededError,
  TEST_ICE_CREAM_PLACE_ID,
  createPlacesProvider,
} from "../../src/integrations/maps/index.js";

let fetchSpy: MockInstance<typeof globalThis.fetch>;
let httpSpy: MockInstance<typeof http.request>;
let httpsSpy: MockInstance<typeof https.request>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  httpSpy = vi.spyOn(http, "request");
  httpsSpy = vi.spyOn(https, "request");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(httpSpy).not.toHaveBeenCalled();
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const provider = () => new MockPlacesProvider();

describe("search results", () => {
  it("returns the fake ice-cream shop first, marked as test data, in deterministic order", async () => {
    const { places } = await provider().searchPlaces({ text: "ice cream" });
    expect(places.map((p) => p.placeId)).toEqual([TEST_ICE_CREAM_PLACE_ID, "mock-place-004"]);
    expect(places[0]?.isTestData).toBe(true);
    expect(places[0]?.name).toContain("(TEST)");
    expect(await provider().searchPlaces({ text: "ice cream" })).toEqual({ places });
  });

  it("matches ignoring case and accents", async () => {
    const a = await provider().searchPlaces({ text: "HELADERÍA" });
    const b = await provider().searchPlaces({ text: "heladeria" });
    expect(a.places.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it("filters by category and area", async () => {
    const byCat = await provider().searchPlaces({ text: "test", category: "Bakery" });
    expect(byCat.places.map((p) => p.placeId)).toEqual(["mock-place-002"]);
    const near = await provider().searchPlaces({
      text: "heladeria",
      area: { center: { latitude: -34.6, longitude: -58.4 }, radiusMeters: 2000 },
    });
    expect(near.places.map((p) => p.placeId)).toEqual([TEST_ICE_CREAM_PLACE_ID]);
  });

  it("honors maxResults", async () => {
    const { places } = await provider().searchPlaces({ text: "test", maxResults: 2 });
    expect(places).toHaveLength(2);
  });

  it("returns details for a known id", async () => {
    const d = await provider().getPlaceDetails(TEST_ICE_CREAM_PLACE_ID);
    expect(d.placeId).toBe(TEST_ICE_CREAM_PLACE_ID);
    expect(d.isTestData).toBe(true);
  });
});

describe("empty results", () => {
  it("resolves with zero places for a non-matching query", async () => {
    await expect(provider().searchPlaces({ text: "zzz-no-match" })).resolves.toEqual({ places: [] });
  });
});

describe("errors", () => {
  it.each([
    ["empty text", { text: "   " }],
    ["maxResults zero", { text: "x", maxResults: 0 }],
    ["maxResults fractional", { text: "x", maxResults: 1.5 }],
    ["maxResults too large", { text: "x", maxResults: 1000 }],
    ["bad radius", { text: "x", area: { center: { latitude: 0, longitude: 0 }, radiusMeters: 0 } }],
    ["bad latitude", { text: "x", area: { center: { latitude: 91, longitude: 0 }, radiusMeters: 5 } }],
  ])("rejects invalid request: %s", async (_n, q) => {
    await expect(provider().searchPlaces(q)).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("rejects an empty place id as invalid", async () => {
    await expect(provider().getPlaceDetails("")).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("rejects an unknown place id with not-found", async () => {
    await expect(provider().getPlaceDetails("nope")).rejects.toBeInstanceOf(PlaceNotFoundError);
  });

  it.each([
    [MOCK_QUOTA_QUERY, QuotaExceededError],
    [MOCK_UNAVAILABLE_QUERY, ProviderUnavailableError],
    [MOCK_TIMEOUT_QUERY, ProviderTimeoutError],
  ])("reserved query %s triggers its typed error", async (text, err) => {
    await expect(provider().searchPlaces({ text })).rejects.toBeInstanceOf(err);
  });

  it("reserved place id triggers provider unavailable", async () => {
    await expect(provider().getPlaceDetails(MOCK_UNAVAILABLE_PLACE_ID)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it.each([
    ["quota_exceeded", QuotaExceededError],
    ["unavailable", ProviderUnavailableError],
    ["timeout", ProviderTimeoutError],
  ] as const)("scenario %s fails search and details", async (scenario, err) => {
    const p = new MockPlacesProvider({ scenario });
    await expect(p.searchPlaces({ text: "ice cream" })).rejects.toBeInstanceOf(err);
    await expect(p.getPlaceDetails(TEST_ICE_CREAM_PLACE_ID)).rejects.toBeInstanceOf(err);
  });

  it("does not echo raw input in error messages", async () => {
    const raw = "SENTINEL-raw-input-value";
    const errors: Error[] = [];
    await provider().getPlaceDetails(raw).catch((e: Error) => errors.push(e));
    await provider().searchPlaces({ text: raw, maxResults: -1 }).catch((e: Error) => errors.push(e));
    expect(errors).toHaveLength(2);
    for (const e of errors) expect(`${e.message} ${e.stack ?? ""}`).not.toContain(raw);
  });
});

describe("factory", () => {
  it("defaults to the mock", () => {
    expect(createPlacesProvider()).toBeInstanceOf(MockPlacesProvider);
    expect(createPlacesProvider({ adapter: "mock" })).toBeInstanceOf(MockPlacesProvider);
  });

  it("passes the scenario to the mock", async () => {
    await expect(createPlacesProvider({ scenario: "timeout" }).searchPlaces({ text: "x" })).rejects.toBeInstanceOf(
      ProviderTimeoutError,
    );
  });

  it("rejects unsupported adapters without echoing the value", () => {
    const value = "SENTINEL-adapter-value";
    let error: unknown;
    try {
      createPlacesProvider({ adapter: value });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).not.toContain(value);
  });
});

describe("data hygiene", () => {
  const strings = (v: unknown): string[] =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v)
        ? v.flatMap(strings)
        : v && typeof v === "object"
          ? Object.values(v).flatMap(strings)
          : [];

  it("only has test data or example domains", () => {
    for (const { place } of MOCK_PLACES) {
      if (!place.isTestData) {
        expect(place.website).toMatch(/^https:\/\/[^/]*\.example\.(com|test)\b/);
      }
      if (place.website) expect(place.website).toMatch(/\.example\.(com|test)$/);
    }
  });

  it("contains no API-key-like strings", () => {
    for (const s of strings(MOCK_PLACES)) {
      expect(s).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
      expect(s).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    }
  });
});
