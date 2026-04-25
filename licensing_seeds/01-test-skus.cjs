/**
 * licensing_seeds/01-test-skus.cjs
 *
 * Seed the four test SKUs for the License Server.
 *
 * Idempotent: keyed by product `name`, so re-running this updates the
 * existing rows (pricing / features / platforms) rather than creating
 * duplicates. Safe to run multiple times.
 *
 * Run inside a running pod (recommended for preprod):
 *
 *   KCTL=/c/Users/justin/bin/kubectl.exe
 *   POD=$($KCTL get pods -n preprod -l app=license-server \
 *     --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
 *   cat licensing_seeds/01-test-skus.cjs | $KCTL exec -n preprod -i $POD -- \
 *     sh -c 'cat > /app/seed.cjs && cd /app && node ./seed.cjs && rm -f /app/seed.cjs'
 *
 * Or run locally against a Postgres with a populated DATABASE_URL:
 *
 *   DATABASE_URL='postgresql://...?schema=license_server' \
 *     node licensing_seeds/01-test-skus.cjs
 *
 * SKUs (prices in USD cents):
 *   - SILO Standalone Home          $29.99 / yr   1 seat   Windows + macOS
 *   - SILO Standalone Professional  $49.99 / yr   1 seat   Windows + macOS
 *   - SILO Cortex Business          $499   / yr   5 seats  Web + desktop
 *   - SILO Cortex Enterprise        $1999  / yr  10 seats  Web + desktop + enterprise plugins
 */

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const products = [
  {
    name: 'SILO Standalone Home',
    description:
      'Standalone SILO for personal use on Windows or macOS. No Cortex required — fully offline-capable with hybrid online check-in.',
    category: 'silo-standalone',
    validationMode: 'HYBRID',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: null,
    priceAnnual: 2999, // $29.99 / yr
    features: ['standalone', 'single-machine', 'offline-mode', 'community-support'],
    platforms: ['WINDOWS', 'MACOS'],
    defaultSeatCount: 1,
    maxSeatCount: 1,
    seatPriceMonthly: null,
    seatPriceAnnual: null,
    offlineGraceDays: 14,
    checkInIntervalDays: 7,
    licenseDurationDays: null,
    requiresActivation: true,
    version: '1.0.0',
  },
  {
    name: 'SILO Standalone Professional',
    description:
      'Standalone SILO with the full feature set on Windows or macOS. No Cortex required. Priority support and advanced modules.',
    category: 'silo-standalone',
    validationMode: 'HYBRID',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: null,
    priceAnnual: 4999, // $49.99 / yr
    features: [
      'standalone',
      'single-machine',
      'offline-mode',
      'all-modules',
      'advanced-reporting',
      'priority-support',
    ],
    platforms: ['WINDOWS', 'MACOS'],
    defaultSeatCount: 1,
    maxSeatCount: 1,
    seatPriceMonthly: null,
    seatPriceAnnual: null,
    offlineGraceDays: 14,
    checkInIntervalDays: 7,
    licenseDurationDays: null,
    requiresActivation: true,
    version: '1.0.0',
  },
  {
    name: 'SILO Cortex Business',
    description:
      'SILO managed by Cortex for small teams. 5 seats included, mTLS agent enrolment, central dashboard, priority support.',
    category: 'silo-cortex',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: null,
    priceAnnual: 49900, // $499 / yr
    features: [
      'cortex-managed',
      'team-dashboard',
      'mtls-agent',
      'all-modules',
      'priority-support',
    ],
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
    name: 'SILO Cortex Enterprise',
    description:
      'SILO managed by Cortex for organisations. 10 seats included, mTLS agent enrolment, enterprise plugins, SSO, audit logs, SLA, dedicated support.',
    category: 'silo-cortex',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: null,
    priceAnnual: 199900, // $1999 / yr
    features: [
      'cortex-managed',
      'team-dashboard',
      'mtls-agent',
      'all-modules',
      'enterprise-plugins',
      'sso',
      'audit-logs',
      'dedicated-support',
      'sla',
    ],
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
];

(async () => {
  for (const def of products) {
    const existing = await p.product.findFirst({ where: { name: def.name } });
    if (existing) {
      const u = await p.product.update({ where: { id: existing.id }, data: def });
      console.log(
        'UPDATED  ' +
          u.id +
          '  ' +
          u.name +
          '  $' +
          (u.priceAnnual / 100).toFixed(2) +
          '/yr  seats=' +
          u.defaultSeatCount,
      );
    } else {
      const c = await p.product.create({ data: def });
      console.log(
        'CREATED  ' +
          c.id +
          '  ' +
          c.name +
          '  $' +
          (c.priceAnnual / 100).toFixed(2) +
          '/yr  seats=' +
          c.defaultSeatCount,
      );
    }
  }
  await p.$disconnect();
})().catch((e) => {
  console.error('seed failed', e);
  process.exit(1);
});
