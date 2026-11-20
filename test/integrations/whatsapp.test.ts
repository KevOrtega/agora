import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOCK_VALID_SIGNATURE,
  MessagingError,
  MockMessagingProvider,
  createMessagingProvider,
  readWhatsAppConfig,
  type InboundMessage,
  type SendRequest,
} from "../../src/integrations/whatsapp/index.js";
import { installNoNetworkGuard } from "../no-network.js";

const PHONE = "+5491100000001";
const OTHER_PHONE = "+5491100000002";
const HOUR = 60 * 60 * 1000;

let nowMs = Date.UTC(2030, 0, 1, 12, 0, 0);
const clock = () => new Date(nowMs);

const inbound = (id: string, from = PHONE): InboundMessage => ({ id, from, text: "Hola, quiero pedir" });
const orderUpdate = (parameters: Record<string, string> = { order_reference: "1234", status: "confirmed" }) =>
  ({
    type: "template",
    name: "order_update",
    category: "utility",
    languageCode: "es_AR",
    parameters,
  }) as const;
const template = (key: string, to = PHONE): SendRequest => ({
  idempotencyKey: key,
  to,
  message: orderUpdate(),
});
const text = (key: string, to = PHONE): SendRequest => ({
  idempotencyKey: key,
  to,
  message: { type: "text", body: "Tu pedido está en camino" },
});

installNoNetworkGuard();

// Console silence: the mock must never log.
const spies = {
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  nowMs = Date.UTC(2030, 0, 1, 12, 0, 0);
  vi.spyOn(console, "log").mockImplementation(spies.log);
  vi.spyOn(console, "error").mockImplementation(spies.error);
  vi.spyOn(console, "warn").mockImplementation(spies.warn);
});

afterEach(() => {
  for (const spy of Object.values(spies)) {
    expect(spy).not.toHaveBeenCalled();
  }
  vi.restoreAllMocks();
});

const newProvider = () => new MockMessagingProvider({ now: clock });

async function failure(promise: Promise<unknown>): Promise<MessagingError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(MessagingError);
    return e as MessagingError;
  }
  throw new Error("expected the promise to reject");
}

describe("inbound deduplication", () => {
  // covers AG-IDEM-01 (adapter part)
  it("accepts the same inbound message id only once", () => {
    const p = newProvider();
    expect(p.receiveInbound({ message: inbound("wamid.A"), signature: MOCK_VALID_SIGNATURE })).toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(p.receiveInbound({ message: inbound("wamid.A"), signature: MOCK_VALID_SIGNATURE })).toEqual({
      accepted: false,
      duplicate: true,
    });
    expect(p.receiveInbound({ message: inbound("wamid.A"), signature: MOCK_VALID_SIGNATURE }).duplicate).toBe(true);
    expect(p.listInbound()).toHaveLength(1);
  });

  // covers AG-IDEM-01 (adapter part)
  it("accepts distinct inbound message ids without collapsing them", () => {
    const p = newProvider();
    p.receiveInbound({ message: inbound("wamid.A"), signature: MOCK_VALID_SIGNATURE });
    const second = p.receiveInbound({ message: inbound("wamid.B"), signature: MOCK_VALID_SIGNATURE });
    expect(second.accepted).toBe(true);
    expect(p.listInbound().map((r) => r.message.id)).toEqual(["wamid.A", "wamid.B"]);
  });
});

describe("inbound signature verification", () => {
  // covers AG-WA-01 (adapter part)
  it("rejects unsigned deliveries and does not record them", () => {
    const p = newProvider();
    const outcome = p.receiveInbound({ message: inbound("wamid.A"), signature: undefined });
    expect(outcome).toEqual({ accepted: false, duplicate: false, reason: "invalid_signature" });
    expect(p.listInbound()).toHaveLength(0);
  });

  // covers AG-WA-01 (adapter part)
  it("rejects wrongly signed deliveries, does not record them and does not burn the message id", () => {
    const p = newProvider();
    const bad = p.receiveInbound({ message: inbound("wamid.A"), signature: "sha256=wrong" });
    expect(bad).toMatchObject({ accepted: false, reason: "invalid_signature" });
    expect(p.listInbound()).toHaveLength(0);
    expect(p.receiveInbound({ message: inbound("wamid.A"), signature: MOCK_VALID_SIGNATURE }).accepted).toBe(true);
  });
});

describe("outbound recording", () => {
  it("records a template message with recipient, type and content without sending", async () => {
    const p = newProvider();
    const result = await p.send(template("k1"));
    expect(result.status).toBe("accepted");
    const [record, ...rest] = p.listOutbound();
    expect(rest).toHaveLength(0);
    expect(record).toMatchObject({
      to: PHONE,
      idempotencyKey: "k1",
      providerMessageId: result.providerMessageId,
      message: orderUpdate(),
    });
  });

  it("records a free-text message inside the service window", async () => {
    const p = newProvider();
    p.receiveInbound({ message: inbound("wamid.A"), signature: MOCK_VALID_SIGNATURE });
    await p.send(text("k1"));
    expect(p.listOutbound()).toMatchObject([{ to: PHONE, message: { type: "text", body: "Tu pedido está en camino" } }]);
  });
});

describe("idempotent sends and failures", () => {
  // covers AG-WA-03 (d) and AG-WA-10 (adapter part)
  it("records one message when a retry follows a lost response", async () => {
    const p = newProvider();
    p.simulateLostResponse(1);
    const err = await failure(p.send(template("k1")));
    expect(err.kind).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(p.listOutbound()).toHaveLength(1);
    const retry = await p.send(template("k1"));
    expect(retry.providerMessageId).toBe(p.listOutbound()[0]?.providerMessageId);
    expect(p.listOutbound()).toHaveLength(1);
  });

  // covers AG-WA-03 (d) and AG-WA-10 (adapter part)
  it("records one message when a retry follows a transient failure", async () => {
    const p = newProvider();
    p.simulateTransientFailure(2);
    expect((await failure(p.send(template("k1")))).retryable).toBe(true);
    expect(p.listOutbound()).toHaveLength(0);
    await failure(p.send(template("k1")));
    await p.send(template("k1"));
    await p.send(template("k1"));
    expect(p.listOutbound()).toHaveLength(1);
  });

  // covers AG-WA-10 (adapter part)
  it("does not block different idempotency keys with each other", async () => {
    const p = newProvider();
    const a = await p.send(template("k1"));
    const b = await p.send(template("k2"));
    expect(a.providerMessageId).not.toBe(b.providerMessageId);
    expect(p.listOutbound()).toHaveLength(2);
  });

  // covers AG-IDEM-10
  it("rejects the same idempotency key with a different payload as a conflict", async () => {
    const p = newProvider();
    await p.send(template("k1"));
    const err = await failure(p.send(template("k1", OTHER_PHONE)));
    expect(err.kind).toBe("idempotency_conflict");
    expect(err.retryable).toBe(false);
    expect(p.listOutbound()).toHaveLength(1);
  });

  // covers AG-WA-03 (c) (adapter part)
  it("reports an invalid recipient number as permanent and records nothing", async () => {
    const p = newProvider();
    const err = await failure(p.send(template("k1", "12345")));
    expect(err.kind).toBe("invalid_recipient");
    expect(err.retryable).toBe(false);
    expect(p.listOutbound()).toHaveLength(0);
  });

  // covers AG-WA-03 (c) (adapter part)
  it("reports an unknown template as permanent and records nothing", async () => {
    const p = newProvider();
    const request = template("k1");
    if (request.message.type === "template") request.message.name = "not_approved";
    const err = await failure(p.send(request));
    expect(err.kind).toBe("unknown_template");
    expect(err.retryable).toBe(false);
    expect(p.listOutbound()).toHaveLength(0);
  });
});

describe("24-hour service window", () => {
  // covers AG-WA-03 (e) (adapter part)
  it("refuses free text when the recipient never wrote, but accepts a template", async () => {
    const p = newProvider();
    const err = await failure(p.send(text("k1")));
    expect(err.kind).toBe("outside_window");
    expect(err.retryable).toBe(false);
    await p.send(template("k2"));
    expect(p.listOutbound()).toHaveLength(1);
  });

  // covers AG-WA-03 (e) (adapter part)
  it("refuses free text more than 24 hours after the last inbound message, accepts it before", async () => {
    const p = newProvider();
    p.receiveInbound({ message: inbound("wamid.A"), signature: MOCK_VALID_SIGNATURE });
    nowMs += 24 * HOUR;
    await p.send(text("k1"));
    nowMs += 1;
    expect((await failure(p.send(text("k2")))).kind).toBe("outside_window");
    await p.send(template("k3"));
    expect(p.listOutbound().map((r) => r.idempotencyKey)).toEqual(["k1", "k3"]);
  });

  it("tracks the window per recipient", async () => {
    const p = newProvider();
    p.receiveInbound({ message: inbound("wamid.A"), signature: MOCK_VALID_SIGNATURE });
    expect((await failure(p.send(text("k1", OTHER_PHONE)))).kind).toBe("outside_window");
  });
});

describe("configuration", () => {
  // covers AG-SEC-03
  it("returns the mock when no configuration is given", () => {
    expect(createMessagingProvider(readWhatsAppConfig({}))).toBeInstanceOf(MockMessagingProvider);
    expect(createMessagingProvider(readWhatsAppConfig({ WHATSAPP_ADAPTER: "  " }))).toBeInstanceOf(
      MockMessagingProvider,
    );
    expect(createMessagingProvider(readWhatsAppConfig({ WHATSAPP_ADAPTER: "mock" }))).toBeInstanceOf(
      MockMessagingProvider,
    );
  });

  // covers AG-SEC-03
  it("fails fast on a non-mock adapter without echoing the value", () => {
    const value = "cloud-api-fictitious-value";
    let message = "";
    try {
      createMessagingProvider(readWhatsAppConfig({ WHATSAPP_ADAPTER: value }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(value);
  });
});

describe("secrets hygiene", () => {
  // covers AG-SEC-02
  it("produces errors without credential-like values", async () => {
    const p = newProvider();
    const errors = [
      await failure(p.send(template("k1", "bad"))),
      await failure(p.send(text("k2"))),
    ];
    p.simulateTransientFailure(1);
    errors.push(await failure(p.send(template("k3"))));
    await p.send(template("k4"));
    errors.push(await failure(p.send(template("k4", OTHER_PHONE))));
    for (const e of errors) {
      expect(e.message).not.toMatch(/token|secret|bearer|password|sha256=|\+\d{6,}/i);
    }
  });
  // console silence is asserted for every test in afterEach
});
