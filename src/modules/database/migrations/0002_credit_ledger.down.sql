DROP TABLE ledger_entries;
DROP TABLE ledger_transactions;
DROP TABLE ledger_accounts;
DROP FUNCTION ledger_mark_transaction_open();
DROP FUNCTION ledger_reject_entry_on_closed_transaction();
DROP FUNCTION ledger_check_transaction_balanced();
DROP FUNCTION ledger_reject_mutation();
