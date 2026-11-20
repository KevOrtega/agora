import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlClient } from "./sql_client.js";

export interface Migration {
  version: string;
  name: string;
  up: string;
  down: string;
}

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

/** Loads `NNNN_name.up.sql` / `NNNN_name.down.sql` pairs, sorted by version. */
export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).sort();
  const byVersion = new Map<string, Partial<Migration>>();
  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match) continue;
    const [, version, name, direction] = match as unknown as [string, string, string, "up" | "down"];
    const entry = byVersion.get(version) ?? { version, name };
    entry[direction] = await readFile(join(dir, file), "utf8");
    byVersion.set(version, entry);
  }
  return [...byVersion.values()].map((m) => {
    if (m.up === undefined || m.down === undefined) {
      throw new Error(`Migration ${m.version}_${m.name} must have both up and down files`);
    }
    return m as Migration;
  });
}

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export async function appliedVersions(db: SqlClient): Promise<string[]> {
  await db.exec(CREATE_TABLE_SQL);
  const res = await db.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return res.rows.map((r) => r.version);
}

/** Applies all pending migrations in order, each in its own transaction. Returns applied versions. */
export async function migrateUp(db: SqlClient, migrations: Migration[]): Promise<string[]> {
  const done = new Set(await appliedVersions(db));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.up);
      await tx.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
        m.version,
        m.name,
      ]);
    });
    applied.push(m.version);
  }
  return applied;
}

/**
 * Rolls back applied migrations in reverse order. Without `steps`, rolls back all of them
 * and then drops the bookkeeping table too. Returns rolled back versions.
 */
export async function migrateDown(
  db: SqlClient,
  migrations: Migration[],
  steps: number = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  const done = new Set(await appliedVersions(db));
  const rolledBack: string[] = [];
  for (const m of [...migrations].reverse()) {
    if (rolledBack.length >= steps) break;
    if (!done.has(m.version)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.down);
      await tx.query("DELETE FROM schema_migrations WHERE version = $1", [m.version]);
    });
    rolledBack.push(m.version);
  }
  if ((await appliedVersions(db)).length === 0) {
    await db.exec("DROP TABLE schema_migrations");
  }
  return rolledBack;
}
