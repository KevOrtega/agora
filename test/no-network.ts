import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { afterEach, beforeEach } from "vitest";

/**
 * Shared network guard for tests. It BLOCKS (throws or rejects before any I/O) instead of detecting afterwards,
 * and records every attempt so a test still fails when production code swallows the error with try/catch.
 *
 * Covered: globalThis.fetch (Node's built-in undici; the `undici` package is not a dependency, so it is not
 * patched directly, and its sockets go through the net/tls/dns patches below), http/https request+get,
 * net.connect/createConnection/Socket.prototype.connect, tls.connect, dns.lookup, dns.resolve*, dns.reverse,
 * dns.lookupService, the same on dns.promises, and the Resolver prototypes.
 *
 * Not covered (residual): native addons, child processes, UDP (dgram), and code that captured a reference to an
 * original function before the guard was installed.
 */

export class NetworkBlockedError extends Error {
  override readonly name = "NetworkBlockedError";
}

export interface NetworkAttempt {
  readonly api: string;
  /** Host involved, when it could be determined (never a full URL). */
  readonly host: string;
}

export interface NetworkBlockerOptions {
  /** When true, destinations `127.0.0.1`, `::1` and `localhost` (and local IPC paths) pass through. */
  readonly allowLoopback: boolean;
}

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;
type Obj = Record<string, unknown>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null;

function hostOfUrl(value: unknown): string[] {
  try {
    if (typeof value === "string") return [new URL(value).hostname];
    if (value instanceof URL) return [value.hostname];
    if (isObject(value) && typeof value.url === "string") return [new URL(value.url).hostname]; // Request
  } catch {
    // fall through: unparseable target is treated as non-loopback
  }
  return ["<unparseable>"];
}

function hostsFromOptions(options: unknown): string[] {
  if (!isObject(options)) return [];
  const hosts: string[] = [];
  for (const key of ["host", "hostname"] as const) {
    const v = options[key];
    if (typeof v === "string") hosts.push(v);
  }
  return hosts;
}

/** fetch(input, init): the host of the URL or Request. */
const fetchHosts = (args: unknown[]): string[] => hostOfUrl(args[0]);

/** http(s).request/get(url | options, options?, cb?): hosts from the URL and options (default host is localhost). */
function httpHosts(args: unknown[]): string[] {
  const hosts: string[] = [];
  if (typeof args[0] === "string" || args[0] instanceof URL) hosts.push(...hostOfUrl(args[0]));
  else hosts.push(...hostsFromOptions(args[0]));
  if (isObject(args[1])) hosts.push(...hostsFromOptions(args[1]));
  return hosts;
}

/** net/tls connect forms: (options), (port, host?), (path), or the normalized `[options, cb]` array. */
function netHosts(args: unknown[]): string[] {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // normalized args used internally by net
  if (isObject(first)) {
    if (typeof first.path === "string") return []; // local IPC
    if (first.socket !== undefined) return []; // wraps an existing socket
    const hosts = hostsFromOptions(first);
    return hosts.length > 0 ? hosts : ["localhost"];
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return [typeof args[1] === "string" ? args[1] : "localhost"];
  }
  if (typeof first === "string") return []; // IPC path
  return ["<unparseable>"];
}

/** dns.*(name, ...): the name being resolved. */
const dnsHosts = (args: unknown[]): string[] => [typeof args[0] === "string" ? args[0] : "<unparseable>"];

interface PatchSpec {
  readonly owner: Obj;
  readonly key: string;
  readonly api: string;
  readonly promise: boolean;
  readonly hosts: (args: unknown[]) => string[];
}

const DNS_FN = /^(resolve|reverse$|lookupService$)/;

function dnsSpecs(owner: Obj, prefix: string, promise: boolean, withLookup: boolean): PatchSpec[] {
  return Object.keys(owner)
    .filter((k) => typeof owner[k] === "function" && (DNS_FN.test(k) || (withLookup && k === "lookup")))
    .map((key) => ({ owner, key, api: `${prefix}.${key}`, promise, hosts: key === "lookupService" ? () => ["<address>"] : dnsHosts }));
}

function buildSpecs(): PatchSpec[] {
  const dnsApi = dns as unknown as Obj;
  const dnsPromises = dns.promises as unknown as Obj;
  const resolverProto = (dns.Resolver as unknown as { prototype: Obj }).prototype;
  const promisesResolverProto = (dns.promises.Resolver as unknown as { prototype: Obj }).prototype;
  return [
    { owner: globalThis as unknown as Obj, key: "fetch", api: "fetch", promise: true, hosts: fetchHosts },
    { owner: http as unknown as Obj, key: "request", api: "http.request", promise: false, hosts: httpHosts },
    { owner: http as unknown as Obj, key: "get", api: "http.get", promise: false, hosts: httpHosts },
    { owner: https as unknown as Obj, key: "request", api: "https.request", promise: false, hosts: httpHosts },
    { owner: https as unknown as Obj, key: "get", api: "https.get", promise: false, hosts: httpHosts },
    { owner: net as unknown as Obj, key: "connect", api: "net.connect", promise: false, hosts: netHosts },
    { owner: net as unknown as Obj, key: "createConnection", api: "net.createConnection", promise: false, hosts: netHosts },
    { owner: net.Socket.prototype as unknown as Obj, key: "connect", api: "net.Socket.prototype.connect", promise: false, hosts: netHosts },
    { owner: tls as unknown as Obj, key: "connect", api: "tls.connect", promise: false, hosts: netHosts },
    ...dnsSpecs(dnsApi, "dns", false, true),
    ...dnsSpecs(dnsPromises, "dns.promises", true, true),
    ...dnsSpecs(resolverProto, "dns.Resolver.prototype", false, false),
    ...dnsSpecs(promisesResolverProto, "dns.promises.Resolver.prototype", true, false),
  ];
}

export interface NetworkBlocker {
  /** Attempts recorded since the last `clear()`. */
  readonly attempts: readonly NetworkAttempt[];
  install(): void;
  uninstall(): void;
  clear(): void;
  /** Throws when any attempt was recorded (also catches attempts swallowed by production code). */
  assertNoAttempts(): void;
}

export function createNetworkBlocker(options: NetworkBlockerOptions): NetworkBlocker {
  const attempts: NetworkAttempt[] = [];
  const saved: Array<{ spec: PatchSpec; original: unknown }> = [];

  const wrap = (spec: PatchSpec, original: AnyFn): AnyFn =>
    function (this: unknown, ...args: unknown[]): unknown {
      const hosts = spec.hosts(args);
      const offending = hosts.find((h) => !LOOPBACK_HOSTS.has(normalizeHost(h)));
      if (options.allowLoopback && offending === undefined) return original.apply(this, args);
      attempts.push({ api: spec.api, host: offending ?? hosts[0] ?? "<none>" });
      const error = new NetworkBlockedError(`Network access blocked in tests: ${spec.api}`);
      if (spec.promise) return Promise.reject(error);
      throw error;
    };

  return {
    get attempts() {
      return attempts;
    },
    install() {
      if (saved.length > 0) throw new Error("Network blocker is already installed");
      for (const spec of buildSpecs()) {
        const original = spec.owner[spec.key];
        if (typeof original !== "function") continue;
        saved.push({ spec, original });
        spec.owner[spec.key] = wrap(spec, original as AnyFn);
      }
      syncBuiltinESMExports();
    },
    uninstall() {
      for (const { spec, original } of saved.reverse()) spec.owner[spec.key] = original;
      saved.length = 0;
      syncBuiltinESMExports();
    },
    clear() {
      attempts.length = 0;
    },
    assertNoAttempts() {
      if (attempts.length > 0) {
        const list = attempts.map((a) => `${a.api} -> ${a.host}`).join(", ");
        throw new Error(`Network access was attempted during the test: ${list}`);
      }
    },
  };
}

/** Process-level guard installed for every test file by `test/setup-network-guard.ts`; loopback is allowed. */
export const processGuard = createNetworkBlocker({ allowLoopback: true });

/**
 * Strict guard for integration suites: blocks everything (loopback too) around each test and fails the test if
 * any attempt was recorded, even one swallowed by the code under test.
 */
export function installNoNetworkGuard(): void {
  const guard = createNetworkBlocker({ allowLoopback: false });
  beforeEach(() => {
    guard.clear();
    guard.install();
  });
  afterEach(() => {
    guard.uninstall();
    guard.assertNoAttempts();
  });
}
