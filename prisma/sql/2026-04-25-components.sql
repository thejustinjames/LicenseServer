-- Adds per-product `components` and per-license `enabled_components`
-- columns. Idempotent.
--
-- Apply via the same one-shot psql Job pattern as
-- 2026-04-25-customer-cognito.sql, or `prisma db push` if preferred.

ALTER TABLE license_server.products
  ADD COLUMN IF NOT EXISTS components TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE license_server.licenses
  ADD COLUMN IF NOT EXISTS enabled_components TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
