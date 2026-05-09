-- Migration: Add Deployment Guard tables
-- Purpose: Enable deployment validation, heartbeat tracking, and remote kill capability
-- Dependencies: products, customers, licenses tables must exist

BEGIN;

-- Deployment status enum
DO $$ BEGIN
  CREATE TYPE "DeploymentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED', 'KILL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Deployment command type enum
DO $$ BEGIN
  CREATE TYPE "DeploymentCommandType" AS ENUM ('RESTART', 'UPDATE', 'KILL', 'CONFIG_UPDATE', 'CLEAR_CACHE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Deployment command status enum
DO $$ BEGIN
  CREATE TYPE "DeploymentCommandStatus" AS ENUM ('PENDING', 'DELIVERED', 'EXECUTED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Deployments table
CREATE TABLE IF NOT EXISTS "deployments" (
  "id" TEXT PRIMARY KEY,
  "product_id" TEXT REFERENCES "products"("id"),
  "customer_id" TEXT REFERENCES "customers"("id"),
  "license_id" TEXT REFERENCES "licenses"("id"),
  "environment" TEXT NOT NULL DEFAULT 'production',
  "machine_hash" TEXT,
  "version" TEXT,
  "status" "DeploymentStatus" NOT NULL DEFAULT 'ACTIVE',
  "secret" TEXT,
  "kill_reason" TEXT,
  "kill_message" TEXT,
  "killed_at" TIMESTAMP(3),
  "last_seen_at" TIMESTAMP(3),
  "metrics" JSONB,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for deployments
CREATE INDEX IF NOT EXISTS "deployments_product_id_idx" ON "deployments"("product_id");
CREATE INDEX IF NOT EXISTS "deployments_customer_id_idx" ON "deployments"("customer_id");
CREATE INDEX IF NOT EXISTS "deployments_status_idx" ON "deployments"("status");
CREATE INDEX IF NOT EXISTS "deployments_last_seen_at_idx" ON "deployments"("last_seen_at");

-- Deployment commands table
CREATE TABLE IF NOT EXISTS "deployment_commands" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "deployment_id" TEXT NOT NULL REFERENCES "deployments"("id") ON DELETE CASCADE,
  "type" "DeploymentCommandType" NOT NULL,
  "status" "DeploymentCommandStatus" NOT NULL DEFAULT 'PENDING',
  "payload" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered_at" TIMESTAMP(3),
  "executed_at" TIMESTAMP(3),
  "error" TEXT
);

-- Indexes for deployment commands
CREATE INDEX IF NOT EXISTS "deployment_commands_deployment_id_idx" ON "deployment_commands"("deployment_id");
CREATE INDEX IF NOT EXISTS "deployment_commands_status_idx" ON "deployment_commands"("status");

COMMIT;
