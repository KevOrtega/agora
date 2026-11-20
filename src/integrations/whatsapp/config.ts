export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface WhatsAppConfig {
  adapter: string;
}

/** Pure: reads the adapter choice from an injected env-like record. Missing or empty means `mock`. */
export function readWhatsAppConfig(env: EnvLike): WhatsAppConfig {
  const value = env.WHATSAPP_ADAPTER?.trim();
  return { adapter: value ? value : "mock" };
}
