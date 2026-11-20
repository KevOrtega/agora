// Minimal SQL client contract. A real `pg` driver adapter can implement it later.
export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
}

export interface SqlClient {
  /** Runs one parameterized statement ($1, $2, ...). */
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
  /** Runs one or more statements without parameters (used for migration scripts). */
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside a transaction: commit on success, rollback on error. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}
