/**
 * licensing_seeds/05-lab-tenant-entitlement.cjs
 *
 * Give the SILO lab's Cortex tenant a real licence to refresh its seat
 * entitlement against.
 *
 * ## Why
 *
 * A Cortex keeps one `tenant_entitlement` row per tenant and refreshes it from
 * `GET /api/v1/tenants/:licenseKey/entitlement`. The token that route returns
 * carries `tenant.id = license.id`, and Cortex refuses a token whose tenant id
 * is not the row's own. The lab's tenant row was seeded by hand on 26 October
 * 2026 with a placeholder key and an id no licence here has, so no refresh
 * could ever succeed: this server answers 404 for the key, which Cortex
 * records as a refusal.
 *
 * This creates a licence whose **id is the lab tenant's id**, under the agent
 * seat pack SKU, with one pack of ten. It is the only seed that sets a
 * licence id, and it does so because the tenant id already exists on the
 * other side (enrolled agents and join tokens hang off it).
 *
 * ## Idempotent
 *
 * Keyed on the licence id. Re-running leaves an existing licence and its key
 * alone, and adds a pack only when the licence has no pack in force.
 *
 * The key is never printed, only its last four characters. Copy it into the
 * Cortex row from the database, not from a terminal.
 *
 * Run it after `01` to `03`:
 *
 *   cat licensing_seeds/05-lab-tenant-entitlement.cjs | docker exec -i license-server \
 *     sh -c 'cat > /app/seed.cjs && cd /app && node ./seed.cjs && rm -f /app/seed.cjs'
 *
 * Lab only. A customer's tenant id is its licence's id from the start.
 */

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const p = new PrismaClient();

const LAB_TENANT_ID = process.env.LAB_TENANT_ID || 'ec597e03-b479-4b6a-9944-0eba6695d7a8';
const PRODUCT = 'SILO Agent Seat Pack';
const CUSTOMER = { email: 'lab-tenant@licenseserver.test', name: 'SILO lab tenant' };
const PACK_SIZE = 10;

// The key format from src/utils/license-key.ts, as in 02-test-licenses.cjs.
const KEY_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genSegment() {
  const bytes = crypto.randomBytes(4);
  let s = '';
  for (let i = 0; i < 4; i++) s += KEY_CHARSET[bytes[i] % KEY_CHARSET.length];
  return s;
}
function checksumOf(segments) {
  const hash = crypto.createHash('sha256').update(segments.join('')).digest();
  return KEY_CHARSET[hash[0] % KEY_CHARSET.length] + KEY_CHARSET[hash[1] % KEY_CHARSET.length];
}
function generateLicenseKey() {
  const segments = [genSegment(), genSegment(), genSegment()];
  segments.push(genSegment().slice(0, 2) + checksumOf(segments));
  return segments.join('-');
}

(async () => {
  const product = await p.product.findFirst({ where: { name: PRODUCT } });
  if (!product) {
    console.error(`Missing product "${PRODUCT}". Run 03-silo-licence-scopes.cjs first.`);
    process.exit(1);
  }

  let customer = await p.customer.findUnique({ where: { email: CUSTOMER.email } });
  if (!customer) {
    const sentinel = 'cognito:' + crypto.randomBytes(32).toString('hex');
    customer = await p.customer.create({
      data: {
        email: CUSTOMER.email,
        passwordHash: await bcrypt.hash(sentinel, 4),
        name: CUSTOMER.name,
        isAdmin: false,
      },
    });
  }

  let license = await p.license.findUnique({ where: { id: LAB_TENANT_ID } });
  let created = false;
  if (!license) {
    license = await p.license.create({
      data: {
        id: LAB_TENANT_ID,
        key: generateLicenseKey(),
        customerId: customer.id,
        productId: product.id,
        status: 'ACTIVE',
        maxActivations: 1,
        seatCount: PACK_SIZE,
        metadata: { seeded: '05-lab-tenant-entitlement', purpose: 'SILO lab Cortex tenant' },
      },
    });
    created = true;
  }

  const now = new Date();
  const packs = await p.licenseSeatPack.findMany({ where: { licenseId: license.id } });
  const inForce = packs.filter((s) => !s.revokedAt && (!s.expiresAt || s.expiresAt > now));
  let granted = false;
  if (inForce.length === 0) {
    await p.licenseSeatPack.create({
      data: {
        licenseId: license.id,
        packSize: PACK_SIZE,
        grantedBy: 'licensing_seeds/05',
        notes: 'SILO lab tenant: one pack of ten',
      },
    });
    granted = true;
  }

  console.log(
    JSON.stringify(
      {
        licence_id: license.id,
        key_last4: license.key.slice(-4),
        status: license.status,
        licence: created ? 'created' : 'already present',
        pack: granted ? `granted ${PACK_SIZE}` : `already in force (${inForce.length})`,
      },
      null,
      2,
    ),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => p.$disconnect());
