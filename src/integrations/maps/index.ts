import { MockPlacesProvider, type PlacesScenario } from "./mock-places-provider.js";
import { ConfigurationError, type PlacesProvider } from "./types.js";

export * from "./types.js";
export * from "./mock-places-provider.js";
export { MOCK_PLACES, TEST_ICE_CREAM_PLACE_ID, type MockPlaceEntry } from "./mock-data.js";

export interface PlacesConfig {
  /** Defaults to `mock`. Any other value throws; there is no real adapter yet. */
  readonly adapter?: string;
  /** Mock only: simulated failure scenario. */
  readonly scenario?: PlacesScenario;
}

export function createPlacesProvider(config: PlacesConfig = {}): PlacesProvider {
  const adapter = config.adapter?.trim().toLowerCase() ?? "";
  if (adapter !== "" && adapter !== "mock") {
    // The offending value is deliberately not echoed.
    throw new ConfigurationError('Unsupported places adapter: only "mock" is available');
  }
  return new MockPlacesProvider({ scenario: config.scenario });
}
