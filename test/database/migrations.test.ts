import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { appliedVersions, loadMigrations, migrateDown, migrateUp } from "../../src/modules/database/index.js";
import { createClient } from "./pglite_client.js";

const APP_TABLES = [
  "businesses", "customers", "ledger_accounts", "ledger_entries", "ledger_transactions",
  "orders", "products", "schema_migrations",
];

async function objects(db: PGlite) {
  const q = async (sql: string) => (await db.query<{ n: string }>(sql)).rows.map((r) => r.n);
  return {
    tables: await q("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1"),
    functions: await q("SELECT p.proname AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public'"),
    triggers: await q("SELECT tgname AS n FROM pg_trigger WHERE NOT tgisinternal"),
    types: await q("SELECT t.typname AS n FROM pg_type t JOIN pg_namespace s ON s.oid = t.typnamespace WHERE s.nspname = 'public' AND t.typtype IN ('e','d') "),
  };
}

describe("migrations (covers F0-2 criterion 2)", () => {
  let db: PGlite;
  beforeAll(async () => { db = new PGlite(); });
  afterAll(async () => { await db.close(); });

  it("every migration has up and down, versions are ordered", async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual([...versions].sort());
    for (const m of migrations) {
      expect(m.up.trim()).not.toBe("");
      expect(m.down.trim()).not.toBe("");
    }
  });

  it("up on an empty database creates all expected tables and records versions in order", async () => {
    const client = createClient(db);
    const migrations = await loadMigrations();
    const applied = await migrateUp(client, migrations);
    expect(applied).toEqual(migrations.map((m) => m.version));
    expect((await objects(db)).tables).toEqual(APP_TABLES);
    expect(await appliedVersions(client)).toEqual(migrations.map((m) => m.version));
  });

  it("re-running up is a no-op", async () => {
    const client = createClient(db);
    expect(await migrateUp(client, await loadMigrations())).toEqual([]);
  });

  it("down removes all application objects", async () => {
    const client = createClient(db);
    const migrations = await loadMigrations();
    const rolledBack = await migrateDown(client, migrations);
    expect(rolledBack).toEqual(migrations.map((m) => m.version).reverse());
    expect(await objects(db)).toEqual({ tables: [], functions: [], triggers: [], types: [] });
  });

  it("up -> down -> up works again", async () => {
    const client = createClient(db);
    const migrations = await loadMigrations();
    await migrateUp(client, migrations);
    expect((await objects(db)).tables).toEqual(APP_TABLES);
    await migrateDown(client, migrations);
    await migrateUp(client, migrations);
    expect((await objects(db)).tables).toEqual(APP_TABLES);
  });

  it("partial down (steps) rolls back only the latest migration", async () => {
    const client = createClient(db);
    const migrations = await loadMigrations();
    const last = migrations[migrations.length - 1]!;
    expect(await migrateDown(client, migrations, 1)).toEqual([last.version]);
    expect(await appliedVersions(client)).not.toContain(last.version);
  });
});
