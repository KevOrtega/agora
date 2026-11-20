import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "../../src/modules/database/index.js";

/** Test-only adapter from PGlite to the SqlClient interface. */
export function createClient(db: PGlite): SqlClient {
  return {
    async query(sql, params) {
      const res = await db.query(sql, params);
      return { rows: res.rows as never[] };
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async transaction(fn) {
      return db.transaction(async (tx) =>
        fn({
          async query(sql, params) {
            const res = await tx.query(sql, params);
            return { rows: res.rows as never[] };
          },
          async exec(sql) {
            await tx.exec(sql);
          },
          transaction() {
            throw new Error("nested transactions are not supported");
          },
        }),
      );
    },
  };
}
