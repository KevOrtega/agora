// Test-only fixtures with obviously fictitious data.
import type { PGlite } from "@electric-sql/pglite";

let counter = 0;

export async function insertCustomer(db: PGlite, phone?: string): Promise<string> {
  counter += 1;
  const res = await db.query<{ id: string }>(
    "INSERT INTO customers (whatsapp_phone, display_name, email) VALUES ($1, 'Test Customer', 'customer@example.com') RETURNING id",
    [phone ?? `+549000000${String(counter).padStart(4, "0")}`],
  );
  return res.rows[0]!.id;
}

export async function insertBusiness(db: PGlite, phone?: string): Promise<string> {
  counter += 1;
  const res = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, category, whatsapp_phone, source) VALUES ('Test Ice Cream Shop', 'ice_cream', $1, 'test') RETURNING id",
    [phone ?? `+549111000${String(counter).padStart(4, "0")}`],
  );
  return res.rows[0]!.id;
}

export async function insertAccount(
  db: PGlite,
  type: string,
  owner: { customerId?: string; businessId?: string } = {},
): Promise<string> {
  const res = await db.query<{ id: string }>(
    "INSERT INTO ledger_accounts (account_type, customer_id, business_id) VALUES ($1, $2, $3) RETURNING id",
    [type, owner.customerId ?? null, owner.businessId ?? null],
  );
  return res.rows[0]!.id;
}

/** Inserts a balanced two-entry transaction (debit `from`, credit `to`). */
export async function insertTransfer(
  db: PGlite,
  key: string,
  kind: string,
  debitAccount: string,
  creditAccount: string,
  amount: number,
): Promise<string> {
  return db.transaction(async (tx) => {
    const t = await tx.query<{ id: string }>(
      "INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ($1, $2) RETURNING id",
      [key, kind],
    );
    const id = t.rows[0]!.id;
    await tx.query(
      "INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor) VALUES ($1, $2, 'debit', $4), ($1, $3, 'credit', $4)",
      [id, debitAccount, creditAccount, amount],
    );
    return id;
  });
}
