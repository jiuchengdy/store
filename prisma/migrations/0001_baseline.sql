-- 0001_baseline: introduces the migration ledger.
--
-- The live structure already equals prisma/init.sql, so this baseline has exactly
-- one structural effect: creating schema_version. It is written with
-- IF NOT EXISTS because a fresh database gets the same table from init.sql
-- (db:init) and then runs db:migrate on top of it; without the guard the very
-- first `db:init` + `db:migrate` sequence would fail with "already exists".
--
-- No INSERT here on purpose: checksum is the hash of this file, and a file cannot
-- contain the hash of itself. The runner (scripts/migrate.ts) writes the ledger
-- row version=1 with that checksum in the same transaction as this SQL.
CREATE TABLE IF NOT EXISTS schema_version (
    version integer PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL
);
