CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_type text NOT NULL,
  customer_id uuid REFERENCES customers (id),
  business_id uuid REFERENCES businesses (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_type_check CHECK (account_type IN (
    'customer_balance', 'business_payable', 'platform_commission',
    'topup_clearing', 'payout_clearing'
  )),
  CONSTRAINT ledger_accounts_owner_check CHECK (
    (account_type = 'customer_balance' AND customer_id IS NOT NULL AND business_id IS NULL)
    OR (account_type = 'business_payable' AND business_id IS NOT NULL AND customer_id IS NULL)
    OR (account_type IN ('platform_commission', 'topup_clearing', 'payout_clearing')
        AND customer_id IS NULL AND business_id IS NULL)
  )
);
CREATE UNIQUE INDEX ledger_accounts_customer_balance_key
  ON ledger_accounts (customer_id) WHERE account_type = 'customer_balance';
CREATE UNIQUE INDEX ledger_accounts_business_payable_key
  ON ledger_accounts (business_id) WHERE account_type = 'business_payable';
CREATE UNIQUE INDEX ledger_accounts_platform_key
  ON ledger_accounts (account_type)
  WHERE account_type IN ('platform_commission', 'topup_clearing', 'payout_clearing');

CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_transactions_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT ledger_transactions_kind_check CHECK (kind IN (
    'topup', 'order_debit', 'refund', 'commission', 'payout', 'adjustment'
  ))
);

CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions (id),
  account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  order_id uuid REFERENCES orders (id),
  direction text NOT NULL,
  amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_direction_check CHECK (direction IN ('debit', 'credit')),
  CONSTRAINT ledger_entries_amount_minor_check CHECK (amount_minor > 0)
);
CREATE INDEX ledger_entries_transaction_id_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_id_idx ON ledger_entries (account_id);
CREATE INDEX ledger_entries_order_id_idx ON ledger_entries (order_id);

CREATE FUNCTION ledger_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are immutable (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
CREATE TRIGGER ledger_transactions_no_truncate
  BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();

CREATE FUNCTION ledger_check_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tx_id uuid;
  debits numeric;
  credits numeric;
  entry_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    tx_id := NEW.transaction_id;
  ELSE
    tx_id := NEW.id;
  END IF;
  SELECT
    COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'debit'), 0),
    COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'credit'), 0),
    COUNT(*)
  INTO debits, credits, entry_count
  FROM ledger_entries WHERE transaction_id = tx_id;
  IF entry_count = 0 OR debits <> credits THEN
    RAISE EXCEPTION 'ledger transaction % is not balanced (debits %, credits %, entries %)',
      tx_id, debits, credits, entry_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction_balanced();
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_transaction_balanced();

-- Entries may only be added in the same database transaction that created their header.
-- Mechanism: the BEFORE INSERT trigger on ledger_entries reads the visible header row's
-- xmin (32-bit xid of the transaction, or of a subtransaction, that inserted it) and
-- allows the insert only if that transaction is still in progress.
--   * A header row visible to this session that was written by an in-progress transaction
--     can only belong to the current transaction (other in-progress transactions' rows
--     are invisible). pg_xact_status() checks the current transaction and all of its
--     subtransactions (savepoints, released or not) first, so it reports 'in progress'
--     for them. Committed, aborted, frozen or unknown (NULL) status means "closed".
--   * xmin is 32 bits; pg_xact_status() needs a 64-bit xid8. The epoch comes from
--     pg_current_xact_id(): the header xid is the current top-level xid plus the signed
--     32-bit circular distance between the two xmin values (the same rule PostgreSQL uses
--     to extend xids). Rows older than 2^31 xids are frozen, so the distance is
--     unambiguous; a negative distance crosses into the previous epoch, and a positive
--     one is a subtransaction id of this transaction (savepoints get larger ids). The
--     header row is visible, so its xid already exists and pg_xact_status() is never
--     called with a future xid (it would error); a negative result is treated as closed.
--   * No session state is involved, so it cannot be bypassed from SQL without privileges
--     (disabling triggers or editing the table needs ownership). Requires PostgreSQL 13+.
-- If no header row is visible, the check is skipped and the foreign key raises 23503.
-- Violations raise SQLSTATE 23000 (integrity_constraint_violation) with a message
-- containing "closed transaction".
CREATE FUNCTION ledger_reject_entry_on_closed_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  header_xmin bigint;
  current_xid bigint;
  distance bigint;
  candidate bigint;
  header_status text;
BEGIN
  SELECT xmin::text::bigint INTO header_xmin
  FROM ledger_transactions WHERE id = NEW.transaction_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  current_xid := pg_current_xact_id()::text::bigint;
  distance := (header_xmin - (current_xid & 4294967295)) & 4294967295;
  IF distance >= 2147483648 THEN
    distance := distance - 4294967296;
  END IF;
  candidate := current_xid + distance;

  IF candidate >= 0 THEN
    header_status := pg_xact_status(candidate::text::xid8);
  END IF;

  IF header_status IS DISTINCT FROM 'in progress' THEN
    RAISE EXCEPTION 'cannot add entries to closed transaction %', NEW.transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entries_same_transaction_only
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_entry_on_closed_transaction();
