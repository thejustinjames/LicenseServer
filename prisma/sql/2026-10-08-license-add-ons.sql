-- Licence add-ons (the SILO causal trust add-on).
--
-- The Prisma schema introduces `license_add_ons`; this adds what Prisma's
-- schema language cannot express: the closed list of add-on codes, and at
-- most one active grant of a code per licence.

CREATE TABLE IF NOT EXISTS license_add_ons (
    id                  TEXT PRIMARY KEY,
    license_id          TEXT NOT NULL,
    code                TEXT NOT NULL,
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by          TEXT,
    purchase_order_ref  TEXT,
    expires_at          TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    revoked_reason      TEXT,
    notes               TEXT,

    CONSTRAINT license_add_ons_license_id_fkey
        FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
);

ALTER TABLE license_add_ons DROP CONSTRAINT IF EXISTS license_add_ons_code_check;
ALTER TABLE license_add_ons
    ADD CONSTRAINT license_add_ons_code_check CHECK (code IN ('causal_trust'));

CREATE INDEX IF NOT EXISTS license_add_ons_license_id_idx ON license_add_ons(license_id);
CREATE INDEX IF NOT EXISTS license_add_ons_revoked_at_idx ON license_add_ons(revoked_at);

-- One active grant of a code per licence; revoked rows stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS license_add_ons_one_active
    ON license_add_ons(license_id, code) WHERE revoked_at IS NULL;
