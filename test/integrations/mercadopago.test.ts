import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  ConfigurationError,
  IdempotencyConflictError,
  InvalidRequestError,
  MOCK_CLOSED_ACCOUNT_EMAIL,
  MOCK_UNKNOWN_ACCOUNT_EMAIL,
  MockPayoutProvider,
  MockTopupProvider,
  NotificationVerificationError,
  ProviderTimeoutError,
  createMercadoPagoProviders,
  createMercadoPagoProvidersFromEnv,
  type CreatePayoutRequest,
  type CreateTopupRequest,
} from "../../src/integrations/mercadopago/index.js";

const topupReq = (over: Partial<CreateTopupRequest> = {}): CreateTopupRequest => ({
  externalReference: "topup-test-1",
  customerId: "cust-test-1",
  amount: 1500,
  currency: "ARS",
  ...over,
});

const payoutReq = (over: Partial<CreatePayoutRequest> = {}): CreatePayoutRequest => ({
  idempotencyKey: "payout-key-1",
  amount: 2500,
  currency: "ARS",
  destination: { type: "mercadopago_email", email: "business@example.com" },
  reference: "order-test-1",
  ...over,
});

let fetchSpy: MockInstance<typeof globalThis.fetch>;
let httpSpy: MockInstance<typeof http.request>;
let httpsSpy: MockInstance<typeof https.request>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  httpSpy = vi.spyOn(http, "request");
  httpsSpy = vi.spyOn(https, "request");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(httpSpy).not.toHaveBeenCalled();
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("top-up mock", () => {
  it("approves a top-up by default", async () => {
    const p = await new MockTopupProvider().createTopup(topupReq());
    expect(p.status).toBe("approved");
  });

  // covers AG-TOP-01
  it("reports a rejected top-up as rejected, not approved", async () => {
    const mock = new MockTopupProvider();
    mock.setScenario("topup-test-1", "reject");
    const p = await mock.createTopup(topupReq());
    expect(p.status).toBe("rejected");
    expect(p.rejectionReason).toBeTruthy();
    const evt = await mock.verifyNotification(mock.buildNotification(p.providerPaymentId));
    expect(evt.status).toBe("rejected");
  });

  // covers AG-TOP-01
  it("reports a pending top-up as pending, not approved, until settled", async () => {
    const mock = new MockTopupProvider();
    mock.setScenario("topup-test-1", "pending");
    const p = await mock.createTopup(topupReq());
    expect(p.status).toBe("pending");
    const evt = await mock.verifyNotification(mock.buildNotification(p.providerPaymentId));
    expect(evt.status).toBe("pending");
    expect(mock.settle(p.providerPaymentId, "approve").status).toBe("approved");
  });

  // covers AG-TOP-02
  it("rejects a forged or unknown notification at verification", async () => {
    const mock = new MockTopupProvider();
    const p = await mock.createTopup(topupReq());
    const real = mock.buildNotification(p.providerPaymentId);
    await expect(
      mock.verifyNotification({ id: "mock-evt-forged", resourceId: "mock-pay-999", signature: "x" }),
    ).rejects.toBeInstanceOf(NotificationVerificationError);
    await expect(mock.verifyNotification({ ...real, signature: "bad" })).rejects.toBeInstanceOf(
      NotificationVerificationError,
    );
    await expect(mock.verifyNotification({ ...real, resourceId: "other" })).rejects.toBeInstanceOf(
      NotificationVerificationError,
    );
  });

  // covers AG-TOP-03, AG-TOP-06 (adapter part)
  it("yields the same normalized event and stable id when the same webhook is delivered twice", async () => {
    const mock = new MockTopupProvider();
    const p = await mock.createTopup(topupReq());
    const raw = mock.buildNotification(p.providerPaymentId);
    const first = await mock.verifyNotification(raw);
    const second = await mock.verifyNotification(structuredClone(raw));
    expect(second).toEqual(first);
    expect(second.eventId).toBe(first.eventId);
    expect(mock.buildNotification(p.providerPaymentId)).toEqual(raw);
    expect(first).toMatchObject({ providerPaymentId: p.providerPaymentId, externalReference: "topup-test-1", amount: 1500 });
  });

  it("creating the same external reference twice returns the same payment", async () => {
    const mock = new MockTopupProvider();
    const a = await mock.createTopup(topupReq());
    const b = await mock.createTopup(topupReq());
    expect(b).toEqual(a);
    expect(mock.paymentCount()).toBe(1);
  });

  // covers AG-TOP-04
  it("accepts a small positive amount (no platform minimum)", async () => {
    const p = await new MockTopupProvider().createTopup(topupReq({ amount: 1 }));
    expect(p.status).toBe("approved");
  });

  // covers AG-TOP-04
  it.each([0, -100, 10.5, Number.NaN])("rejects invalid amount %s", async (amount) => {
    await expect(new MockTopupProvider().createTopup(topupReq({ amount }))).rejects.toBeInstanceOf(InvalidRequestError);
  });
});

describe("payout mock", () => {
  it("pays out to a valid Mercado Pago e-mail destination", async () => {
    const r = await new MockPayoutProvider(() => new Date("2030-01-01T00:00:00Z")).createPayout(payoutReq());
    expect(r.status).toBe("succeeded");
    expect(r.createdAt).toBe("2030-01-01T00:00:00.000Z");
  });

  // covers AG-PAY-01
  it("creates exactly one payout when retried with the same idempotency key", async () => {
    const mock = new MockPayoutProvider();
    const a = await mock.createPayout(payoutReq());
    const b = await mock.createPayout(payoutReq());
    expect(b).toEqual(a);
    expect(mock.listPayouts()).toHaveLength(1);
  });

  // covers AG-PAY-01
  it("creates a single payout when a timeout is followed by a retry with the same key", async () => {
    const mock = new MockPayoutProvider();
    mock.simulateTimeoutAfterProcessing();
    await expect(mock.createPayout(payoutReq())).rejects.toBeInstanceOf(ProviderTimeoutError);
    const retry = await mock.createPayout(payoutReq());
    expect(retry.status).toBe("succeeded");
    expect(mock.listPayouts()).toEqual([retry]);
  });

  it("rejects the same idempotency key with a different payload as a conflict", async () => {
    const mock = new MockPayoutProvider();
    await mock.createPayout(payoutReq());
    await expect(mock.createPayout(payoutReq({ amount: 9999 }))).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      mock.createPayout(payoutReq({ destination: { type: "mercadopago_email", email: "other@example.com" } })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(mock.listPayouts()).toHaveLength(1);
  });

  it("requires an idempotency key and a positive integer amount", async () => {
    const mock = new MockPayoutProvider();
    await expect(mock.createPayout(payoutReq({ idempotencyKey: "" }))).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(mock.createPayout(payoutReq({ amount: 0 }))).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(mock.createPayout(payoutReq({ amount: 1.5 }))).rejects.toBeInstanceOf(InvalidRequestError);
  });

  // covers AG-PAY-05 (adapter part)
  it.each([
    [MOCK_UNKNOWN_ACCOUNT_EMAIL, "destination_not_found"],
    [MOCK_CLOSED_ACCOUNT_EMAIL, "destination_closed"],
  ])("rejects an unknown or closed destination account (%s)", async (email, reason) => {
    const r = await new MockPayoutProvider().createPayout(
      payoutReq({ destination: { type: "mercadopago_email", email } }),
    );
    expect(r.status).toBe("rejected");
    expect(r.rejectionReason).toBe(reason);
  });

  // covers AG-PAY-12 (c) (adapter part)
  it.each(["not-an-email", "", "a@b", "two words@example.com"])("rejects invalid e-mail destination %j", async (email) => {
    const r = await new MockPayoutProvider().createPayout(
      payoutReq({ destination: { type: "mercadopago_email", email } }),
    );
    expect(r.status).toBe("rejected");
    expect(r.rejectionReason).toBe("invalid_destination");
  });

  // covers AG-PAY-12 (c) (adapter part)
  it.each([
    { type: "cbu", value: "0000000000000000000000" },
    { type: "cvu", value: "0000000000000000000001" },
    { type: "alias", value: "test.alias.one" },
  ])("rejects non-e-mail destination $type as unsupported in V1", async (destination) => {
    const mock = new MockPayoutProvider();
    const r = await mock.createPayout(payoutReq({ destination } as unknown as Partial<CreatePayoutRequest>));
    expect(r.status).toBe("rejected");
    expect(r.rejectionReason).toBe("unsupported_destination");
  });

  it("returns the same rejected payout on retry with the same key", async () => {
    const mock = new MockPayoutProvider();
    const req = payoutReq({ destination: { type: "mercadopago_email", email: MOCK_CLOSED_ACCOUNT_EMAIL } });
    const a = await mock.createPayout(req);
    expect(await mock.createPayout(req)).toEqual(a);
    expect(mock.listPayouts()).toHaveLength(1);
  });

  // covers AG-PAY-06 (adapter part)
  it("yields the same event id when the payout confirmation is redelivered twice", async () => {
    const mock = new MockPayoutProvider();
    const r = await mock.createPayout(payoutReq());
    const raw = mock.buildNotification(r.providerPayoutId);
    const first = await mock.verifyNotification(raw);
    const second = await mock.verifyNotification(structuredClone(raw));
    expect(second).toEqual(first);
    expect(second.eventId).toBe(first.eventId);
    expect(first.status).toBe("succeeded");
  });

  it("rejects a forged payout notification", async () => {
    await expect(
      new MockPayoutProvider().verifyNotification({ id: "x", resourceId: "y", signature: "z" }),
    ).rejects.toBeInstanceOf(NotificationVerificationError);
  });
});

describe("configuration and factory", () => {
  // covers AG-PAY-10, AG-SEC-03
  it("returns the mock adapters when no configuration is given", () => {
    const p = createMercadoPagoProviders();
    expect(p.topup).toBeInstanceOf(MockTopupProvider);
    expect(p.payout).toBeInstanceOf(MockPayoutProvider);
    const fromEnv = createMercadoPagoProvidersFromEnv({});
    expect(fromEnv.topup).toBeInstanceOf(MockTopupProvider);
  });

  // covers AG-PAY-10, AG-SEC-03
  it.each([undefined, "", "  ", "mock", "MOCK"])("selects the mock for adapter value %j", (v) => {
    const p = createMercadoPagoProvidersFromEnv({ MERCADOPAGO_ADAPTER: v });
    expect(p.payout).toBeInstanceOf(MockPayoutProvider);
  });

  // covers AG-PAY-10, AG-SEC-03
  it.each(["real", "production", "anything"])("fails fast for non-mock adapter %j without network", (v) => {
    expect(() => createMercadoPagoProvidersFromEnv({ MERCADOPAGO_ADAPTER: v })).toThrow(ConfigurationError);
    expect(() => createMercadoPagoProviders({ adapter: v })).toThrow(ConfigurationError);
  });
});

describe("error hygiene", () => {
  // covers AG-SEC-02
  it("keeps errors plain and free of credential-like values or payload data", async () => {
    const secretLike = "APP_USR-test-credential-value";
    const errors: Error[] = [];
    try {
      createMercadoPagoProviders({ adapter: secretLike });
    } catch (e) {
      errors.push(e as Error);
    }
    const mock = new MockPayoutProvider();
    await mock.createPayout(payoutReq());
    await mock.createPayout(payoutReq({ amount: 1 })).catch((e: Error) => errors.push(e));
    await new MockTopupProvider().verifyNotification({ id: secretLike, resourceId: secretLike, signature: secretLike }).catch((e: Error) => errors.push(e));
    expect(errors).toHaveLength(3);
    for (const e of errors) {
      const text = `${e.name} ${e.message} ${e.stack ?? ""}`;
      expect(text).not.toContain(secretLike);
      expect(text).not.toMatch(/token|secret|password|business@example\.com|APP_USR|Bearer/i);
    }
  });

  it("does not write to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const mock = new MockPayoutProvider();
    await mock.createPayout(payoutReq());
    await new MockTopupProvider().createTopup(topupReq());
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
