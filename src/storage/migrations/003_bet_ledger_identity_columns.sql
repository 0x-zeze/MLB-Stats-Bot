-- Identity columns on bet_ledger are ensured idempotently by Storage.initializeSchema
-- (PRAGMA table_info + ALTER). This migration records the schema epoch only.
SELECT 1;
