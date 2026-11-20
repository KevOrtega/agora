import { parseAdapter, readAdapterFromEnv } from "./config.js";
import { MockPayoutProvider } from "./mock-payout-provider.js";
import { MockTopupProvider } from "./mock-topup-provider.js";
import type { MercadoPagoProviders } from "./types.js";

export * from "./types.js";
export * from "./config.js";
export { MockTopupProvider, type TopupScenario } from "./mock-topup-provider.js";
export { MockPayoutProvider, MOCK_CLOSED_ACCOUNT_EMAIL, MOCK_UNKNOWN_ACCOUNT_EMAIL } from "./mock-payout-provider.js";

export interface MercadoPagoConfig {
  /** Defaults to `mock`. Any other value throws; there is no real adapter yet. */
  readonly adapter?: string;
  readonly clock?: () => Date;
}

export function createMercadoPagoProviders(config: MercadoPagoConfig = {}): MercadoPagoProviders {
  parseAdapter(config.adapter);
  return { topup: new MockTopupProvider(), payout: new MockPayoutProvider(config.clock) };
}

export function createMercadoPagoProvidersFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): MercadoPagoProviders {
  return createMercadoPagoProviders({ adapter: readAdapterFromEnv(env) });
}
