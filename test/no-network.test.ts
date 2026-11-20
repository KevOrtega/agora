import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NetworkBlockedError, createNetworkBlocker, processGuard } from "./no-network.js";

// This file tests the guards themselves, so it manages its own blockers instead of installNoNetworkGuard().

const strict = createNetworkBlocker({ allowLoopback: false });
beforeEach(() => {
  strict.clear();
  strict.install();
});
afterEach(() => {
  strict.uninstall();
});

const noop = (): void => undefined;

type Case = [api: string, call: () => unknown];
const syncCases: Case[] = [
  ["http.request", () => http.request("http://127.0.0.1:9/")],
  ["http.get", () => http.get("http://127.0.0.1:9/")],
  ["https.request", () => https.request("https://example.invalid/")],
  ["https.get", () => https.get("https://example.invalid/")],
  ["net.connect", () => net.connect(9, "127.0.0.1")],
  ["net.createConnection", () => net.createConnection({ port: 9, host: "127.0.0.1" })],
  ["net.Socket.prototype.connect", () => new net.Socket().connect(9, "127.0.0.1")],
  ["tls.connect", () => tls.connect(9, "example.invalid")],
  ["dns.lookup", () => dns.lookup("example.invalid", noop)],
  ["dns.resolve", () => dns.resolve("example.invalid", noop)],
  ["dns.resolve4", () => dns.resolve4("example.invalid", noop)],
  ["dns.resolve6", () => dns.resolve6("example.invalid", noop)],
  ["dns.resolveTxt", () => dns.resolveTxt("example.invalid", noop)],
  ["dns.Resolver.prototype.resolve4", () => new dns.Resolver().resolve4("example.invalid", noop)],
];
const promiseCases: Case[] = [
  ["fetch", () => fetch("https://example.invalid/")],
  ["fetch (loopback, strict)", () => fetch("http://127.0.0.1:9/")],
  ["dns.promises.lookup", () => dns.promises.lookup("example.invalid")],
  ["dns.promises.resolve", () => dns.promises.resolve("example.invalid")],
  ["dns.promises.resolve4", () => dns.promises.resolve4("example.invalid")],
  ["dns.promises.resolveMx", () => dns.promises.resolveMx("example.invalid")],
];

describe("strict guard blocks every path before any I/O", () => {
  it.each(syncCases)("%s throws and records the attempt", (api, call) => {
    expect(call).toThrow(NetworkBlockedError);
    expect(strict.attempts).toHaveLength(1);
    expect(strict.attempts[0]?.api).toBe(api);
  });

  it.each(promiseCases)("%s rejects and records the attempt", async (api, call) => {
    await expect(call()).rejects.toBeInstanceOf(NetworkBlockedError);
    expect(strict.attempts).toHaveLength(1);
    expect(strict.attempts[0]?.api).toBe(api.startsWith("fetch") ? "fetch" : api);
  });

  it("blocks loopback too, and the error does not echo the URL", async () => {
    const error = await fetch("http://127.0.0.1:9/secret-path?token=x").catch((e: Error) => e);
    expect(error).toBeInstanceOf(NetworkBlockedError);
    expect((error as Error).message).not.toContain("secret-path");
  });
});

describe("recorded attempts", () => {
  it("still fail the check when production code swallows the error", async () => {
    try {
      await fetch("https://example.invalid/");
    } catch {
      // swallowed on purpose
    }
    expect(() => strict.assertNoAttempts()).toThrow(/fetch/);
    strict.clear();
    expect(() => strict.assertNoAttempts()).not.toThrow();
  });

  it("restores the original functions on uninstall", () => {
    strict.uninstall();
    const before = [http.request, globalThis.fetch, dns.lookup, net.Socket.prototype.connect];
    const other = createNetworkBlocker({ allowLoopback: false });
    other.install();
    expect(http.request).not.toBe(before[0]);
    other.uninstall();
    expect([http.request, globalThis.fetch, dns.lookup, net.Socket.prototype.connect]).toEqual(before);
  });
});

describe("process-level guard (loopback allowed, everything else blocked)", () => {
  afterEach(() => processGuard.clear());

  it("lets loopback traffic through without recording", async () => {
    strict.uninstall();
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      expect(await res.text()).toBe("ok");
      expect(processGuard.attempts).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    ["fetch", () => fetch("http://192.0.2.1/")],
    ["dns.promises.lookup", () => dns.promises.lookup("example.invalid")],
  ] as Array<[string, () => Promise<unknown>]>)("blocks and records a non-loopback %s", async (api, call) => {
    strict.uninstall();
    await expect(call()).rejects.toBeInstanceOf(NetworkBlockedError);
    expect(processGuard.attempts).toHaveLength(1);
    expect(processGuard.attempts[0]?.api).toBe(api);
  });

  it("blocks a non-loopback socket and an https request", () => {
    strict.uninstall();
    expect(() => net.connect(9, "192.0.2.1")).toThrow(NetworkBlockedError);
    expect(() => https.get("https://example.invalid/")).toThrow(NetworkBlockedError);
    expect(processGuard.attempts.map((a) => a.api)).toEqual(["net.connect", "https.get"]);
  });
});
