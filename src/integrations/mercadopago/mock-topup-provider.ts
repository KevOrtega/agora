import { NotificationRegistry } from "./mock-notifications.js";
import {
  InvalidRequestError,
  type CreateTopupRequest,
  type RawNotification,
  type TopupEvent,
  type TopupPayment,
  type TopupProvider,
  type TopupStatus,
} from "./types.js";

export type TopupScenario = "approve" | "reject" | "pending";

const OUTCOME: Record<TopupScenario, TopupStatus> = { approve: "approved", reject: "rejected", pending: "pending" };

/** Deterministic in-memory top-up provider. No network, no randomness. */
export class MockTopupProvider implements TopupProvider {
  private readonly payments = new Map<string, TopupPayment>();
  private readonly byReference = new Map<string, string>();
  private readonly scenarios = new Map<string, TopupScenario>();
  private readonly registry = new NotificationRegistry<TopupEvent>();
  private sequence = 0;

  constructor(private readonly defaultScenario: TopupScenario = "approve") {}

  /** Controls the outcome of the next top-up created with this external reference. */
  setScenario(externalReference: string, scenario: TopupScenario): void {
    this.scenarios.set(externalReference, scenario);
  }

  async createTopup(request: CreateTopupRequest): Promise<TopupPayment> {
    if (!Number.isSafeInteger(request.amount) || request.amount <= 0) {
      throw new InvalidRequestError("Top-up amount must be a positive integer in minor units");
    }
    if (request.currency !== "ARS") throw new InvalidRequestError("Only ARS is supported");
    if (!request.externalReference || !request.customerId) {
      throw new InvalidRequestError("externalReference and customerId are required");
    }
    const existingId = this.byReference.get(request.externalReference);
    const existing = existingId ? this.payments.get(existingId) : undefined;
    if (existing) return existing;

    const scenario = this.scenarios.get(request.externalReference) ?? this.defaultScenario;
    const status = OUTCOME[scenario];
    this.sequence += 1;
    const payment: TopupPayment = {
      providerPaymentId: `mock-pay-${this.sequence}`,
      externalReference: request.externalReference,
      customerId: request.customerId,
      amount: request.amount,
      currency: request.currency,
      status,
      ...(status === "rejected" ? { rejectionReason: "rejected_by_provider" } : {}),
    };
    this.payments.set(payment.providerPaymentId, payment);
    this.byReference.set(payment.externalReference, payment.providerPaymentId);
    return payment;
  }

  /** Moves a pending payment to a final status (test control). */
  settle(providerPaymentId: string, outcome: "approve" | "reject"): TopupPayment {
    const payment = this.payments.get(providerPaymentId);
    if (!payment) throw new InvalidRequestError("Unknown payment");
    const status = OUTCOME[outcome];
    const updated: TopupPayment = {
      ...payment,
      status,
      ...(status === "rejected" ? { rejectionReason: "rejected_by_provider" } : {}),
    };
    this.payments.set(updated.providerPaymentId, updated);
    return updated;
  }

  /** Simulates the provider webhook for the payment's current status. Calling it again returns an identical notification. */
  buildNotification(providerPaymentId: string): RawNotification {
    const payment = this.payments.get(providerPaymentId);
    if (!payment) throw new InvalidRequestError("Unknown payment");
    const event: TopupEvent = {
      eventId: `mock-evt-${payment.providerPaymentId}-${payment.status}`,
      providerPaymentId: payment.providerPaymentId,
      externalReference: payment.externalReference,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
    };
    return this.registry.issue(event, payment.providerPaymentId);
  }

  async verifyNotification(raw: RawNotification): Promise<TopupEvent> {
    return this.registry.verify(raw);
  }

  paymentCount(): number {
    return this.payments.size;
  }
}
