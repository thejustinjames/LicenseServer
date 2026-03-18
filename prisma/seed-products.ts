/**
 * Product Seed Script
 *
 * Creates all product definitions for K8inspector, Silo Enterprise, and Plugins.
 *
 * Run with: npx ts-node prisma/seed-products.ts
 * Or add to package.json: "prisma": { "seed": "ts-node prisma/seed-products.ts" }
 */

import { PrismaClient, ValidationMode, PricingType, PurchaseType, Platform, LicenseType, LicenseTerm } from '@prisma/client';

const prisma = new PrismaClient();

interface ProductDefinition {
  name: string;
  description: string;
  category: string;
  validationMode: ValidationMode;
  pricingType: PricingType;
  purchaseType: PurchaseType;
  priceMonthly?: number;
  priceAnnual?: number;
  features: string[];
  platforms: Platform[];
  defaultSeatCount: number;
  maxSeatCount?: number;
  seatPriceMonthly?: number;
  seatPriceAnnual?: number;
  offlineGraceDays: number;
  checkInIntervalDays: number;
  licenseDurationDays?: number;
}

// ============================================================================
// K8INSPECTOR PRODUCTS
// ============================================================================

const k8inspectorProducts: ProductDefinition[] = [
  {
    name: 'K8inspector Free',
    description: 'Free tier for basic Kubernetes cluster viewing. Read-only access with 1 cluster limit.',
    category: 'k8inspector',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: 0,
    priceAnnual: 0,
    features: ['basic', 'read-only', '1-cluster'],
    platforms: ['WEB'],
    defaultSeatCount: 1,
    offlineGraceDays: 1,
    checkInIntervalDays: 1,
  },
  {
    name: 'K8inspector Professional',
    description: 'Professional tier with AI Assistant, Cost Analysis, Security features. Up to 3 clusters.',
    category: 'k8inspector',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: 7900, // $79.00
    priceAnnual: 79000, // $790.00 (2 months free)
    features: ['ai-assistant', 'cost-analysis', 'security', '3-clusters', 'logs', 'terminal'],
    platforms: ['WEB'],
    defaultSeatCount: 1,
    maxSeatCount: 5,
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
  },
  {
    name: 'K8inspector Enterprise',
    description: 'Enterprise tier with all features, API access, integrations. Unlimited clusters.',
    category: 'k8inspector',
    validationMode: 'HYBRID',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: 19900, // $199.00
    priceAnnual: 199000, // $1990.00 (2 months free)
    features: ['all-features', 'api-keys', 'integrations', 'unlimited-clusters', 'sso', 'audit-logs', 'priority-support'],
    platforms: ['WEB'],
    defaultSeatCount: 1,
    maxSeatCount: 100,
    offlineGraceDays: 14,
    checkInIntervalDays: 7,
  },
  {
    name: 'K8inspector Home - Windows',
    description: 'Desktop application for Windows. Annual subscription with offline support.',
    category: 'k8inspector-desktop',
    validationMode: 'HYBRID',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceAnnual: 4900, // $49.00/year
    features: ['desktop', 'local-clusters', 'offline-mode', 'auto-updates'],
    platforms: ['WINDOWS'],
    defaultSeatCount: 1,
    maxSeatCount: 2, // 2 devices per license
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
    licenseDurationDays: 365,
  },
  {
    name: 'K8inspector Home - Mac',
    description: 'Desktop application for macOS. Annual subscription with offline support.',
    category: 'k8inspector-desktop',
    validationMode: 'HYBRID',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceAnnual: 4900, // $49.00/year
    features: ['desktop', 'local-clusters', 'offline-mode', 'auto-updates'],
    platforms: ['MACOS'],
    defaultSeatCount: 1,
    maxSeatCount: 2, // 2 devices per license
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
    licenseDurationDays: 365,
  },
  {
    name: 'K8inspector Home - Bundle',
    description: 'Desktop application for Windows and macOS. Annual subscription with offline support.',
    category: 'k8inspector-desktop',
    validationMode: 'HYBRID',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceAnnual: 7900, // $79.00/year (save $20)
    features: ['desktop', 'local-clusters', 'offline-mode', 'auto-updates', 'cross-platform'],
    platforms: ['WINDOWS', 'MACOS'],
    defaultSeatCount: 1,
    maxSeatCount: 4, // 4 devices per license (2 Windows + 2 Mac)
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
    licenseDurationDays: 365,
  },
];

// ============================================================================
// SILO ENTERPRISE PRODUCTS
// ============================================================================

const siloProducts: ProductDefinition[] = [
  {
    name: 'Silo Team 5',
    description: 'Team license for up to 5 users. Includes shared resources and basic support.',
    category: 'silo',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: 29900, // $299.00
    priceAnnual: 299000, // $2990.00 (2 months free)
    features: ['team', 'shared-resources', 'basic-support', '5-seats'],
    platforms: ['WEB'],
    defaultSeatCount: 5,
    maxSeatCount: 5,
    seatPriceMonthly: 5980, // $59.80 per seat
    seatPriceAnnual: 59800,
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
  },
  {
    name: 'Silo Team 10',
    description: 'Team license for up to 10 users. Includes shared resources and priority support.',
    category: 'silo',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: 54900, // $549.00
    priceAnnual: 549000, // $5490.00 (2 months free)
    features: ['team', 'shared-resources', 'priority-support', '10-seats'],
    platforms: ['WEB'],
    defaultSeatCount: 10,
    maxSeatCount: 10,
    seatPriceMonthly: 5490, // $54.90 per seat
    seatPriceAnnual: 54900,
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
  },
  {
    name: 'Silo Team 20',
    description: 'Team license for up to 20 users. Includes SSO and priority support.',
    category: 'silo',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: 99900, // $999.00
    priceAnnual: 999000, // $9990.00 (2 months free)
    features: ['team', 'shared-resources', 'priority-support', 'sso', '20-seats'],
    platforms: ['WEB'],
    defaultSeatCount: 20,
    maxSeatCount: 20,
    seatPriceMonthly: 4995, // $49.95 per seat
    seatPriceAnnual: 49950,
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
  },
  {
    name: 'Silo Team 50',
    description: 'Team license for up to 50 users. Includes dedicated support, SSO, and audit logs.',
    category: 'silo',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: 199900, // $1999.00
    priceAnnual: 1999000, // $19990.00 (2 months free)
    features: ['team', 'shared-resources', 'dedicated-support', 'sso', 'audit-logs', '50-seats'],
    platforms: ['WEB'],
    defaultSeatCount: 50,
    maxSeatCount: 50,
    seatPriceMonthly: 3998, // $39.98 per seat
    seatPriceAnnual: 39980,
    offlineGraceDays: 14,
    checkInIntervalDays: 7,
  },
  {
    name: 'Silo Enterprise',
    description: 'Enterprise license with unlimited seats. Custom integrations, SLA, and dedicated support. Price on application.',
    category: 'silo',
    validationMode: 'HYBRID',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    // No fixed price - POA
    features: ['enterprise', 'unlimited', 'custom-integrations', 'sla', 'dedicated-support', 'sso', 'audit-logs', 'api-access'],
    platforms: ['WEB'],
    defaultSeatCount: 100,
    maxSeatCount: 10000, // Effectively unlimited
    offlineGraceDays: 30,
    checkInIntervalDays: 14,
  },
];

// ============================================================================
// PLUGIN PRODUCTS
// ============================================================================

const pluginProducts: ProductDefinition[] = [
  {
    name: 'K8inspector Plugin Pack',
    description: 'Additional plugins for K8inspector. Requires K8inspector Professional or Enterprise.',
    category: 'plugins',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: 2900, // $29.00
    priceAnnual: 29000, // $290.00 (2 months free)
    features: ['k8inspector-plugins', 'helm-integration', 'gitops', 'backup-restore'],
    platforms: ['WEB'],
    defaultSeatCount: 1,
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
  },
  {
    name: 'Docker Plugin Pack',
    description: 'Docker management plugins. Includes container insights, image scanning, and compose support.',
    category: 'plugins',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: 2900, // $29.00
    priceAnnual: 29000, // $290.00 (2 months free)
    features: ['docker-plugins', 'container-insights', 'image-scanning', 'compose-support'],
    platforms: ['WEB', 'WINDOWS', 'MACOS'],
    defaultSeatCount: 1,
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
  },
  {
    name: 'Full Plugin Bundle',
    description: 'All plugins included. Best value for power users.',
    category: 'plugins',
    validationMode: 'ONLINE',
    pricingType: 'FIXED',
    purchaseType: 'SUBSCRIPTION',
    priceMonthly: 4900, // $49.00 (save $9)
    priceAnnual: 49000, // $490.00 (2 months free)
    features: ['all-plugins', 'k8inspector-plugins', 'docker-plugins', 'helm-integration', 'gitops', 'backup-restore', 'container-insights', 'image-scanning', 'compose-support'],
    platforms: ['WEB', 'WINDOWS', 'MACOS'],
    defaultSeatCount: 1,
    offlineGraceDays: 7,
    checkInIntervalDays: 7,
  },
];

// ============================================================================
// SEED FUNCTION
// ============================================================================

async function seedProducts() {
  console.log('Seeding products...\n');

  const allProducts = [...k8inspectorProducts, ...siloProducts, ...pluginProducts];

  for (const product of allProducts) {
    const existing = await prisma.product.findFirst({
      where: { name: product.name },
    });

    if (existing) {
      console.log(`Updating: ${product.name}`);
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          description: product.description,
          category: product.category,
          validationMode: product.validationMode,
          pricingType: product.pricingType,
          purchaseType: product.purchaseType,
          priceMonthly: product.priceMonthly,
          priceAnnual: product.priceAnnual,
          features: product.features,
          platforms: product.platforms,
          defaultSeatCount: product.defaultSeatCount,
          maxSeatCount: product.maxSeatCount,
          seatPriceMonthly: product.seatPriceMonthly,
          seatPriceAnnual: product.seatPriceAnnual,
          offlineGraceDays: product.offlineGraceDays,
          checkInIntervalDays: product.checkInIntervalDays,
          licenseDurationDays: product.licenseDurationDays,
        },
      });
    } else {
      console.log(`Creating: ${product.name}`);
      await prisma.product.create({
        data: {
          name: product.name,
          description: product.description,
          category: product.category,
          validationMode: product.validationMode,
          pricingType: product.pricingType,
          purchaseType: product.purchaseType,
          priceMonthly: product.priceMonthly,
          priceAnnual: product.priceAnnual,
          features: product.features,
          platforms: product.platforms,
          defaultSeatCount: product.defaultSeatCount,
          maxSeatCount: product.maxSeatCount,
          seatPriceMonthly: product.seatPriceMonthly,
          seatPriceAnnual: product.seatPriceAnnual,
          offlineGraceDays: product.offlineGraceDays,
          checkInIntervalDays: product.checkInIntervalDays,
          licenseDurationDays: product.licenseDurationDays,
        },
      });
    }
  }

  console.log('\n✅ Products seeded successfully!');

  // Print summary
  console.log('\n📦 Product Summary:');
  console.log('==================');

  const products = await prisma.product.findMany({
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });

  let currentCategory = '';
  for (const p of products) {
    if (p.category !== currentCategory) {
      currentCategory = p.category || '';
      console.log(`\n${currentCategory.toUpperCase()}`);
      console.log('-'.repeat(40));
    }

    const monthlyPrice = p.priceMonthly ? `$${(p.priceMonthly / 100).toFixed(2)}/mo` : '';
    const annualPrice = p.priceAnnual ? `$${(p.priceAnnual / 100).toFixed(2)}/yr` : 'POA';

    console.log(`  ${p.name}`);
    console.log(`    Price: ${monthlyPrice} ${monthlyPrice && annualPrice ? '|' : ''} ${annualPrice}`);
    console.log(`    Seats: ${p.defaultSeatCount}${p.maxSeatCount ? ` (max ${p.maxSeatCount})` : ''}`);
    console.log(`    Features: ${p.features.join(', ')}`);
  }
}

// Run the seed
seedProducts()
  .catch((e) => {
    console.error('Error seeding products:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
