/**
 * licensing_seeds/02-test-licenses.cjs
 *
 * Issue one sample license per test SKU, keyed by tier-specific QA
 * customers. Idempotent: keyed by (customerEmail, productName) — re-running
 * updates the maxActivations/seatCount/metadata on the existing license
 * rather than creating duplicates.
 *
 * Activation + seat policy (matches the test SKUs in 01-test-skus.cjs):
 *
 *   ┌────────────────────────────────┬───────────────┬────────┬───────────────────────────────────┐
 *   │ SKU                            │ maxActivations│ seats  │ feature-gates                     │
 *   ├────────────────────────────────┼───────────────┼────────┼───────────────────────────────────┤
 *   │ SILO Standalone Home           │ 1             │ 1      │ standalone, single-machine        │
 *   │ SILO Standalone Professional   │ 1             │ 1      │ standalone, all-modules           │
 *   │ SILO Cortex Business           │ 2             │ 5      │ cortex-managed, mtls-agent        │
 *   │ SILO Cortex Enterprise         │ 2             │ 10     │ cortex-managed, enterprise-plugins│
 *   └────────────────────────────────┴───────────────┴────────┴───────────────────────────────────┘
 *
 * `maxActivations` caps the number of distinct devices that can activate the
 * key (enforced in license.service.activate). `seatCount` caps the number of
 * named seats that can be assigned under the licence (enforced in
 * seat.service). For the cortex tiers, both gates apply: 2 device installs
 * AND 5/10 named users.
 *
 * Run inside a running pod (recommended for preprod):
 *
 *   KCTL=/c/Users/justin/bin/kubectl.exe
 *   POD=$($KCTL get pods -n preprod -l app=license-server \
 *     --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
 *   cat licensing_seeds/02-test-licenses.cjs | $KCTL exec -n preprod -i $POD -- \
 *     sh -c 'cat > /app/seed.cjs && cd /app && node ./seed.cjs && rm -f /app/seed.cjs'
 */

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const p = new PrismaClient();

// Test customers, one per tier — keeps the QA fixtures cleanly separable.
const customers = {
  home:       { email: 'qa-home@licenseserver.test',       name: 'QA Tester (Home)' },
  pro:        { email: 'qa-pro@licenseserver.test',        name: 'QA Tester (Professional)' },
  business:   { email: 'qa-business@licenseserver.test',   name: 'QA Tester (Business)' },
  enterprise: { email: 'qa-enterprise@licenseserver.test', name: 'QA Tester (Enterprise)' },
};

// License spec, indexed by product name.
const spec = {
  'SILO Standalone Home':         { customer: 'home',       maxActivations: 1, seatCount: 1  },
  'SILO Standalone Professional': { customer: 'pro',        maxActivations: 1, seatCount: 1  },
  'SILO Cortex Business':         { customer: 'business',   maxActivations: 2, seatCount: 5  },
  'SILO Cortex Enterprise':       { customer: 'enterprise', maxActivations: 2, seatCount: 10 },
};

// Match the real key format from src/utils/license-key.ts: four 4-char
// segments, last segment ends in a 2-char SHA-256 checksum so
// validateLicenseKeyFormat() accepts it.
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
  const last = genSegment().slice(0, 2) + checksumOf(segments);
  segments.push(last);
  return segments.join('-');
}

async function ensureCustomer(def) {
  const found = await p.customer.findUnique({ where: { email: def.email } });
  if (found) return found;
  // Cognito-managed customers carry an unmatchable bcrypt hash so the
  // legacy /api/portal/auth/login path can never authenticate them.
  const sentinel = 'cognito:' + crypto.randomBytes(32).toString('hex');
  return p.customer.create({
    data: {
      email: def.email,
      passwordHash: await bcrypt.hash(sentinel, 4),
      name: def.name,
      isAdmin: false,
    },
  });
}

(async () => {
  // Verify all 4 products exist before doing anything destructive.
  const productNames = Object.keys(spec);
  const products = await p.product.findMany({
    where: { name: { in: productNames } },
    select: { id: true, name: true, defaultSeatCount: true, features: true, components: true },
  });
  const missing = productNames.filter(
    (n) => !products.find((x) => x.name === n),
  );
  if (missing.length) {
    console.error(
      'Missing products in DB. Run licensing_seeds/01-test-skus.cjs first.\n  Missing: ' +
        missing.join(', '),
    );
    process.exit(1);
  }

  const issuedAt = new Date().toISOString();

  for (const productName of productNames) {
    const product = products.find((x) => x.name === productName);
    const s = spec[productName];
    const cust = await ensureCustomer(customers[s.customer]);

    const meta = {
      test: true,
      issuedBy: 'licensing_seeds/02-test-licenses.cjs',
      issuedAt,
      tier: productName,
      enforces: {
        activations: s.maxActivations,
        seats: s.seatCount,
        enterpriseModules: product.features.includes('enterprise-plugins'),
        components: product.components || [],
      },
    };

    // Look for an existing test licence for this (customer, product). If
    // one already exists, update it; otherwise create with a fresh key.
    const existing = await p.license.findFirst({
      where: { customerId: cust.id, productId: product.id },
    });

    if (existing) {
      const updated = await p.license.update({
        where: { id: existing.id },
        data: {
          maxActivations: s.maxActivations,
          seatCount: s.seatCount,
          metadata: meta,
          status: 'ACTIVE',
        },
      });
      console.log(
        'UPDATED  ' + productName +
        '\n         key:           ' + updated.key +
        '\n         customer:      ' + cust.email +
        '\n         maxActivations:' + updated.maxActivations +
        '\n         seatCount:     ' + updated.seatCount +
        '\n         enterprise:    ' + (meta.enforces.enterpriseModules ? 'YES' : 'no') +
        '\n         components:    [' + (product.components || []).join(', ') + ']\n',
      );
    } else {
      const key = generateLicenseKey();
      const created = await p.license.create({
        data: {
          key,
          customerId: cust.id,
          productId: product.id,
          maxActivations: s.maxActivations,
          seatCount: s.seatCount,
          metadata: meta,
        },
      });
      console.log(
        'CREATED  ' + productName +
        '\n         key:           ' + created.key +
        '\n         customer:      ' + cust.email +
        '\n         maxActivations:' + created.maxActivations +
        '\n         seatCount:     ' + created.seatCount +
        '\n         enterprise:    ' + (meta.enforces.enterpriseModules ? 'YES' : 'no') +
        '\n         components:    [' + (product.components || []).join(', ') + ']\n',
      );
    }
  }

  await p.$disconnect();
})().catch((e) => {
  console.error('seed failed', e);
  process.exit(1);
});
