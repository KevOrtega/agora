/** Contracts for the Mercado Pago integration. Amounts are integers in minor units (centavos). */

export type Currency = "ARS";

/** Raised for malformed requests (non-positive amount, missing key, ...). */
export class InvalidRequestError extends Error {
  override readonly name = "InvalidRequestError";
}

/** Raised when an idempotency key is reused with a different payload. */
export class IdempotencyConflictError extends Error {
  override readonly name = "IdempotencyConflictError";
}

/** Raised when a notification cannot be verified (unknown or forged). */
export class NotificationVerificationError extends Error {
  override readonly name = "NotificationVerificationError";
}

/** Raised when the adapter configuration is unsupported. */
export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

/** Raised when the provider call did not answer in time; the outcome is unknown, retry with the same key. */
export class ProviderTimeoutError extends Error {
  override readonly name = "ProviderTimeoutError";
}

/** A notification as delivered by the provider webhook, before verification. */
export interface RawNotification {
  readonly id: string;
  readonly resourceId: string;
  readonly signature: string;
}

// ---- Top-ups ----

/** `pending` must never be treated as approved by consumers. */
export type TopupStatus = "pending" | "approved" | "rejected";

export interface CreateTopupRequest {
  /** Our own unique reference for this top-up; creating twice with it returns the same payment. */
  readonly externalReference: string;
  readonly customerId: string;
  /** Positive integer, centavos. No platform minimum. */
  readonly amount: number;
  readonly currency: Currency;
}

export interface TopupPayment {
  readonly providerPaymentId: string;
  readonly externalReference: string;
  readonly customerId: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly status: TopupStatus;
  readonly rejectionReason?: string;
}

/** Normalized, verified top-up event. `eventId` is the stable dedup key. */
export interface TopupEvent {
  readonly eventId: string;
  readonly providerPaymentId: string;
  readonly externalReference: string;
  readonly status: TopupStatus;
  readonly amount: number;
  readonly currency: Currency;
}

export interface TopupProvider {
  createTopup(request: CreateTopupRequest): Promise<TopupPayment>;
  /** Verifies a webhook notification and returns the normalized event; throws NotificationVerificationError otherwise. */
  verifyNotification(raw: RawNotification): Promise<TopupEvent>;
}

// ---- Payouts ----

/** V1 only supports the business's own Mercado Pago account identified by e-mail. CBU/CVU/alias are not supported. */
export interface MercadoPagoEmailDestination {
  readonly type: "mercadopago_email";
  readonly email: string;
}

export type PayoutStatus = "pending" | "succeeded" | "rejected";

export type PayoutRejectionReason =
  | "unsupported_destination"
  | "invalid_destination"
  | "destination_not_found"
  | "destination_closed";

export interface CreatePayoutRequest {
  /** Required; maps to the X-Idempotency-Key header. A retry with the same key never pays twice. */
  readonly idempotencyKey: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly destination: MercadoPagoEmailDestination;
  readonly reference: string;
}

export interface PayoutResult {
  readonly providerPayoutId: string;
  readonly idempotencyKey: string;
  readonly status: PayoutStatus;
  readonly rejectionReason?: PayoutRejectionReason;
  readonly amount: number;
  readonly currency: Currency;
  readonly createdAt: string;
}

export interface PayoutEvent {
  readonly eventId: string;
  readonly providerPayoutId: string;
  readonly status: PayoutStatus;
  readonly rejectionReason?: PayoutRejectionReason;
}

export interface PayoutProvider {
  createPayout(request: CreatePayoutRequest): Promise<PayoutResult>;
  verifyNotification(raw: RawNotification): Promise<PayoutEvent>;
}

export interface MercadoPagoProviders {
  readonly topup: TopupProvider;
  readonly payout: PayoutProvider;
}
