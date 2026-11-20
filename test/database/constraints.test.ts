import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, migrateUp } from "../../src/modules/database/index.js";
import { createClient } from "./pglite_client.js";
import { insertAccount, insertBusiness, insertCustomer, insertTransfer } from "./fixtures.js";

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await migrateUp(createClient(db), await loadMigrations());
});
afterAll(async () => { await db.close(); });

const ORDER_STATES = [
  "pending_quote", "awaiting_customer", "awaiting_topup", "sent_to_business",
  "price_change_pending", "confirmed", "cancellation_pending", "shipped",
  "delivered", "under_review", "not_delivered", "cancelled",
];

async function insertOrder(customerId: string, status: string, mode = "prepaid", businessId: string | null = null) {
  return db.query(
    "INSERT INTO orders (customer_id, business_id, payment_mode, status) VALUES ($1, $2, $3, $4) RETURNING id",
    [customerId, businessId, mode, status],
  );
}

describe("uniqueness (F0-2 criterion 3)", () => {
  it("customer WhatsApp phone is unique", async () => {
    await insertCustomer(db, "+5490000009001");
    await expect(insertCustomer(db, "+5490000009001")).rejects.toThrow();
  });
  it("business WhatsApp phone is unique", async () => {
    await insertBusiness(db, "+5491110009001");
    await expect(insertBusiness(db, "+5491110009001")).rejects.toThrow();
  });
  it("one customer_balance per customer, one business_payable per business, single platform_commission", async () => {
    const c = await insertCustomer(db);
    const b = await insertBusiness(db);
    await insertAccount(db, "customer_balance", { customerId: c });
    await expect(insertAccount(db, "customer_balance", { customerId: c })).rejects.toThrow();
    await insertAccount(db, "business_payable", { businessId: b });
    await expect(insertAccount(db, "business_payable", { businessId: b })).rejects.toThrow();
    await insertAccount(db, "platform_commission");
    await expect(insertAccount(db, "platform_commission")).rejects.toThrow();
  });
});

describe("foreign keys (F0-2 criterion 3)", () => {
  it("products.business_id must reference a business", async () => {
    await expect(
      db.query("INSERT INTO products (business_id, name) VALUES (gen_random_uuid(), 'Test Product')"),
    ).rejects.toThrow();
  });
  it("orders reference an existing customer; business_id is nullable but must exist when set", async () => {
    const c = await insertCustomer(db);
    const b = await insertBusiness(db);
    await insertOrder(c, "pending_quote");
    await insertOrder(c, "pending_quote", "prepaid", b);
    await expect(insertOrder("00000000-0000-0000-0000-000000000000", "pending_quote")).rejects.toThrow();
    await expect(insertOrder(c, "pending_quote", "prepaid", "00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });
  it("ledger account owner must exist", async () => {
    await expect(
      insertAccount(db, "customer_balance", { customerId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toThrow();
  });
  it("ledger entries need an existing account; order_id optional but must exist", async () => {
    const c = await insertCustomer(db);
    const acc = await insertAccount(db, "customer_balance", { customerId: c });
    await db.query("BEGIN");
    try {
      const t = await db.query<{ id: string }>("INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ('fk-1', 'adjustment') RETURNING id");
      await expect(
        db.query("INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor) VALUES ($1, gen_random_uuid(), 'debit', 1)", [t.rows[0]!.id]),
      ).rejects.toThrow();
    } finally {
      await db.query("ROLLBACK");
    }
    await db.query("BEGIN");
    try {
      const t = await db.query<{ id: string }>("INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ('fk-2', 'adjustment') RETURNING id");
      await expect(
        db.query("INSERT INTO ledger_entries (transaction_id, account_id, order_id, direction, amount_minor) VALUES ($1, $2, gen_random_uuid(), 'debit', 1)", [t.rows[0]!.id, acc]),
      ).rejects.toThrow();
    } finally {
      await db.query("ROLLBACK");
    }
  });
});

describe("enums and checks (F0-2 criterion 3)", () => {
  it("AG-RANK-07: business status accepts proposed (distinct from active) and rejects unknown values", async () => {
    for (const s of ["proposed", "new", "active", "blocklisted"]) {
      await db.query("INSERT INTO businesses (name, whatsapp_phone, status) VALUES ('Test Ice Cream Shop', $1, $2)", [`+54911100${s}`, s]);
    }
    await expect(
      db.query("INSERT INTO businesses (name, whatsapp_phone, status) VALUES ('Test Ice Cream Shop', '+5491110008888', 'banned')"),
    ).rejects.toThrow();
    const def = await db.query<{ status: string }>("INSERT INTO businesses (name, whatsapp_phone) VALUES ('Test Ice Cream Shop', '+5491110008889') RETURNING status");
    expect(def.rows[0]!.status).toBe("proposed");
  });

  it("AG-POD-03/AG-POD-04: accepts_pay_on_delivery defaults to unknown, accepts only unknown/yes/no, updates persist", async () => {
    const b = await insertBusiness(db);
    const get = async () => (await db.query<{ v: string }>("SELECT accepts_pay_on_delivery AS v FROM businesses WHERE id = $1", [b])).rows[0]!.v;
    expect(await get()).toBe("unknown");
    for (const v of ["no", "yes", "unknown"]) {
      await db.query("UPDATE businesses SET accepts_pay_on_delivery = $2 WHERE id = $1", [b, v]);
      expect(await get()).toBe(v);
    }
    await expect(db.query("UPDATE businesses SET accepts_pay_on_delivery = 'maybe' WHERE id = $1", [b])).rejects.toThrow();
  });

  it("AG-RANK-06: product stores business, reported price and confirmation date; price may be absent", async () => {
    const b = await insertBusiness(db);
    await db.query("INSERT INTO products (business_id, name, reported_price_minor, price_confirmed_at) VALUES ($1, 'Test Product', 1000, '2030-01-01T00:00:00Z')", [b]);
    const r = await db.query<{ business_id: string; reported_price_minor: string; price_confirmed_at: Date }>("SELECT * FROM products WHERE business_id = $1", [b]);
    expect(r.rows[0]!.business_id).toBe(b);
    expect(Number(r.rows[0]!.reported_price_minor)).toBe(1000);
    expect(r.rows[0]!.price_confirmed_at.toISOString()).toBe("2030-01-01T00:00:00.000Z");
    await db.query("INSERT INTO products (business_id, name) VALUES ($1, 'Test Product Without Price')", [b]);
    await expect(db.query("INSERT INTO products (business_id, name, reported_price_minor) VALUES ($1, 'Bad', -1)", [b])).rejects.toThrow();
  });

  it("AG-SM: order status accepts exactly the 12 states; paid and refunded are rejected", async () => {
    const c = await insertCustomer(db);
    for (const s of ORDER_STATES) await insertOrder(c, s);
    for (const s of ["paid", "refunded", ""]) await expect(insertOrder(c, s)).rejects.toThrow();
  });

  it("AG-SM: payment_mode accepts only prepaid/pay_on_delivery; order total must be non-negative", async () => {
    const c = await insertCustomer(db);
    await insertOrder(c, "pending_quote", "prepaid");
    await insertOrder(c, "pending_quote", "pay_on_delivery");
    await expect(insertOrder(c, "pending_quote", "cash")).rejects.toThrow();
    await expect(db.query("INSERT INTO orders (customer_id, payment_mode, status, total_amount_minor) VALUES ($1, 'prepaid', 'pending_quote', -5)", [c])).rejects.toThrow();
  });

  it("ledger account type and owner consistency", async () => {
    const c = await insertCustomer(db);
    const b = await insertBusiness(db);
    await expect(insertAccount(db, "bogus")).rejects.toThrow();
    await expect(insertAccount(db, "customer_balance")).rejects.toThrow();
    await expect(insertAccount(db, "customer_balance", { businessId: b })).rejects.toThrow();
    await expect(insertAccount(db, "customer_balance", { customerId: c, businessId: b })).rejects.toThrow();
    await expect(insertAccount(db, "business_payable", { customerId: c })).rejects.toThrow();
    await expect(insertAccount(db, "business_payable")).rejects.toThrow();
    await expect(insertAccount(db, "topup_clearing", { customerId: c })).rejects.toThrow();
    await expect(insertAccount(db, "payout_clearing", { businessId: b })).rejects.toThrow();
    await insertAccount(db, "topup_clearing");
    await insertAccount(db, "payout_clearing");
  });

  it("entry amount must be positive and direction explicit", async () => {
    const acc = await insertAccount(db, "business_payable", { businessId: await insertBusiness(db) });
    for (const [dir, amt] of [["debit", 0], ["credit", -1], ["sideways", 1]] as const) {
      await db.query("BEGIN");
      try {
        const t = await db.query<{ id: string }>("INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ($1, 'adjustment') RETURNING id", [`chk-${dir}-${amt}`]);
        await expect(
          db.query("INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor) VALUES ($1, $2, $3, $4)", [t.rows[0]!.id, acc, dir, amt]),
        ).rejects.toThrow();
      } finally {
        await db.query("ROLLBACK");
      }
    }
  });

  it("ledger transaction kind is restricted", async () => {
    for (const k of ["topup", "order_debit", "refund", "commission", "payout", "adjustment"]) {
      await db.query("BEGIN");
      await db.query("INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ($1, $2)", [`kind-${k}`, k]);
      await db.query("ROLLBACK");
    }
    await expect(db.query("INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ('kind-x', 'gift')")).rejects.toThrow();
  });
});

describe("ledger integrity (F0-2 criterion 3)", () => {
  async function accounts() {
    const c = await insertCustomer(db);
    const clearing = await db.query<{ id: string }>("SELECT id FROM ledger_accounts WHERE account_type = 'topup_clearing'");
    const bal = await insertAccount(db, "customer_balance", { customerId: c });
    return { bal, clearing: clearing.rows[0]!.id };
  }

  it("AG-LED-01: an unbalanced transaction fails at COMMIT; a balanced one commits", async () => {
    const { bal, clearing } = await accounts();
    await db.query("BEGIN");
    const t = await db.query<{ id: string }>("INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ('unbalanced-1', 'topup') RETURNING id");
    await db.query("INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor) VALUES ($1, $2, 'debit', 100)", [t.rows[0]!.id, clearing]);
    await db.query("INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor) VALUES ($1, $2, 'credit', 90)", [t.rows[0]!.id, bal]);
    await expect(db.query("COMMIT")).rejects.toThrow(/not balanced/);
    await db.query("ROLLBACK").catch(() => undefined);
    expect((await db.query("SELECT 1 FROM ledger_transactions WHERE idempotency_key = 'unbalanced-1'")).rows).toHaveLength(0);

    await insertTransfer(db, "balanced-1", "topup", clearing, bal, 100);
    expect((await db.query("SELECT 1 FROM ledger_transactions WHERE idempotency_key = 'balanced-1'")).rows).toHaveLength(1);
  });

  it("AG-LED-01: a transaction header without entries fails at COMMIT", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.query("INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ('empty-1', 'adjustment')");
    })).rejects.toThrow(/not balanced/);
  });

  it("AG-IDEM-02/AG-IDEM-10: the same idempotency key cannot be inserted twice", async () => {
    const { bal, clearing } = await accounts();
    await insertTransfer(db, "idem-1", "topup", clearing, bal, 50);
    await expect(insertTransfer(db, "idem-1", "topup", clearing, bal, 50)).rejects.toThrow(/idempotency_key/);
  });

  it("AG-LED-03: UPDATE and DELETE on ledger entries and transactions fail", async () => {
    const { bal, clearing } = await accounts();
    await insertTransfer(db, "immut-1", "topup", clearing, bal, 10);
    await expect(db.query("UPDATE ledger_entries SET amount_minor = 999 WHERE account_id = $1", [bal])).rejects.toThrow(/immutable/);
    await expect(db.query("DELETE FROM ledger_entries WHERE account_id = $1", [bal])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE ledger_transactions SET kind = 'refund' WHERE idempotency_key = 'immut-1'")).rejects.toThrow(/immutable/);
    await expect(db.query("DELETE FROM ledger_transactions WHERE idempotency_key = 'immut-1'")).rejects.toThrow(/immutable/);
    await expect(db.query("TRUNCATE ledger_entries")).rejects.toThrow(/immutable/);
  });

  it("AG-LED-02: no balance column exists; balance is the SUM of entries", async () => {
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('ledger_accounts', 'customers', 'businesses')",
    );
    expect(cols.rows.filter((r) => /balance|saldo/.test(r.column_name))).toEqual([]);

    const { bal, clearing } = await accounts();
    await insertTransfer(db, "sum-1", "topup", clearing, bal, 300);
    await insertTransfer(db, "sum-2", "order_debit", bal, clearing, 120);
    const r = await db.query<{ balance: string }>(
      "SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS balance FROM ledger_entries WHERE account_id = $1",
      [bal],
    );
    expect(Number(r.rows[0]!.balance)).toBe(180);
  });

  it("customer_balance may go negative at schema level (enforced later by the ledger service)", async () => {
    const { bal, clearing } = await accounts();
    await insertTransfer(db, "neg-1", "order_debit", bal, clearing, 5);
  });
});

describe("naming (AG-SEC-04)", () => {
  it("all table and column names are lowercase snake_case ASCII", async () => {
    const t = await db.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'");
    const c = await db.query<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public'");
    const names = [...t.rows, ...c.rows].map((r) => r.name);
    expect(names.length).toBeGreaterThan(20);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
  });
});
