import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { insertAccount, insertBusiness, insertCustomer, insertTransfer } from "./fixtures.js";
import { CHECK, FK, INTEGRITY, NIL_UUID, UNIQUE, expectPgError, freshDb } from "./helpers.js";

// Every test gets its own freshly migrated database: no shared rows, no order dependence.
let db: PGlite;
beforeEach(async () => { db = await freshDb(); });
afterEach(async () => { await db.close(); });

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

async function openTransaction(key: string, kind = "adjustment"): Promise<string> {
  const t = await db.query<{ id: string }>(
    "INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ($1, $2) RETURNING id",
    [key, kind],
  );
  return t.rows[0]!.id;
}

const ENTRY_SQL =
  "INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor) VALUES ($1, $2, $3, $4)";

async function balanceOf(account: string): Promise<number> {
  const r = await db.query<{ balance: string }>(
    "SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS balance FROM ledger_entries WHERE account_id = $1",
    [account],
  );
  return Number(r.rows[0]!.balance);
}

async function entryCount(): Promise<number> {
  return Number((await db.query<{ n: string }>("SELECT COUNT(*) AS n FROM ledger_entries")).rows[0]!.n);
}

async function ledgerPair() {
  const c = await insertCustomer(db);
  const bal = await insertAccount(db, "customer_balance", { customerId: c });
  const clearing = await insertAccount(db, "topup_clearing");
  return { bal, clearing };
}

describe("uniqueness (F0-2 criterion 3)", () => {
  it("customer WhatsApp phone is unique", async () => {
    await insertCustomer(db, "+5490000009001");
    await expectPgError(insertCustomer(db, "+5490000009001"), { code: UNIQUE, constraint: "customers_whatsapp_phone_key" });
  });
  it("business WhatsApp phone is unique", async () => {
    await insertBusiness(db, "+5491110009001");
    await expectPgError(insertBusiness(db, "+5491110009001"), { code: UNIQUE, constraint: "businesses_whatsapp_phone_key" });
  });
  it("one customer_balance account per customer", async () => {
    const c = await insertCustomer(db);
    await insertAccount(db, "customer_balance", { customerId: c });
    await expectPgError(insertAccount(db, "customer_balance", { customerId: c }), { code: UNIQUE, constraint: "ledger_accounts_customer_balance_key" });
  });
  it("one business_payable account per business", async () => {
    const b = await insertBusiness(db);
    await insertAccount(db, "business_payable", { businessId: b });
    await expectPgError(insertAccount(db, "business_payable", { businessId: b }), { code: UNIQUE, constraint: "ledger_accounts_business_payable_key" });
  });
  it("a single platform_commission account", async () => {
    await insertAccount(db, "platform_commission");
    await expectPgError(insertAccount(db, "platform_commission"), { code: UNIQUE, constraint: "ledger_accounts_platform_key" });
  });
  it.each(["topup_clearing", "payout_clearing"])("a single %s account", async (type) => {
    await insertAccount(db, type);
    await expectPgError(insertAccount(db, type), { code: UNIQUE, constraint: "ledger_accounts_platform_key" });
  });
});

describe("foreign keys (F0-2 criterion 3)", () => {
  it("products.business_id must reference a business", async () => {
    await expectPgError(
      db.query("INSERT INTO products (business_id, name) VALUES (gen_random_uuid(), 'Test Product')"),
      { code: FK, constraint: "products_business_id_fkey" },
    );
  });
  it("orders.business_id is nullable but must exist when set", async () => {
    const c = await insertCustomer(db);
    const b = await insertBusiness(db);
    await insertOrder(c, "pending_quote");
    await insertOrder(c, "pending_quote", "prepaid", b);
    await expectPgError(insertOrder(c, "pending_quote", "prepaid", NIL_UUID), { code: FK, constraint: "orders_business_id_fkey" });
  });
  it("orders.customer_id must reference a customer", async () => {
    await expectPgError(insertOrder(NIL_UUID, "pending_quote"), { code: FK, constraint: "orders_customer_id_fkey" });
  });
  it("ledger account owner must exist", async () => {
    await expectPgError(insertAccount(db, "customer_balance", { customerId: NIL_UUID }), { code: FK, constraint: "ledger_accounts_customer_id_fkey" });
    await expectPgError(insertAccount(db, "business_payable", { businessId: NIL_UUID }), { code: FK, constraint: "ledger_accounts_business_id_fkey" });
  });
  it("ledger_entries.account_id must reference an account", async () => {
    await db.query("BEGIN");
    const t = await openTransaction("fk-1");
    await expectPgError(db.query(ENTRY_SQL, [t, NIL_UUID, "debit", 1]), { code: FK, constraint: "ledger_entries_account_id_fkey" });
    await db.query("ROLLBACK");
  });
  it("ledger_entries.order_id is optional but must exist when set", async () => {
    const { bal } = await ledgerPair();
    await db.query("BEGIN");
    const t = await openTransaction("fk-2");
    await expectPgError(
      db.query("INSERT INTO ledger_entries (transaction_id, account_id, order_id, direction, amount_minor) VALUES ($1, $2, $3, 'debit', 1)", [t, bal, NIL_UUID]),
      { code: FK, constraint: "ledger_entries_order_id_fkey" },
    );
    await db.query("ROLLBACK");
  });
});

describe("enums and checks (F0-2 criterion 3)", () => {
  it("AG-RANK-07: business status accepts proposed (distinct from active) and defaults to proposed", async () => {
    for (const s of ["proposed", "new", "active", "blocklisted"]) {
      await db.query("INSERT INTO businesses (name, whatsapp_phone, status) VALUES ('Test Ice Cream Shop', $1, $2)", [`+54911100${s}`, s]);
    }
    const def = await db.query<{ status: string }>("INSERT INTO businesses (name, whatsapp_phone) VALUES ('Test Ice Cream Shop', '+5491110008889') RETURNING status");
    expect(def.rows[0]!.status).toBe("proposed");
  });
  it("AG-RANK-07: business status rejects unknown values", async () => {
    await expectPgError(
      db.query("INSERT INTO businesses (name, whatsapp_phone, status) VALUES ('Test Ice Cream Shop', '+5491110008888', 'banned')"),
      { code: CHECK, constraint: "businesses_status_check" },
    );
  });

  it("AG-POD-03/AG-POD-04: accepts_pay_on_delivery defaults to unknown, accepts unknown/yes/no, updates persist", async () => {
    const b = await insertBusiness(db);
    const get = async () => (await db.query<{ v: string }>("SELECT accepts_pay_on_delivery AS v FROM businesses WHERE id = $1", [b])).rows[0]!.v;
    expect(await get()).toBe("unknown");
    for (const v of ["no", "yes", "unknown"]) {
      await db.query("UPDATE businesses SET accepts_pay_on_delivery = $2 WHERE id = $1", [b, v]);
      expect(await get()).toBe(v);
    }
  });
  it("AG-POD-03/AG-POD-04: accepts_pay_on_delivery rejects other values", async () => {
    const b = await insertBusiness(db);
    await expectPgError(
      db.query("UPDATE businesses SET accepts_pay_on_delivery = 'maybe' WHERE id = $1", [b]),
      { code: CHECK, constraint: "businesses_accepts_pay_on_delivery_check" },
    );
  });

  it("AG-RANK-06: product stores business, reported price and confirmation date; price may be absent", async () => {
    const b = await insertBusiness(db);
    await db.query("INSERT INTO products (business_id, name, reported_price_minor, price_confirmed_at) VALUES ($1, 'Test Product', 1000, '2030-01-01T00:00:00Z')", [b]);
    const r = await db.query<{ business_id: string; reported_price_minor: string; price_confirmed_at: Date }>("SELECT * FROM products WHERE business_id = $1", [b]);
    expect(r.rows[0]!.business_id).toBe(b);
    expect(Number(r.rows[0]!.reported_price_minor)).toBe(1000);
    expect(r.rows[0]!.price_confirmed_at.toISOString()).toBe("2030-01-01T00:00:00.000Z");
    await db.query("INSERT INTO products (business_id, name) VALUES ($1, 'Test Product Without Price')", [b]);
  });
  it("AG-RANK-06: product price must be non-negative", async () => {
    const b = await insertBusiness(db);
    await expectPgError(
      db.query("INSERT INTO products (business_id, name, reported_price_minor) VALUES ($1, 'Bad', -1)", [b]),
      { code: CHECK, constraint: "products_reported_price_minor_check" },
    );
  });

  it("AG-SM: order status accepts exactly the 12 states", async () => {
    const c = await insertCustomer(db);
    for (const s of ORDER_STATES) await insertOrder(c, s);
    const n = await db.query<{ n: string }>("SELECT COUNT(DISTINCT status) AS n FROM orders");
    expect(Number(n.rows[0]!.n)).toBe(12);
  });
  it.each(["paid", "refunded", ""])("AG-SM: order status %j is rejected", async (s) => {
    const c = await insertCustomer(db);
    await expectPgError(insertOrder(c, s), { code: CHECK, constraint: "orders_status_check" });
  });
  it("AG-SM: payment_mode accepts prepaid and pay_on_delivery", async () => {
    const c = await insertCustomer(db);
    await insertOrder(c, "pending_quote", "prepaid");
    await insertOrder(c, "pending_quote", "pay_on_delivery");
  });
  it("AG-SM: payment_mode rejects other values", async () => {
    const c = await insertCustomer(db);
    await expectPgError(insertOrder(c, "pending_quote", "cash"), { code: CHECK, constraint: "orders_payment_mode_check" });
  });
  it("order total must be non-negative", async () => {
    const c = await insertCustomer(db);
    await expectPgError(
      db.query("INSERT INTO orders (customer_id, payment_mode, status, total_amount_minor) VALUES ($1, 'prepaid', 'pending_quote', -5)", [c]),
      { code: CHECK, constraint: "orders_total_amount_minor_check" },
    );
  });

  it("ledger account owner consistency: valid combinations are accepted", async () => {
    const c = await insertCustomer(db);
    const b = await insertBusiness(db);
    await insertAccount(db, "customer_balance", { customerId: c });
    await insertAccount(db, "business_payable", { businessId: b });
    await insertAccount(db, "platform_commission");
    await insertAccount(db, "topup_clearing");
    await insertAccount(db, "payout_clearing");
  });
  it("ledger account type must be known", async () => {
    // Postgres evaluates CHECK constraints in name order, so the owner check reports first.
    await expectPgError(insertAccount(db, "bogus"), { code: CHECK, constraint: "ledger_accounts_owner_check" });
    const def = await db.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ledger_accounts_type_check'");
    expect(def.rows[0]!.def).toContain("customer_balance");
  });
  it.each([
    ["customer_balance", "none"],
    ["customer_balance", "business"],
    ["customer_balance", "both"],
    ["business_payable", "customer"],
    ["business_payable", "none"],
    ["topup_clearing", "customer"],
    ["payout_clearing", "business"],
    ["platform_commission", "customer"],
  ])("ledger account %s with owner %s is rejected", async (type, owner) => {
    const c = await insertCustomer(db);
    const b = await insertBusiness(db);
    const o = {
      none: {},
      customer: { customerId: c },
      business: { businessId: b },
      both: { customerId: c, businessId: b },
    }[owner as "none" | "customer" | "business" | "both"];
    await expectPgError(insertAccount(db, type, o), { code: CHECK, constraint: "ledger_accounts_owner_check" });
  });

  it.each([
    ["debit", 0, "ledger_entries_amount_minor_check"],
    ["credit", -1, "ledger_entries_amount_minor_check"],
    ["sideways", 1, "ledger_entries_direction_check"],
  ])("entry with direction %s and amount %i is rejected", async (dir, amt, constraint) => {
    const { bal } = await ledgerPair();
    await db.query("BEGIN");
    const t = await openTransaction("chk-1");
    await expectPgError(db.query(ENTRY_SQL, [t, bal, dir, amt]), { code: CHECK, constraint });
    await db.query("ROLLBACK");
  });

  it.each(["topup", "order_debit", "refund", "commission", "payout", "adjustment"])(
    "ledger transaction kind %s is accepted",
    async (k) => {
      await db.query("BEGIN");
      await openTransaction(`kind-${k}`, k);
      await db.query("ROLLBACK");
    },
  );
  it("ledger transaction kind is restricted", async () => {
    await expectPgError(
      db.query("INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ('kind-x', 'gift')"),
      { code: CHECK, constraint: "ledger_transactions_kind_check" },
    );
  });
});

describe("ledger integrity (F0-2 criterion 3)", () => {
  it("AG-LED-01: an unbalanced transaction fails at COMMIT and leaves nothing behind", async () => {
    const { bal, clearing } = await ledgerPair();
    await db.query("BEGIN");
    const t = await openTransaction("unbalanced-1", "topup");
    await db.query(ENTRY_SQL, [t, clearing, "debit", 100]);
    await db.query(ENTRY_SQL, [t, bal, "credit", 90]);
    await expectPgError(db.query("COMMIT"), { code: INTEGRITY, message: /not balanced/ });
    await db.query("ROLLBACK").catch(() => undefined);
    expect((await db.query("SELECT 1 FROM ledger_transactions WHERE idempotency_key = 'unbalanced-1'")).rows).toHaveLength(0);
    expect(await entryCount()).toBe(0);
  });

  it("AG-LED-01: a balanced transaction commits", async () => {
    const { bal, clearing } = await ledgerPair();
    await insertTransfer(db, "balanced-1", "topup", clearing, bal, 100);
    expect((await db.query("SELECT 1 FROM ledger_transactions WHERE idempotency_key = 'balanced-1'")).rows).toHaveLength(1);
    expect(await entryCount()).toBe(2);
  });

  it("AG-LED-01: a transaction header without entries fails at COMMIT", async () => {
    await expectPgError(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ('empty-1', 'adjustment')");
      }),
      { code: INTEGRITY, message: /not balanced/ },
    );
  });

  it("AG-IDEM-02/AG-IDEM-10 (partial, DB uniqueness only): the same idempotency key cannot be inserted twice", async () => {
    const { bal, clearing } = await ledgerPair();
    await insertTransfer(db, "idem-1", "topup", clearing, bal, 50);
    await expectPgError(insertTransfer(db, "idem-1", "topup", clearing, bal, 50), {
      code: UNIQUE,
      constraint: "ledger_transactions_idempotency_key_key",
    });
    expect(await entryCount()).toBe(2);
  });

  it("AG-LED-03: UPDATE and DELETE on ledger entries fail", async () => {
    const { bal, clearing } = await ledgerPair();
    await insertTransfer(db, "immut-1", "topup", clearing, bal, 10);
    await expectPgError(db.query("UPDATE ledger_entries SET amount_minor = 999 WHERE account_id = $1", [bal]), { code: INTEGRITY, message: /immutable/ });
    await expectPgError(db.query("DELETE FROM ledger_entries WHERE account_id = $1", [bal]), { code: INTEGRITY, message: /immutable/ });
    expect(await balanceOf(bal)).toBe(10);
  });
  it("AG-LED-03: UPDATE, DELETE and TRUNCATE on ledger transactions and TRUNCATE on entries fail", async () => {
    const { bal, clearing } = await ledgerPair();
    await insertTransfer(db, "immut-2", "topup", clearing, bal, 10);
    await expectPgError(db.query("UPDATE ledger_transactions SET kind = 'refund' WHERE idempotency_key = 'immut-2'"), { code: INTEGRITY, message: /immutable/ });
    await expectPgError(db.query("DELETE FROM ledger_transactions WHERE idempotency_key = 'immut-2'"), { code: INTEGRITY, message: /immutable/ });
    await expectPgError(db.query("TRUNCATE ledger_entries"), { code: INTEGRITY, message: /immutable/ });
    await expectPgError(db.query("TRUNCATE ledger_transactions CASCADE"), { code: INTEGRITY, message: /immutable/ });
  });

  it("AG-LED-02: no balance column exists in ledger_accounts, customers or businesses", async () => {
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('ledger_accounts', 'customers', 'businesses')",
    );
    expect(cols.rows.filter((r) => /balance|saldo/.test(r.column_name))).toEqual([]);
  });
  it("AG-LED-02: balance is the SUM of entries", async () => {
    const { bal, clearing } = await ledgerPair();
    await insertTransfer(db, "sum-1", "topup", clearing, bal, 300);
    await insertTransfer(db, "sum-2", "order_debit", bal, clearing, 120);
    expect(await balanceOf(bal)).toBe(180);
  });

  it("customer_balance may go negative at schema level (enforced later by the ledger service)", async () => {
    const { bal, clearing } = await ledgerPair();
    await insertTransfer(db, "neg-1", "order_debit", bal, clearing, 5);
    expect(await balanceOf(bal)).toBe(-5);
  });

  it("D64: a business_payable account may go negative", async () => {
    const b = await insertBusiness(db);
    const payable = await insertAccount(db, "business_payable", { businessId: b });
    const commission = await insertAccount(db, "platform_commission");
    await insertTransfer(db, "d64-1", "adjustment", payable, commission, 70);
    expect(await balanceOf(payable)).toBe(-70);
  });
});

describe("closed ledger transactions (M1)", () => {
  it("M1: entries cannot be appended to an already committed transaction", async () => {
    const { bal, clearing } = await ledgerPair();
    const txId = await insertTransfer(db, "closed-1", "topup", clearing, bal, 100);

    await expectPgError(
      db.transaction(async (tx) => {
        await tx.query(ENTRY_SQL, [txId, clearing, "debit", 5000]);
        await tx.query(ENTRY_SQL, [txId, bal, "credit", 5000]);
      }),
      { code: INTEGRITY, message: /closed transaction/ },
    );
    expect(await entryCount()).toBe(2);
    expect(await balanceOf(bal)).toBe(100);
  });

  it("M1: setting a session config value cannot reopen a committed transaction", async () => {
    const { bal, clearing } = await ledgerPair();
    const txId = await insertTransfer(db, "closed-2", "topup", clearing, bal, 100);

    await expectPgError(
      db.transaction(async (tx) => {
        await tx.query("SELECT set_config('ledger.open_' || replace($1::text, '-', ''), 'on', true)", [txId]);
        await tx.query(ENTRY_SQL, [txId, clearing, "debit", 5000]);
        await tx.query(ENTRY_SQL, [txId, bal, "credit", 5000]);
      }),
      { code: INTEGRITY, message: /closed transaction/ },
    );
    expect(await entryCount()).toBe(2);
    expect(await balanceOf(bal)).toBe(100);
  });

  it("M1: header and entries inserted in the same transaction still work", async () => {
    const { bal, clearing } = await ledgerPair();
    await insertTransfer(db, "same-tx-1", "topup", clearing, bal, 40);
    expect(await balanceOf(bal)).toBe(40);
  });

  it("M1: several headers in one transaction each accept their own entries", async () => {
    const { bal, clearing } = await ledgerPair();
    await db.transaction(async (tx) => {
      for (const k of ["multi-1", "multi-2"]) {
        const t = await tx.query<{ id: string }>("INSERT INTO ledger_transactions (idempotency_key, kind) VALUES ($1, 'topup') RETURNING id", [k]);
        await tx.query(ENTRY_SQL, [t.rows[0]!.id, clearing, "debit", 10]);
        await tx.query(ENTRY_SQL, [t.rows[0]!.id, bal, "credit", 10]);
      }
    });
    expect(await balanceOf(bal)).toBe(20);
  });

  it("M1: header inserted inside a SAVEPOINT accepts entries before and after RELEASE", async () => {
    const { bal, clearing } = await ledgerPair();
    await db.query("BEGIN");
    await db.query("SAVEPOINT sp1");
    const t = await openTransaction("savepoint-1", "topup");
    await db.query(ENTRY_SQL, [t, clearing, "debit", 30]);
    await db.query("RELEASE SAVEPOINT sp1");
    await db.query(ENTRY_SQL, [t, bal, "credit", 30]);
    await db.query("COMMIT");
    expect(await balanceOf(bal)).toBe(30);
  });

  it("M1: header and entries in a rolled back SAVEPOINT leave nothing and entries then fail on the foreign key", async () => {
    const { bal, clearing } = await ledgerPair();
    await db.query("BEGIN");
    await db.query("SAVEPOINT sp1");
    const t = await openTransaction("savepoint-2", "topup");
    await db.query(ENTRY_SQL, [t, clearing, "debit", 30]);
    await db.query("ROLLBACK TO SAVEPOINT sp1");
    // The header is gone, so the trigger rejects the entry as a foreign key violation.
    await expectPgError(db.query(ENTRY_SQL, [t, bal, "credit", 30]), { code: FK, constraint: "ledger_entries_transaction_id_fkey" });
    await db.query("ROLLBACK");
    expect(await entryCount()).toBe(0);
    expect((await db.query("SELECT 1 FROM ledger_transactions WHERE idempotency_key = 'savepoint-2'")).rows).toHaveLength(0);
  });
});

describe("ledger entries with a missing or invisible header (M1b)", () => {
  // The cross-session race (a header inserted but not yet committed by another session) cannot
  // be reproduced on PGlite (single connection); it is verified manually on PostgreSQL 17.
  it("the trigger rejects an entry whose header does not exist or is not visible", async () => {
    const { bal } = await ledgerPair();
    await expectPgError(db.query(ENTRY_SQL, [NIL_UUID, bal, "credit", 1]), {
      code: FK,
      constraint: "ledger_entries_transaction_id_fkey",
      message: /does not exist or is not visible to this transaction/,
    });
    expect(await entryCount()).toBe(0);
  });
});

describe("naming (AG-SEC-04)", () => {
  const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
  // Small denylist of Spanish words that must not appear as name parts.
  const SPANISH = ["saldo", "cliente", "negocio", "pedido", "producto", "precio", "estado", "fecha", "monto", "pago", "usuario", "nombre", "telefono", "comercio"];

  async function names(sql: string): Promise<string[]> {
    return (await db.query<{ name: string }>(sql)).rows.map((r) => r.name);
  }

  it("table, column, constraint, index, function and trigger names are English snake_case ASCII", async () => {
    const all = {
      tables: await names("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'"),
      columns: await names("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public'"),
      constraints: await names("SELECT conname AS name FROM pg_constraint WHERE connamespace = 'public'::regnamespace"),
      indexes: await names("SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'"),
      functions: await names("SELECT proname AS name FROM pg_proc WHERE pronamespace = 'public'::regnamespace"),
      triggers: await names("SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace"),
    };
    expect(all.tables.length).toBeGreaterThan(5);
    expect(all.columns.length).toBeGreaterThan(20);
    expect(all.constraints.length).toBeGreaterThan(20);
    expect(all.indexes.length).toBeGreaterThan(10);
    expect(all.functions.length).toBeGreaterThanOrEqual(3);
    expect(all.triggers.length).toBeGreaterThanOrEqual(7);
    for (const [kind, list] of Object.entries(all)) {
      for (const n of list) {
        expect(n, `${kind} name`).toMatch(SNAKE);
        for (const part of n.split("_")) expect(SPANISH, `${kind} name ${n}`).not.toContain(part);
      }
    }
  });
});
