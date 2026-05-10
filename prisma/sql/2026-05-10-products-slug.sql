-- Migration: Add slug + allow_auto_register to products
-- Purpose: Align products table with schema.prisma. The slug column is what
-- /api/deployments/validate auto-register and /api/deployments/register
-- consult to resolve a logical product identifier (e.g. "agencio-predict")
-- to a CUID. allow_auto_register gates automatic registration of dev/staging
-- deployments hitting /validate.
-- Dependencies: products table

BEGIN;

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "allow_auto_register" BOOLEAN NOT NULL DEFAULT false;

-- Matches the index Prisma generates for `String? @unique` (Postgres allows
-- multiple NULLs in a regular UNIQUE index, so a partial isn't required).
CREATE UNIQUE INDEX IF NOT EXISTS "products_slug_key" ON "products"("slug");

COMMIT;
