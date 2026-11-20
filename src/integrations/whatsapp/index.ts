import type { WhatsAppConfig } from "./config.js";
import {
  MockMessagingProvider,
  type MockMessagingProviderOptions,
} from "./mock-messaging-provider.js";
import type { MessagingProvider } from "./types.js";

export * from "./types.js";
export * from "./config.js";
export * from "./mock-messaging-provider.js";

/** Returns the mock for `mock`; any other adapter fails fast (no silent fallback, value not echoed). */
export function createMessagingProvider(
  config: WhatsAppConfig,
  mockOptions?: MockMessagingProviderOptions,
): MessagingProvider {
  if (config.adapter === "mock") {
    return new MockMessagingProvider(mockOptions);
  }
  throw new Error("Unsupported WhatsApp adapter: only the mock adapter is implemented");
}
