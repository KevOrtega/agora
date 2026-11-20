import { TEMPLATE_CATALOG, type TemplateDefinition } from "./templates.js";
import {
  MessagingError,
  type InboundDelivery,
  type InboundOutcome,
  type InboundRecord,
  type MessagingProvider,
  type OutboundRecord,
  type SendRequest,
  type SendResult,
} from "./types.js";

/** Fictitious signature the mock accepts (stand-in for the `X-Hub-Signature-256` check). */
export const MOCK_VALID_SIGNATURE = "sha256=mock-valid-signature";

/** Templates the mock considers approved unless overridden (the PROVISIONAL catalog). */
export const DEFAULT_APPROVED_TEMPLATES: readonly TemplateDefinition[] = TEMPLATE_CATALOG;

/**
 * Canonical JSON: object keys sorted recursively, array order preserved.
 * Used so field order never causes a false idempotency conflict.
 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Recipient format: E.164, `+` followed by 8 to 15 digits. Anything else is an invalid number. */
const E164 = /^\+[1-9]\d{7,14}$/;

export interface MockMessagingProviderOptions {
  /** Injectable clock; defaults to the system clock. */
  now?: () => Date;
  approvedTemplates?: readonly TemplateDefinition[];
}

interface StoredSend {
  fingerprint: string;
  result: SendResult;
}

/**
 * Deterministic in-memory provider. Never touches the network or the console.
 * Failure triggers: `simulateTransientFailure(n)` and `simulateLostResponse(n)` affect
 * the next n send attempts; an invalid number, an unapproved template or a template that does not match the catalog
 * (category, language, parameters) fails permanently and is not stored under its key.
 */
export class MockMessagingProvider implements MessagingProvider {
  private readonly now: () => Date;
  private readonly approvedTemplates: Map<string, TemplateDefinition>;
  private readonly inbound: InboundRecord[] = [];
  private readonly seenInboundIds = new Set<string>();
  private readonly lastInboundBySender = new Map<string, Date>();
  private readonly outbound: OutboundRecord[] = [];
  private readonly sends = new Map<string, StoredSend>();
  private transientFailures = 0;
  private lostResponses = 0;
  private counter = 0;

  constructor(options: MockMessagingProviderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.approvedTemplates = new Map(
      (options.approvedTemplates ?? DEFAULT_APPROVED_TEMPLATES).map((t) => [t.name, t]),
    );
  }

  simulateTransientFailure(attempts: number): void {
    this.transientFailures = attempts;
  }

  simulateLostResponse(attempts: number): void {
    this.lostResponses = attempts;
  }

  listInbound(): InboundRecord[] {
    return this.inbound.map((r) => structuredClone(r));
  }

  listOutbound(): OutboundRecord[] {
    return this.outbound.map((r) => structuredClone(r));
  }

  receiveInbound(delivery: InboundDelivery): InboundOutcome {
    if (delivery.signature !== MOCK_VALID_SIGNATURE) {
      return { accepted: false, duplicate: false, reason: "invalid_signature" };
    }
    const { message } = delivery;
    if (this.seenInboundIds.has(message.id)) {
      return { accepted: false, duplicate: true };
    }
    const receivedAt = this.now();
    this.seenInboundIds.add(message.id);
    this.inbound.push({ message: { ...message }, receivedAt });
    this.lastInboundBySender.set(message.from, receivedAt);
    return { accepted: true, duplicate: false };
  }

  async send(request: SendRequest): Promise<SendResult> {
    const fingerprint = canonicalize({ to: request.to, message: request.message });
    const previous = this.sends.get(request.idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new MessagingError(
          "idempotency_conflict",
          "Idempotency key was already used with a different payload",
        );
      }
      return { ...previous.result };
    }

    if (this.transientFailures > 0) {
      this.transientFailures -= 1;
      throw new MessagingError("transient", "Provider temporarily unavailable, retry later");
    }

    this.validate(request);

    const result: SendResult = {
      providerMessageId: `wamid.mock.${String(++this.counter).padStart(6, "0")}`,
      status: "accepted",
    };
    this.sends.set(request.idempotencyKey, { fingerprint, result });
    this.outbound.push({
      idempotencyKey: request.idempotencyKey,
      to: request.to,
      message: structuredClone(request.message),
      providerMessageId: result.providerMessageId,
      recordedAt: this.now(),
    });

    if (this.lostResponses > 0) {
      this.lostResponses -= 1;
      throw new MessagingError("timeout", "Response lost, outcome unknown: retry with the same key");
    }
    return { ...result };
  }

  private validate(request: SendRequest): void {
    if (!E164.test(request.to)) {
      throw new MessagingError("invalid_recipient", "Recipient number is not a valid phone number");
    }
    const { message } = request;
    if (message.type === "template") {
      const definition = this.approvedTemplates.get(message.name);
      if (!definition) {
        throw new MessagingError("unknown_template", "Template is unknown or not approved");
      }
      if (message.category !== definition.category || message.languageCode !== definition.languageCode) {
        throw new MessagingError("template_mismatch", "Template category or language does not match the catalog");
      }
      // A key whose value is undefined is neither present nor allowed (it would vanish on serialization).
      const given = Object.keys(message.parameters);
      const hasUndefined = Object.values(message.parameters).some((v) => v === undefined);
      const expected = new Set(definition.parameters);
      if (hasUndefined || given.length !== expected.size || !given.every((k) => expected.has(k))) {
        throw new MessagingError(
          "invalid_template_parameters",
          "Template parameters are missing or unexpected",
        );
      }
      return;
    }
    const last = this.lastInboundBySender.get(request.to);
    if (!last || this.now().getTime() - last.getTime() > SERVICE_WINDOW_MS) {
      throw new MessagingError(
        "outside_window",
        "Free text is not allowed outside the 24-hour service window; use a template",
      );
    }
  }
}
