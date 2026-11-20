import { PGlite } from "@electric-sql/pglite";
import { expect } from "vitest";
import { loadMigrations, migrateUp } from "../../src/modules/database/index.js";
import { createClient } from "./pglite_client.js";

let template: Promise<Blob> | undefined;

/** Returns a fresh, fully migrated database (restored from a per-file migrated snapshot). */
export async function freshDb(): Promise<PGlite> {
  template ??= (async () => {
    const seed = new PGlite();
    await migrateUp(createClient(seed), await loadMigrations());
    const dump = (await seed.dumpDataDir("none")) as Blob;
    await seed.close();
    return dump;
  })();
  return new PGlite({ loadDataDir: await template });
}

export interface ExpectedPgError {
  code: string;
  constraint?: string;
  message?: RegExp;
}

/** Asserts that a promise rejects with a Postgres error of the given SQLSTATE (and details). */
export async function expectPgError(promise: Promise<unknown>, expected: ExpectedPgError) {
  let error: (Error & { code?: string; constraint?: string }) | undefined;
  try {
    await promise;
  } catch (e) {
    error = e as Error & { code?: string; constraint?: string };
  }
  expect(error, "expected the statement to be rejected").toBeDefined();
  expect(error!.code).toBe(expected.code);
  if (expected.constraint !== undefined) expect(error!.constraint).toBe(expected.constraint);
  if (expected.message !== undefined) expect(error!.message).toMatch(expected.message);
}

export const UNIQUE = "23505";
export const FK = "23503";
export const CHECK = "23514";
export const INTEGRITY = "23000";
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
