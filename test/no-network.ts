import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";

/** Registers hooks that fail any test in the calling file that makes a network call (fetch, http, https). */
export function installNoNetworkGuard(): void {
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
}
