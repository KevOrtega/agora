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
-- Mechanism: an AFTER INSERT trigger on ledger_transactions sets a transaction-local
-- marker (set_config(..., true)) named after the header id; the BEFORE INSERT trigger on
-- ledger_entries requires that marker. Trade-off versus comparing the header's xmin with
-- the current transaction id: the marker is correct inside SAVEPOINTs (xmin would then
-- be a subtransaction id), it is rolled back with a rolled-back savepoint, and it is
-- cleared at COMMIT/ROLLBACK. Its weakness is that a session could set the marker by
-- hand; that needs deliberate effort and is the same trust level as disabling triggers.
-- Violations raise SQLSTATE 23000 (integrity_constraint_violation) with a message
-- containing "closed transaction".
CREATE FUNCTION ledger_mark_transaction_open() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('ledger.open_' || replace(NEW.id::text, '-', ''), 'on', true);
  RETURN NULL;
END;
$$;

CREATE FUNCTION ledger_reject_entry_on_closed_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('ledger.open_' || replace(NEW.transaction_id::text, '-', ''), true), '') <> 'on' THEN
    RAISE EXCEPTION 'cannot add entries to closed transaction %', NEW.transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_transactions_mark_open
  AFTER INSERT ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_mark_transaction_open();
CREATE TRIGGER ledger_entries_same_transaction_only
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_entry_on_closed_transaction();
