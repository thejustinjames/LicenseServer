/**
 * licensing_seeds/03-silo-licence-scopes.cjs
 *
 * Give every SILO SKU an explicit licence **scope**, and add the SKUs that
 * had no product: Child Cortex, and the agent seat pack.
 *
 * ## Why a scope
 *
 * A tier says how much a licence unlocks. A scope says what it is *for*, and
 * they are independent. `silo_license_client::LicenseScope` reads it, and
 * `silo_cortex::activation` refuses a Cortex that holds a licence issued for
 * something else — a child Cortex presenting a parent's key is as wrong as
 * the reverse, and accepting either makes the child licence unsellable.
 *
 * The scope travels as a feature code because a code is exact, where a product
 * name is marketing text an operator can change. Renaming "SILO Cortex
 * Enterprise" would otherwise silently re-scope every key issued under it.
 *
 * ## Idempotent
 *
 * Keyed on product `name`, like `01-test-skus.cjs`. Re-running updates the
 * scope codes in place; it never creates a second row for the same SKU.
 *
 * Run it after `01-test-skus.cjs`:
 *
 *   cat licensing_seeds/03-silo-licence-scopes.cjs | docker exec -i license-server \
 *     sh -c 'cat > /app/seed.cjs && cd /app && node ./seed.cjs && rm -f /app/seed.cjs'
 */

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

/** Scope code per existing SKU. */
const SCOPES = {
  // A standalone licences an endpoint, and licences no Cortex at all. It
  // carries `scope-agent` rather than a scope of its own: endpoint licensing
  // is not a separate scope, and what matters here is that a standalone key
  // presented to a Cortex is refused.
  'SILO Standalone Home': 'scope-agent',
  'SILO Standalone Professional': 'scope-agent',
  'SILO Cortex Business': 'scope-cortex',
  'SILO Cortex Enterprise': 'scope-cortex',
};

/** SKUs that did not exist. */
const NEW_PRODUCTS = [
  {
    name: 'SILO Child Cortex Business',
    description:
      'A subordinate Cortex federating up to a parent. Licensed separately from the parent: the parent tier permits federation, this licenses the machine.',
    category: 'silo-cortex',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: null,
    priceAnnual: 24900, // $249 / yr — half the parent SKU
    features: [
      'scope-child-cortex',
      'cortex-managed',
      'child-cortex',
      'team-dashboard',
      'mtls-agent',
      'all-modules',
      'priority-support',
    ],
    components: ['core', 'cortex', 'dashboard', 'agent'],
    platforms: ['WEB', 'WINDOWS', 'MACOS', 'LINUX'],
    defaultSeatCount: 5,
    maxSeatCount: 5,
    seatPriceMonthly: null,
    seatPriceAnnual: null,
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
    licenseDurationDays: null,
    requiresActivation: true,
    version: '1.0.0',
  },
  {
    name: 'SILO Child Cortex Enterprise',
    description:
      'A subordinate Cortex federating up to an Enterprise parent, with the enterprise modules. Licensed per child.',
    category: 'silo-cortex',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: null,
    priceAnnual: 99900, // $999 / yr
    features: [
      'scope-child-cortex',
      'cortex-managed',
      'child-cortex',
      'team-dashboard',
      'mtls-agent',
      'all-modules',
      'enterprise-plugins',
      'sso',
      'audit-logs',
      'dedicated-support',
      'sla',
    ],
    components: ['core', 'cortex', 'dashboard', 'agent', 'ml', 'dist', 'enterprise-plugins'],
    platforms: ['WEB', 'WINDOWS', 'MACOS', 'LINUX'],
    defaultSeatCount: 10,
    maxSeatCount: 10,
    seatPriceMonthly: null,
    seatPriceAnnual: null,
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
    licenseDurationDays: null,
    requiresActivation: true,
    version: '1.0.0',
  },
  {
    name: 'SILO Agent Seat Pack',
    description:
      'Additional agent seats on an existing Cortex licence. Sold in packs of 5 or 10; the pack itself is recorded against the parent licence.',
    category: 'silo-cortex',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: null,
    priceAnnual: 0,
    features: ['scope-agent', 'agent-seat', 'mtls-agent'],
    components: ['agent'],
    platforms: ['WINDOWS', 'MACOS', 'LINUX'],
    defaultSeatCount: 5,
    maxSeatCount: 10,
    seatPriceMonthly: null,
    seatPriceAnnual: 9900, // $99 / seat / yr
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
    licenseDurationDays: null,
    requiresActivation: false,
    version: '1.0.0',
  },
];

/** All the scope codes, so setting one removes any other. */
const ALL_SCOPES = ['scope-cortex', 'scope-child-cortex', 'scope-agent'];

(async () => {
  for (const [name, scope] of Object.entries(SCOPES)) {
    const existing = await p.product.findFirst({ where: { name } });
    if (!existing) {
      console.log('SKIPPED  ' + name + '  (not seeded; run 01-test-skus.cjs first)');
      continue;
    }
    // Replace rather than append: two scope codes on one product would make
    // the scope depend on which the reader happened to see first.
    const features = [scope].concat(
      (existing.features || []).filter((f) => !ALL_SCOPES.includes(f)),
    );
    await p.product.update({ where: { id: existing.id }, data: { features } });
    console.log('SCOPED   ' + existing.id + '  ' + name + '  ' + scope);
  }

  for (const def of NEW_PRODUCTS) {
    const existing = await p.product.findFirst({ where: { name: def.name } });
    if (existing) {
      const u = await p.product.update({ where: { id: existing.id }, data: def });
      console.log('UPDATED  ' + u.id + '  ' + u.name);
    } else {
      const c = await p.product.create({ data: def });
      console.log('CREATED  ' + c.id + '  ' + c.name);
    }
  }

  await p.$disconnect();
})().catch((e) => {
  console.error('seed failed', e);
  process.exit(1);
});
