-- Adds Cognito-customer linkage and MFA timestamp to the customers table.
-- Safe to run multiple times.
--
-- Apply via:
--   psql "$DATABASE_URL" -f prisma/sql/2026-04-25-customer-cognito.sql
-- Or rely on `prisma db push` if you prefer schema-driven sync.

ALTER TABLE license_server.customers
  ADD COLUMN IF NOT EXISTS cognito_sub      TEXT,
  ADD COLUMN IF NOT EXISTS cognito_pool     TEXT,
  ADD COLUMN IF NOT EXISTS mfa_enabled_at   TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS customers_cognito_sub_key
  ON license_server.customers (cognito_sub)
  WHERE cognito_sub IS NOT NULL;
