-- Migration: Link licenses to the Stripe subscription that issued them
-- Purpose: Subscription webhooks (deleted / payment_failed / updated) used to
-- expire, suspend or reactivate *every* license a customer owned, including
-- perpetual one-time purchases and licenses for unrelated products. Recording
-- the issuing subscription on the license lets those handlers scope their
-- effect to the licenses the subscription actually paid for.
-- Dependencies: licenses, subscriptions

BEGIN;

ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "subscription_id" TEXT;

CREATE INDEX IF NOT EXISTS "licenses_subscription_id_idx" ON "licenses"("subscription_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'licenses_subscription_id_fkey'
  ) THEN
    ALTER TABLE "licenses"
      ADD CONSTRAINT "licenses_subscription_id_fkey"
      FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
