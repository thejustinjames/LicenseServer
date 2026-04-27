-- Enterprise seat-pack purchases (Phase 1 of enterprise-enrollment plan).
--
-- Adds the `license_seat_packs` table — each row is a single pack of 5 or 10
-- agent seats granted to a License. License.seat_count is the running sum
-- of unexpired, non-revoked pack sizes; the entitlement service keeps it in
-- sync.
--
-- The Prisma schema introduces the table; this migration adds the CHECK
-- constraint that Prisma's schema language doesn't natively express, plus
-- a covering index used by the v_license_seat_total view.

CREATE TABLE IF NOT EXISTS license_seat_packs (
    id                  TEXT PRIMARY KEY,
    license_id          TEXT NOT NULL,
    pack_size           INT NOT NULL,
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by          TEXT,
    purchase_order_ref  TEXT,
    expires_at          TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    revoked_reason      TEXT,
    notes               TEXT,

    CONSTRAINT license_seat_packs_pack_size_check
        CHECK (pack_size IN (5, 10)),

    CONSTRAINT license_seat_packs_license_id_fkey
        FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS license_seat_packs_license_id_idx
    ON license_seat_packs(license_id);
CREATE INDEX IF NOT EXISTS license_seat_packs_revoked_at_idx
    ON license_seat_packs(revoked_at);
CREATE INDEX IF NOT EXISTS license_seat_packs_expires_at_idx
    ON license_seat_packs(expires_at);

-- View used by the entitlement service to compute current pack composition.
-- Cortex's daily refresh reads the same shape via the entitlement JWT.
CREATE OR REPLACE VIEW v_license_seat_total AS
SELECT
    l.id AS license_id,
    l.customer_id,
    l.license_type,
    l.status,
    COALESCE(SUM(p.pack_size) FILTER (
        WHERE p.revoked_at IS NULL
          AND (p.expires_at IS NULL OR p.expires_at > NOW())
    ), 0) AS active_seat_quota,
    COUNT(p.*) FILTER (
        WHERE p.pack_size = 5
          AND p.revoked_at IS NULL
          AND (p.expires_at IS NULL OR p.expires_at > NOW())
    ) AS packs_of_5,
    COUNT(p.*) FILTER (
        WHERE p.pack_size = 10
          AND p.revoked_at IS NULL
          AND (p.expires_at IS NULL OR p.expires_at > NOW())
    ) AS packs_of_10,
    COUNT(p.*) AS packs_total_ever
FROM licenses l
LEFT JOIN license_seat_packs p ON p.license_id = l.id
GROUP BY l.id, l.customer_id, l.license_type, l.status;

COMMENT ON TABLE license_seat_packs IS
  'One row per seat pack purchased for a License. Pack size is 5 or 10. License.seat_count = SUM(pack_size) of active rows.';
COMMENT ON CONSTRAINT license_seat_packs_pack_size_check ON license_seat_packs IS
  'Enterprise seats are sold in fixed packs only — pricing/SKU discipline. New sizes require a migration.';
