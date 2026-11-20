export type TemplateCategory = "authentication" | "marketing" | "utility";

/** Template message (approved by the provider). */
export interface TemplateMessage {
  type: "template";
  name: string;
  category: TemplateCategory;
  /** Language code, e.g. `es_AR`. */
  languageCode: string;
  /** Named parameters; values are strings. */
  parameters: Record<string, string>;
}

/** Free-text message (only allowed inside the 24-hour customer service window). */
export interface TextMessage {
  type: "text";
  body: string;
}

export type OutboundMessage = TemplateMessage | TextMessage;

/** One logical outbound message. The idempotency key is identical across retries. */
export interface SendRequest {
  idempotencyKey: string;
  /** Recipient number in E.164 format. */
  to: string;
  message: OutboundMessage;
}

export interface SendResult {
  providerMessageId: string;
  status: "accepted";
}

/** Normalized inbound message (already parsed from the webhook payload). */
export interface InboundMessage {
  /** Unique provider message id (`wamid...`-style). */
  id: string;
  /** Sender number in E.164 format. */
  from: string;
  text: string;
}

/** A webhook delivery: the message plus the signature header value (`X-Hub-Signature-256`). */
export interface InboundDelivery {
  message: InboundMessage;
  signature: string | undefined;
}

export type InboundOutcome =
  | { accepted: true; duplicate: false }
  | { accepted: false; duplicate: true }
  | { accepted: false; duplicate: false; reason: "invalid_signature" };

export interface InboundRecord {
  message: InboundMessage;
  receivedAt: Date;
}

export interface OutboundRecord {
  idempotencyKey: string;
  to: string;
  message: OutboundMessage;
  providerMessageId: string;
  recordedAt: Date;
}

export type MessagingErrorKind =
  | "transient" // provider unavailable, retry later with the same key
  | "timeout" // outcome unknown, retry later with the same key
  | "invalid_recipient"
  | "unknown_template"
  | "template_mismatch" // category or language differs from the catalog
  | "invalid_template_parameters" // missing or extra parameters
  | "outside_window"
  | "idempotency_conflict";

/**
 * Failure raised by {@link MessagingProvider.send}. Only `transient` and `timeout` are retryable;
 * every other kind is permanent. Messages are static and never repeat the input.
 */
export class MessagingError extends Error {
  readonly kind: MessagingErrorKind;
  readonly retryable: boolean;

  constructor(kind: MessagingErrorKind, message: string) {
    super(message);
    this.name = "MessagingError";
    this.kind = kind;
    this.retryable = kind === "transient" || kind === "timeout";
  }
}

export interface MessagingProvider {
  /** Verifies and deduplicates an inbound delivery. */
  receiveInbound(delivery: InboundDelivery): InboundOutcome;
  /** Sends one logical message; throws {@link MessagingError} on failure. */
  send(request: SendRequest): Promise<SendResult>;
}
