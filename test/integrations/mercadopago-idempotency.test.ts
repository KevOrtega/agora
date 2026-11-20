import { describe, expect, it } from "vitest";
import {
  IdempotencyConflictError,
  InvalidRequestError,
  MockPayoutProvider,
  MockTopupProvider,
  ProviderTimeoutError,
  type CreatePayoutRequest,
  type CreateTopupRequest,
} from "../../src/integrations/mercadopago/index.js";

const topupReq = (over: Partial<CreateTopupRequest> = {}): CreateTopupRequest => ({
  externalReference: "topup-idem-1",
  customerId: "cust-idem-1",
  amount: 1500,
  currency: "ARS",
  ...over,
});

const payoutReq = (over: Partial<CreatePayoutRequest> = {}): CreatePayoutRequest => ({
  idempotencyKey: "payout-idem-1",
  amount: 2500,
  currency: "ARS",
  destination: { type: "mercadopago_email", email: "business@example.com" },
  reference: "order-idem-1",
  ...over,
});

describe("top-up strict idempotency (covers m1, AG-IDEM-03, AG-IDEM-10)", () => {
  it.each(["approve", "reject", "pending"] as const)(
    "m1: same reference and same payload returns the stored payment (%s), count 1",
    async (scenario) => {
      const provider = new MockTopupProvider(scenario);
      const first = await provider.createTopup(topupReq());
      const second = await provider.createTopup(topupReq());
      expect(second).toEqual(first);
      expect(provider.paymentCount()).toBe(1);
    },
  );

  it("m1: retry after settlement returns the settled status", async () => {
    const provider = new MockTopupProvider("pending");
    const first = await provider.createTopup(topupReq());
    provider.settle(first.providerPaymentId, "approve");
    const retry = await provider.createTopup(topupReq());
    expect(retry.status).toBe("approved");
    expect(retry.providerPaymentId).toBe(first.providerPaymentId);
    expect(provider.paymentCount()).toBe(1);
  });

  it("m1: same reference with a different amount is a conflict and changes nothing", async () => {
    const provider = new MockTopupProvider();
    const first = await provider.createTopup(topupReq());
    await expect(provider.createTopup(topupReq({ amount: 1501 }))).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(provider.paymentCount()).toBe(1);
    expect(await provider.createTopup(topupReq())).toEqual(first);
  });

  it("m1: same reference with a different customer is a conflict and changes nothing", async () => {
    const provider = new MockTopupProvider();
    const first = await provider.createTopup(topupReq());
    await expect(provider.createTopup(topupReq({ customerId: "cust-idem-2" }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(provider.paymentCount()).toBe(1);
    expect(await provider.createTopup(topupReq())).toEqual(first);
  });

  it("m1: a different currency is rejected as InvalidRequestError (only ARS is supported), nothing changes", async () => {
    const provider = new MockTopupProvider();
    const first = await provider.createTopup(topupReq());
    const other = topupReq({ currency: "USD" as unknown as "ARS" });
    await expect(provider.createTopup(other)).rejects.toBeInstanceOf(InvalidRequestError);
    expect(provider.paymentCount()).toBe(1);
    expect(await provider.createTopup(topupReq())).toEqual(first);
  });

  it("m1: malformed requests are still validated first", async () => {
    const provider = new MockTopupProvider();
    await provider.createTopup(topupReq());
    await expect(provider.createTopup(topupReq({ amount: 0 }))).rejects.toBeInstanceOf(InvalidRequestError);
  });
});

describe("payout destination normalized idempotency (covers m2, AG-IDEM-10)", () => {
  const equivalents: Array<[string, CreatePayoutRequest["destination"]]> = [
    ["reordered destination keys", { email: "business@example.com", type: "mercadopago_email" }],
    ["mixed-case e-mail", { type: "mercadopago_email", email: "Business@Example.COM" }],
    ["surrounding whitespace", { type: "mercadopago_email", email: "  business@example.com \t" }],
  ];

  it.each(equivalents)("m2: no false conflict for %s", async (_name, destination) => {
    const provider = new MockPayoutProvider();
    const first = await provider.createPayout(payoutReq());
    const retry = await provider.createPayout(payoutReq({ destination }));
    expect(retry.providerPayoutId).toBe(first.providerPayoutId);
    expect(provider.listPayouts()).toHaveLength(1);
  });

  it("m2: a different e-mail address is a conflict", async () => {
    const provider = new MockPayoutProvider();
    await provider.createPayout(payoutReq());
    await expect(
      provider.createPayout(payoutReq({ destination: { type: "mercadopago_email", email: "other@example.com" } })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(provider.listPayouts()).toHaveLength(1);
  });

  it("m2: a different destination type is a conflict", async () => {
    const provider = new MockPayoutProvider();
    await provider.createPayout(payoutReq());
    const other = { type: "cbu", email: "business@example.com" } as unknown as CreatePayoutRequest["destination"];
    await expect(provider.createPayout(payoutReq({ destination: other }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it("m2: a different amount is a conflict", async () => {
    const provider = new MockPayoutProvider();
    await provider.createPayout(payoutReq());
    await expect(provider.createPayout(payoutReq({ amount: 2501 }))).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("m2: a different reference is a conflict", async () => {
    const provider = new MockPayoutProvider();
    await provider.createPayout(payoutReq());
    await expect(provider.createPayout(payoutReq({ reference: "order-idem-2" }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it("m2: normalized e-mail still triggers destination_not_found and destination_closed", async () => {
    const provider = new MockPayoutProvider();
    const unknown = await provider.createPayout(
      payoutReq({
        idempotencyKey: "k-unknown",
        destination: { type: "mercadopago_email", email: " Unknown@Example.com " },
      }),
    );
    expect(unknown.status).toBe("rejected");
    expect(unknown.rejectionReason).toBe("destination_not_found");
    const closed = await provider.createPayout(
      payoutReq({
        idempotencyKey: "k-closed",
        destination: { type: "mercadopago_email", email: "  Closed@Example.com " },
      }),
    );
    expect(closed.rejectionReason).toBe("destination_closed");
  });

  it("m2: a rejected payout replayed with an equivalent destination returns the same stored rejection", async () => {
    const provider = new MockPayoutProvider();
    const first = await provider.createPayout(
      payoutReq({ destination: { type: "mercadopago_email", email: "closed@example.com" } }),
    );
    const retry = await provider.createPayout(
      payoutReq({ destination: { email: "  CLOSED@example.com", type: "mercadopago_email" } }),
    );
    expect(retry).toEqual(first);
    expect(retry.rejectionReason).toBe("destination_closed");
    expect(provider.listPayouts()).toHaveLength(1);
  });

  it("m2: internal whitespace in an e-mail is not removed (invalid_destination)", async () => {
    const provider = new MockPayoutProvider();
    const result = await provider.createPayout(
      payoutReq({ destination: { type: "mercadopago_email", email: "busi ness@example.com" } }),
    );
    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("invalid_destination");
  });

  it("m2: timeout-after-processing retry with an equivalent destination returns the stored payout", async () => {
    const provider = new MockPayoutProvider();
    provider.simulateTimeoutAfterProcessing();
    await expect(provider.createPayout(payoutReq())).rejects.toBeInstanceOf(ProviderTimeoutError);
    const retry = await provider.createPayout(
      payoutReq({ destination: { email: " BUSINESS@example.com ", type: "mercadopago_email" } }),
    );
    expect(retry.status).toBe("succeeded");
    expect(provider.listPayouts()).toHaveLength(1);
  });
});
