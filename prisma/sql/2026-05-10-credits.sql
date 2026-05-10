-- Migration: Credit-system schema (CreditBalance, CreditTransaction,
-- CreditPackage, AiModelPricing, CreditSettings + supporting enums and FKs).
-- Purpose: Align preprod DB with the credit models referenced by
-- src/services/credit.service.ts and src/routes/portal.ts. These models have
-- existed in schema.prisma for some time but no SQL was ever applied, so any
-- credit endpoint currently throws "table does not exist".
-- Source: derived from `npx prisma migrate diff --from-url $DATABASE_URL
--   --to-schema-datamodel prisma/schema.prisma --script` taken on 2026-05-10.
-- Dependencies: customers, products tables.

BEGIN;

-- =============================================================================
-- Enums
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE "CreditTransactionType" AS ENUM (
    'PURCHASE', 'USAGE', 'REFUND', 'ADJUSTMENT', 'AUTO_REFILL',
    'TRANSFER', 'RESERVATION', 'RELEASE', 'CONSUMPTION', 'BONUS'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CreditTransactionStatus" AS ENUM (
    'PENDING', 'COMPLETED', 'FAILED', 'REVERSED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- credit_packages (referenced by credit_balances + credit_transactions, so
-- must be created before either)
-- =============================================================================

CREATE TABLE IF NOT EXISTS "credit_packages" (
  "id"                  TEXT PRIMARY KEY,
  "name"                TEXT NOT NULL,
  "description"         TEXT,
  "price_cents"         INTEGER NOT NULL,
  "credit_cents"        INTEGER NOT NULL,
  "credit_amount_cents" INTEGER NOT NULL DEFAULT 0,
  "bonus_cents"         INTEGER NOT NULL DEFAULT 0,
  "currency"            TEXT NOT NULL DEFAULT 'usd',
  "stripe_product_id"   TEXT,
  "stripe_price_id"     TEXT,
  "is_popular"          BOOLEAN NOT NULL DEFAULT false,
  "sort_order"          INTEGER NOT NULL DEFAULT 0,
  "is_active"           BOOLEAN NOT NULL DEFAULT true,
  "badge"               TEXT,
  "valid_until"         TIMESTAMP(3),
  "created_by"          TEXT NOT NULL,
  "updated_by"          TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "credit_packages_stripe_product_id_key"
  ON "credit_packages"("stripe_product_id");
CREATE UNIQUE INDEX IF NOT EXISTS "credit_packages_stripe_price_id_key"
  ON "credit_packages"("stripe_price_id");

-- =============================================================================
-- credit_balances
-- =============================================================================

CREATE TABLE IF NOT EXISTS "credit_balances" (
  "id"                              TEXT PRIMARY KEY,
  "customer_id"                     TEXT NOT NULL,
  "predict_user_id"                 TEXT,
  "predict_org_id"                  TEXT,
  "available_cents"                 BIGINT NOT NULL DEFAULT 0,
  "reserved_cents"                  BIGINT NOT NULL DEFAULT 0,
  "lifetime_purchased_cents"        BIGINT NOT NULL DEFAULT 0,
  "lifetime_used_cents"             BIGINT NOT NULL DEFAULT 0,
  "total_refunded"                  BIGINT NOT NULL DEFAULT 0,
  "total_purchased"                 BIGINT NOT NULL DEFAULT 0,
  "total_consumed"                  BIGINT NOT NULL DEFAULT 0,
  "total_bonus"                     BIGINT NOT NULL DEFAULT 0,
  "auto_refill_enabled"             BOOLEAN NOT NULL DEFAULT false,
  "auto_refill_package_id"          TEXT,
  "auto_refill_threshold_cents"     INTEGER,
  "auto_refill_max_count"           INTEGER NOT NULL DEFAULT 3,
  "auto_refill_current_count"       INTEGER NOT NULL DEFAULT 0,
  "auto_refill_reset_at"            TIMESTAMP(3),
  "auto_refill_payment_method_id"   TEXT,
  "auto_refill_amount_cents"        INTEGER,
  "auto_refill_trigger_cents"       INTEGER,
  "auto_refill_last_auth_at"        TIMESTAMP(3),
  "low_balance_alert_cents"         INTEGER,
  "last_low_balance_alert_at"       TIMESTAMP(3),
  "created_at"                      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "credit_balances_customer_id_key"
  ON "credit_balances"("customer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "credit_balances_predict_user_id_key"
  ON "credit_balances"("predict_user_id");
CREATE INDEX IF NOT EXISTS "credit_balances_predict_user_id_idx"
  ON "credit_balances"("predict_user_id");
CREATE INDEX IF NOT EXISTS "credit_balances_predict_org_id_idx"
  ON "credit_balances"("predict_org_id");

-- =============================================================================
-- credit_transactions
-- =============================================================================

CREATE TABLE IF NOT EXISTS "credit_transactions" (
  "id"                       TEXT PRIMARY KEY,
  "credit_balance_id"        TEXT NOT NULL,
  "type"                     "CreditTransactionType" NOT NULL,
  "status"                   "CreditTransactionStatus" NOT NULL DEFAULT 'COMPLETED',
  "amount_cents"             INTEGER NOT NULL,
  "balance_before"           BIGINT NOT NULL,
  "balance_after"            BIGINT NOT NULL,
  "stripe_payment_intent_id" TEXT,
  "stripe_charge_id"         TEXT,
  "package_id"               TEXT,
  "predict_call_id"          TEXT,
  "idempotency_key"          TEXT,
  "external_call_id"         TEXT,
  "model"                    TEXT,
  "prompt_tokens"            INTEGER,
  "completion_tokens"        INTEGER,
  "endpoint"                 TEXT,
  "refill_number"            INTEGER,
  "description"              TEXT,
  "metadata"                 JSONB,
  "created_by"               TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "credit_transactions_idempotency_key_key"
  ON "credit_transactions"("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "credit_transactions_predict_call_id_key"
  ON "credit_transactions"("predict_call_id");
CREATE INDEX IF NOT EXISTS "credit_transactions_credit_balance_id_idx"
  ON "credit_transactions"("credit_balance_id");
CREATE INDEX IF NOT EXISTS "credit_transactions_type_idx"
  ON "credit_transactions"("type");
CREATE INDEX IF NOT EXISTS "credit_transactions_created_at_idx"
  ON "credit_transactions"("created_at");
CREATE INDEX IF NOT EXISTS "credit_transactions_stripe_payment_intent_id_idx"
  ON "credit_transactions"("stripe_payment_intent_id");

-- =============================================================================
-- ai_model_pricing
-- =============================================================================

CREATE TABLE IF NOT EXISTS "ai_model_pricing" (
  "id"                       TEXT PRIMARY KEY,
  "model"                    TEXT NOT NULL,
  "provider"                 TEXT NOT NULL,
  "input_cost_per_1m_cents"  INTEGER NOT NULL,
  "output_cost_per_1m_cents" INTEGER NOT NULL,
  "markup_percent"           DECIMAL(5,2) NOT NULL DEFAULT 0,
  "display_name"             TEXT,
  "is_active"                BOOLEAN NOT NULL DEFAULT true,
  "created_by"               TEXT NOT NULL,
  "updated_by"               TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_model_pricing_model_key"
  ON "ai_model_pricing"("model");

-- =============================================================================
-- credit_settings (singleton row)
-- =============================================================================

CREATE TABLE IF NOT EXISTS "credit_settings" (
  "id"                              TEXT PRIMARY KEY DEFAULT 'singleton',
  "min_purchase_cents"              INTEGER NOT NULL DEFAULT 500,
  "max_auto_refill_count"           INTEGER NOT NULL DEFAULT 5,
  "default_daily_limit_cents"       INTEGER NOT NULL DEFAULT 1000,
  "default_low_balance_alert_cents" INTEGER NOT NULL DEFAULT 200,
  "zero_balance_grace_minutes"      INTEGER NOT NULL DEFAULT 60,
  "updated_by"                      TEXT,
  "updated_at"                      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Foreign keys (wrapped in DO blocks so re-running is a no-op)
-- =============================================================================

DO $$ BEGIN
  ALTER TABLE "credit_balances"
    ADD CONSTRAINT "credit_balances_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "credit_balances"
    ADD CONSTRAINT "credit_balances_auto_refill_package_id_fkey"
    FOREIGN KEY ("auto_refill_package_id") REFERENCES "credit_packages"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "credit_transactions"
    ADD CONSTRAINT "credit_transactions_credit_balance_id_fkey"
    FOREIGN KEY ("credit_balance_id") REFERENCES "credit_balances"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "credit_transactions"
    ADD CONSTRAINT "credit_transactions_package_id_fkey"
    FOREIGN KEY ("package_id") REFERENCES "credit_packages"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
