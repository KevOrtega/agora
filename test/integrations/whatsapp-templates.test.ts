import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MessagingError,
  MockMessagingProvider,
  TEMPLATE_CATALOG,
  TEMPLATE_CATALOG_STATUS,
  type MessagingErrorKind,
  type SendRequest,
  type TemplateMessage,
} from "../../src/integrations/whatsapp/index.js";

const PHONE = "+5491100000001";
const OTHER_PHONE = "+5491100000002";

const spies = {
  fetch: vi.fn(),
  httpRequest: vi.fn(),
  httpsRequest: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  vi.stubGlobal("fetch", spies.fetch);
  vi.spyOn(http, "request").mockImplementation(spies.httpRequest);
  vi.spyOn(https, "request").mockImplementation(spies.httpsRequest);
  vi.spyOn(console, "log").mockImplementation(spies.log);
  vi.spyOn(console, "error").mockImplementation(spies.error);
  vi.spyOn(console, "warn").mockImplementation(spies.warn);
});

afterEach(() => {
  for (const spy of Object.values(spies)) {
    expect(spy).not.toHaveBeenCalled();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function failure(promise: Promise<unknown>): Promise<MessagingError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(MessagingError);
    return e as MessagingError;
  }
  throw new Error("expected the promise to reject");
}

const tpl = (over: Partial<TemplateMessage> = {}): TemplateMessage => ({
  type: "template",
  name: "order_update",
  category: "utility",
  languageCode: "es_AR",
  parameters: { order_reference: "1234", status: "confirmed" },
  ...over,
});
const req = (key: string, message: TemplateMessage, to = PHONE): SendRequest => ({
  idempotencyKey: key,
  to,
  message,
});

describe("template catalog", () => {
  it("is explicitly provisional, utility, es_AR, with named snake_case parameters", () => {
    expect(TEMPLATE_CATALOG_STATUS).toBe("provisional");
    expect(TEMPLATE_CATALOG.map((t) => t.name)).toEqual([
      "order_update",
      "credit_topup_confirmation",
      "payout_update",
      "business_order_request",
    ]);
    for (const t of TEMPLATE_CATALOG) {
      expect(t.provisional).toBe(true);
      expect(t.category).toBe("utility");
      expect(t.languageCode).toBe("es_AR");
      for (const p of t.parameters) expect(p).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it("accepts every catalog entry with its exact parameters", async () => {
    const p = new MockMessagingProvider();
    for (const [i, t] of TEMPLATE_CATALOG.entries()) {
      const parameters = Object.fromEntries(t.parameters.map((n) => [n, "x"]));
      await p.send(req(`k${i}`, tpl({ name: t.name, parameters })));
    }
    expect(p.listOutbound()).toHaveLength(TEMPLATE_CATALOG.length);
  });
});

describe("template validation", () => {
  const cases: Array<[string, TemplateMessage, MessagingErrorKind]> = [
    ["unknown template", tpl({ name: "secret_template_name" }), "unknown_template"],
    ["category mismatch", tpl({ category: "marketing" }), "template_mismatch"],
    ["language mismatch", tpl({ languageCode: "en_US" }), "template_mismatch"],
    ["missing parameter", tpl({ parameters: { order_reference: "1234" } }), "invalid_template_parameters"],
    [
      "extra parameter",
      tpl({ parameters: { order_reference: "1234", status: "ok", extra_field: "v" } }),
      "invalid_template_parameters",
    ],
    [
      "renamed parameter",
      tpl({ parameters: { order_reference: "1234", state: "ok" } }),
      "invalid_template_parameters",
    ],
  ];

  // covers AG-WA-03 (c), AG-SEC-02
  it.each(cases)("rejects %s as permanent, records nothing and does not echo input", async (_n, message, kind) => {
    const p = new MockMessagingProvider();
    const err = await failure(p.send(req("k1", message)));
    expect(err.kind).toBe(kind);
    expect(err.retryable).toBe(false);
    expect(p.listOutbound()).toHaveLength(0);
    const echoed = [
      message.name,
      message.languageCode,
      PHONE,
      ...Object.keys(message.parameters),
      ...Object.values(message.parameters),
    ];
    for (const s of echoed) expect(err.message).not.toContain(s);
  });

  it("honours an overridden approved set", async () => {
    const p = new MockMessagingProvider({
      approvedTemplates: [
        { name: "only_here", category: "utility", languageCode: "es_AR", parameters: [], provisional: true },
      ],
    });
    await p.send(req("k1", tpl({ name: "only_here", parameters: {} })));
    expect((await failure(p.send(req("k2", tpl())))).kind).toBe("unknown_template");
  });
});

describe("provider message ids", () => {
  // covers AG-WA-03
  it("uses the wamid.mock. format and sequential ids", async () => {
    const p = new MockMessagingProvider();
    const ids: string[] = [];
    for (const k of ["a", "b", "c"]) ids.push((await p.send(req(k, tpl()))).providerMessageId);
    for (const id of ids) expect(id).toMatch(/^wamid\.mock\.\d{6}$/);
    expect(ids).toEqual(["wamid.mock.000001", "wamid.mock.000002", "wamid.mock.000003"]);
  });
});

describe("failures are not stored under the idempotency key", () => {
  // covers AG-IDEM-10
  it("lets a corrected payload succeed after a permanent failure with the same key", async () => {
    const p = new MockMessagingProvider();
    const bad = tpl({ parameters: { order_reference: "1234" } });
    expect((await failure(p.send(req("k1", bad)))).kind).toBe("invalid_template_parameters");
    await p.send(req("k1", tpl()));
    expect(p.listOutbound()).toHaveLength(1);
  });

  it("fails again with the same kind when retried with the same failing payload", async () => {
    const p = new MockMessagingProvider();
    const bad = tpl({ category: "marketing" });
    expect((await failure(p.send(req("k1", bad)))).kind).toBe("template_mismatch");
    expect((await failure(p.send(req("k1", bad)))).kind).toBe("template_mismatch");
    expect(p.listOutbound()).toHaveLength(0);
  });
});

describe("error classification", () => {
  it("classifies a simulated transient failure as retryable", async () => {
    const p = new MockMessagingProvider();
    p.simulateTransientFailure(1);
    const err = await failure(p.send(req("k1", tpl())));
    expect(err.kind).toBe("transient");
    expect(err.retryable).toBe(true);
  });

  it.each<[MessagingErrorKind, boolean]>([
    ["transient", true],
    ["timeout", true],
    ["invalid_recipient", false],
    ["unknown_template", false],
    ["template_mismatch", false],
    ["invalid_template_parameters", false],
    ["outside_window", false],
    ["idempotency_conflict", false],
  ])("kind %s has retryable=%s", (kind, retryable) => {
    expect(new MessagingError(kind, "x").retryable).toBe(retryable);
  });
});

describe("canonical idempotency payload", () => {
  // covers AG-IDEM-10
  it("replays the original result when parameter or field order differs", async () => {
    const p = new MockMessagingProvider();
    const first = await p.send(req("k1", tpl({ parameters: { order_reference: "1234", status: "ok" } })));
    const reordered: SendRequest = {
      message: {
        parameters: { status: "ok", order_reference: "1234" },
        languageCode: "es_AR",
        category: "utility",
        name: "order_update",
        type: "template",
      },
      to: PHONE,
      idempotencyKey: "k1",
    };
    const again = await p.send(reordered);
    expect(again).toEqual(first);
    expect(p.listOutbound()).toHaveLength(1);
  });

  // covers AG-IDEM-10
  it.each<[string, SendRequest]>([
    ["recipient", req("k1", tpl(), OTHER_PHONE)],
    ["parameter value", req("k1", tpl({ parameters: { order_reference: "9999", status: "ok" } }))],
    ["template", req("k1", tpl({ name: "payout_update", parameters: { payout_reference: "1", status: "ok", amount: "2" } }))],
  ])("treats a different %s as a conflict", async (_n, other) => {
    const p = new MockMessagingProvider();
    await p.send(req("k1", tpl({ parameters: { order_reference: "1234", status: "ok" } })));
    const err = await failure(p.send(other));
    expect(err.kind).toBe("idempotency_conflict");
    expect(p.listOutbound()).toHaveLength(1);
  });
});
