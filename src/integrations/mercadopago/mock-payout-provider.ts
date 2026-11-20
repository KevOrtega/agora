import { NotificationRegistry } from "./mock-notifications.js";
import {
  IdempotencyConflictError,
  InvalidRequestError,
  ProviderTimeoutError,
  type CreatePayoutRequest,
  type PayoutEvent,
  type PayoutProvider,
  type PayoutRejectionReason,
  type PayoutResult,
  type RawNotification,
} from "./types.js";

/** Fictitious trigger e-mails for destination rejections. */
export const MOCK_UNKNOWN_ACCOUNT_EMAIL = "unknown@example.com";
export const MOCK_CLOSED_ACCOUNT_EMAIL = "closed@example.com";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Deterministic in-memory payout provider with idempotency per key. No network, no randomness. */
export class MockPayoutProvider implements PayoutProvider {
  private readonly byKey = new Map<string, { fingerprint: string; result: PayoutResult }>();
  private readonly byId = new Map<string, PayoutResult>();
  private readonly registry = new NotificationRegistry<PayoutEvent>();
  private sequence = 0;
  private timeoutsPending = 0;

  constructor(private readonly clock: () => Date = () => new Date(0)) {}

  /** The next `count` calls that reach the provider create the payout but time out for the caller. */
  simulateTimeoutAfterProcessing(count = 1): void {
    this.timeoutsPending = count;
  }

  async createPayout(request: CreatePayoutRequest): Promise<PayoutResult> {
    if (!request.idempotencyKey) throw new InvalidRequestError("idempotencyKey is required");
    if (!Number.isSafeInteger(request.amount) || request.amount <= 0) {
      throw new InvalidRequestError("Payout amount must be a positive integer in minor units");
    }
    if (request.currency !== "ARS") throw new InvalidRequestError("Only ARS is supported");

    const fingerprint = JSON.stringify([
      request.amount,
      request.currency,
      request.destination,
      request.reference,
    ]);
    const existing = this.byKey.get(request.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError("Idempotency key was already used with a different payload");
      }
      return existing.result;
    }

    const rejection = this.checkDestination(request.destination);
    this.sequence += 1;
    const result: PayoutResult = {
      providerPayoutId: `mock-payout-${this.sequence}`,
      idempotencyKey: request.idempotencyKey,
      status: rejection ? "rejected" : "succeeded",
      ...(rejection ? { rejectionReason: rejection } : {}),
      amount: request.amount,
      currency: request.currency,
      createdAt: this.clock().toISOString(),
    };
    this.byKey.set(request.idempotencyKey, { fingerprint, result });
    this.byId.set(result.providerPayoutId, result);

    if (this.timeoutsPending > 0) {
      this.timeoutsPending -= 1;
      throw new ProviderTimeoutError("Provider did not answer in time");
    }
    return result;
  }

  private checkDestination(destination: unknown): PayoutRejectionReason | undefined {
    const d = destination as { type?: unknown; email?: unknown } | null;
    // Anything other than a Mercado Pago e-mail (CBU, CVU, alias, ...) is out of V1.
    if (!d || d.type !== "mercadopago_email") return "unsupported_destination";
    if (typeof d.email !== "string" || !EMAIL_PATTERN.test(d.email)) return "invalid_destination";
    const email = d.email.toLowerCase();
    if (email === MOCK_UNKNOWN_ACCOUNT_EMAIL) return "destination_not_found";
    if (email === MOCK_CLOSED_ACCOUNT_EMAIL) return "destination_closed";
    return undefined;
  }

  /** Simulates the provider webhook for the payout. Calling it again returns an identical notification. */
  buildNotification(providerPayoutId: string): RawNotification {
    const payout = this.byId.get(providerPayoutId);
    if (!payout) throw new InvalidRequestError("Unknown payout");
    const event: PayoutEvent = {
      eventId: `mock-evt-${payout.providerPayoutId}-${payout.status}`,
      providerPayoutId: payout.providerPayoutId,
      status: payout.status,
      ...(payout.rejectionReason ? { rejectionReason: payout.rejectionReason } : {}),
    };
    return this.registry.issue(event, payout.providerPayoutId);
  }

  async verifyNotification(raw: RawNotification): Promise<PayoutEvent> {
    return this.registry.verify(raw);
  }

  /** All payouts the mock holds (one per idempotency key). */
  listPayouts(): PayoutResult[] {
    return [...this.byId.values()];
  }
}
