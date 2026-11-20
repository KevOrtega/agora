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

/** Template names the mock considers approved unless overridden. */
export const DEFAULT_APPROVED_TEMPLATES: readonly string[] = [
  "order_update",
  "credit_topup_confirmation",
];

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Recipient format: E.164, `+` followed by 8 to 15 digits. Anything else is an invalid number. */
const E164 = /^\+[1-9]\d{7,14}$/;

export interface MockMessagingProviderOptions {
  /** Injectable clock; defaults to the system clock. */
  now?: () => Date;
  approvedTemplates?: readonly string[];
}

interface StoredSend {
  fingerprint: string;
  result: SendResult;
}

/**
 * Deterministic in-memory provider. Never touches the network or the console.
 * Failure triggers: `simulateTransientFailure(n)` and `simulateLostResponse(n)` affect
 * the next n send attempts; an invalid number or an unapproved template fails permanently.
 */
export class MockMessagingProvider implements MessagingProvider {
  private readonly now: () => Date;
  private readonly approvedTemplates: Set<string>;
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
    this.approvedTemplates = new Set(options.approvedTemplates ?? DEFAULT_APPROVED_TEMPLATES);
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
    const fingerprint = JSON.stringify([request.to, request.message]);
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
      if (!this.approvedTemplates.has(message.name)) {
        throw new MessagingError("unknown_template", "Template is unknown or not approved");
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
