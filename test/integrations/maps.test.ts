import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  InvalidRequestError,
  MOCK_PLACES,
  type MockPlaceEntry,
  type Place,
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
import { installNoNetworkGuard } from "../no-network.js";

installNoNetworkGuard();

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

  it("marks every place as test data and the D43 shop as test data", () => {
    expect(MOCK_PLACES).toHaveLength(4);
    for (const { place } of MOCK_PLACES) expect(place.isTestData).toBe(true);
    const shop = MOCK_PLACES.find((e) => e.place.placeId === TEST_ICE_CREAM_PLACE_ID)?.place;
    expect(shop?.isTestData).toBe(true);
    expect(shop?.name).toContain("(TEST)");
  });

  it("uses only placeholder phones and example domains", () => {
    for (const { place } of MOCK_PLACES) {
      if (place.phone !== undefined) expect(place.phone).toMatch(/^\+54 11 0000-\d{4}$/);
      if (place.website !== undefined) expect(place.website).toMatch(/^https:\/\/[^/]+\.example\.(com|test)$/);
    }
  });

  it("contains no API-key-like strings", () => {
    for (const s of strings(MOCK_PLACES)) {
      expect(s).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
      expect(s).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    }
  });
});

describe("immutability", () => {
  const tamper = (place: Place): void => {
    // Mutation either throws (frozen) or touches a private copy; both must leave the dataset intact.
    const attempts: Array<() => void> = [
      () => ((place as { isTestData: boolean }).isTestData = false),
      () => ((place.categories as string[]).push("tampered")),
      () => ((place.location as { latitude: number }).latitude = 0),
      () => ((place as { name: string }).name = "tampered"),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (e) {
        expect(e).toBeInstanceOf(TypeError);
      }
    }
  };

  it("keeps the dataset unchanged after tampering with search results", async () => {
    const before = structuredClone(MOCK_PLACES);
    const { places } = await provider().searchPlaces({ text: "ice cream" });
    tamper(places[0] as Place);
    const again = await provider().searchPlaces({ text: "ice cream" });
    expect(again.places[0]?.isTestData).toBe(true);
    expect(again.places[0]?.categories).toEqual(["ice_cream_shop", "dessert_shop"]);
    expect(again.places[0]?.location).toEqual({ latitude: -34.6, longitude: -58.4 });
    expect(MOCK_PLACES).toEqual(before);
  });

  it("keeps the dataset unchanged after tampering with place details", async () => {
    const before = structuredClone(MOCK_PLACES);
    tamper(await provider().getPlaceDetails(TEST_ICE_CREAM_PLACE_ID));
    const again = await provider().getPlaceDetails(TEST_ICE_CREAM_PLACE_ID);
    expect(again.isTestData).toBe(true);
    expect(again.categories).toEqual(["ice_cream_shop", "dessert_shop"]);
    expect(MOCK_PLACES).toEqual(before);
  });

  it("throws in strict mode when mutating the exported dataset, and leaves it unchanged", () => {
    const entry = MOCK_PLACES[0] as MockPlaceEntry;
    expect(Object.isFrozen(MOCK_PLACES)).toBe(true);
    expect(Object.isFrozen(entry.place)).toBe(true);
    expect(Object.isFrozen(entry.place.categories)).toBe(true);
    expect(Object.isFrozen(entry.place.location)).toBe(true);
    expect(() => {
      (entry.place as { isTestData: boolean }).isTestData = false;
    }).toThrow(TypeError);
    expect(() => (entry.place.categories as string[]).push("x")).toThrow(TypeError);
    expect(() => (MOCK_PLACES as MockPlaceEntry[]).push(entry)).toThrow(TypeError);
    expect(entry.place.isTestData).toBe(true);
  });
});
