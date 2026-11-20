import { ConfigurationError } from "./types.js";

export type MercadoPagoAdapter = "mock";

export const ADAPTER_ENV_VAR = "MERCADOPAGO_ADAPTER";

/** Validates an adapter name. Missing or empty means `mock`; anything else but `mock` fails fast (no real adapter exists yet). */
export function parseAdapter(value: string | undefined): MercadoPagoAdapter {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "" || normalized === "mock") return "mock";
  // The offending value is deliberately not echoed.
  throw new ConfigurationError(`Unsupported ${ADAPTER_ENV_VAR} value: only "mock" is available`);
}

/** Pure: reads the adapter choice from an injected env-like record. */
export function readAdapterFromEnv(env: Readonly<Record<string, string | undefined>>): MercadoPagoAdapter {
  return parseAdapter(env[ADAPTER_ENV_VAR]);
}
