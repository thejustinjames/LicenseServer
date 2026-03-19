import { PrismaClient, PurchaseType, PricingType, ValidationMode } from '@prisma/client';

const prisma = new PrismaClient();

interface SiloProduct {
  name: string;
  description: string;
  category: string;
  purchaseType: PurchaseType;
  pricingType: PricingType;
  validationMode: ValidationMode;
  priceMonthly: number | null;
  priceAnnual: number | null;
  licenseDurationDays: number | null;
  features: string[];
  s3PackageKey: string | null;
  version: string | null;
}

// SILO product tiers with SGD pricing (stored in cents)
const siloProducts: SiloProduct[] = [
  // Home Editions - One-time purchase
  {
    name: 'SILO Home - Windows',
    description: 'Standalone SILO for Windows. Perfect for personal security research and learning.',
    category: 'silo',
    purchaseType: 'ONE_TIME',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: 9900,       // SGD 99.00 one-time
    priceAnnual: null,
    licenseDurationDays: 365, // 1 year license
    features: ['windows-x64', 'basic-modules', 'offline-mode', 'community-support', '1-machine'],
    s3PackageKey: 'silo/windows/silo-home-windows-x64.zip',
    version: '1.0.0',
  },
  {
    name: 'SILO Home - macOS',
    description: 'Standalone SILO for macOS Apple Silicon. Perfect for personal security research and learning.',
    category: 'silo',
    purchaseType: 'ONE_TIME',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: 9900,       // SGD 99.00 one-time
    priceAnnual: null,
    licenseDurationDays: 365, // 1 year license
    features: ['macos-arm64', 'basic-modules', 'offline-mode', 'community-support', '1-machine'],
    s3PackageKey: 'silo/macos/silo-home-macos-arm64.zip',
    version: '1.0.0',
  },
  // Business Edition - Subscription
  {
    name: 'SILO Business',
    description: 'SILO for small teams and businesses. Includes advanced modules and priority support.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: 19900,      // SGD 199.00/month
    priceAnnual: 199000,      // SGD 1990.00/year (save ~17%)
    licenseDurationDays: null,
    features: ['windows-x64', 'macos-arm64', 'linux-x64', 'all-modules', 'advanced-reporting', 'api-access', 'priority-support', '5-machines', 'team-dashboard'],
    s3PackageKey: 'silo/business/silo-business-multiplatform.zip',
    version: '1.0.0',
  },
  // Enterprise Edition - Subscription
  {
    name: 'SILO Enterprise',
    description: 'Full SILO suite for organizations. Includes all features, SSO, and dedicated support.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: 49900,      // SGD 499.00/month
    priceAnnual: 499000,      // SGD 4990.00/year (save ~17%)
    licenseDurationDays: null,
    features: ['all-platforms', 'all-modules', 'advanced-reporting', 'api-access', 'sso', 'audit-logs', 'dedicated-support', 'unlimited-machines', 'custom-integrations', 'sla'],
    s3PackageKey: 'silo/enterprise/silo-enterprise-multiplatform.zip',
    version: '1.0.0',
  },
  // Enterprise License Packs - Annual bundles (Server $5,000 + $45/license/year)
  {
    name: 'SILO Enterprise Pack - 5 Licenses',
    description: 'Enterprise license bundle for 5 users. Includes server license and 5 seat licenses.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 522500,      // SGD 5,225/year ($5,000 server + 5 × $45 licenses)
    licenseDurationDays: null,
    features: ['5-licenses', 'all-platforms', 'all-modules', 'advanced-reporting', 'api-access', 'sso', 'audit-logs', 'priority-support'],
    s3PackageKey: 'silo/enterprise/silo-enterprise-multiplatform.zip',
    version: '1.0.0',
  },
  {
    name: 'SILO Enterprise Pack - 10 Licenses',
    description: 'Enterprise license bundle for 10 users. Includes server license and 10 seat licenses.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 545000,      // SGD 5,450/year ($5,000 server + 10 × $45 licenses)
    licenseDurationDays: null,
    features: ['10-licenses', 'all-platforms', 'all-modules', 'advanced-reporting', 'api-access', 'sso', 'audit-logs', 'dedicated-support'],
    s3PackageKey: 'silo/enterprise/silo-enterprise-multiplatform.zip',
    version: '1.0.0',
  },
  {
    name: 'SILO Enterprise Pack - 20 Licenses',
    description: 'Enterprise license bundle for 20 users. Includes server license and 20 seat licenses.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 590000,      // SGD 5,900/year ($5,000 server + 20 × $45 licenses)
    licenseDurationDays: null,
    features: ['20-licenses', 'all-platforms', 'all-modules', 'advanced-reporting', 'api-access', 'sso', 'audit-logs', 'dedicated-support', 'custom-integrations'],
    s3PackageKey: 'silo/enterprise/silo-enterprise-multiplatform.zip',
    version: '1.0.0',
  },
  {
    name: 'SILO Enterprise Pack - 50 Licenses',
    description: 'Enterprise license bundle for 50 users. Includes server license and 50 seat licenses.',
    category: 'silo',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: null,
    priceAnnual: 725000,      // SGD 7,250/year ($5,000 server + 50 × $45 licenses)
    licenseDurationDays: null,
    features: ['50-licenses', 'all-platforms', 'all-modules', 'advanced-reporting', 'api-access', 'sso', 'audit-logs', 'dedicated-support', 'custom-integrations', 'sla'],
    s3PackageKey: 'silo/enterprise/silo-enterprise-multiplatform.zip',
    version: '1.0.0',
  },
  // Enterprise Custom - Contact sales (POA)
  {
    name: 'SILO Enterprise Custom',
    description: 'Custom SILO deployment for large organizations. Unlimited licenses, on-premise options. Contact sales for pricing.',
    category: 'silo',
    purchaseType: 'ONE_TIME',
    pricingType: 'FIXED',
    validationMode: 'OFFLINE',
    priceMonthly: null,       // POA
    priceAnnual: null,
    licenseDurationDays: 365,
    features: ['unlimited-licenses', 'all-features', 'on-premise', 'air-gapped', 'custom-modules', 'white-label', 'source-code-review', 'dedicated-account-manager', 'premium-sla'],
    s3PackageKey: null,
    version: null,
  },
  // Add-on: SILO k8inspector Integration (Annual only)
  {
    name: 'SILO k8inspector Integration',
    description: 'Add Kubernetes inspection capabilities to SILO. Requires SILO Business or Enterprise license.',
    category: 'silo-addons',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'ONLINE',
    priceMonthly: null,
    priceAnnual: 49000,       // SGD 490.00/year
    licenseDurationDays: null,
    features: ['k8s-cluster-inspection', 'pod-analysis', 'network-policy-audit', 'rbac-review', 'secrets-scanning', 'compliance-checks', 'silo-integration'],
    s3PackageKey: 'silo/addons/silo-k8inspector-addon.zip',
    version: '1.0.0',
  },
  // Add-on: SILO Docker Monitor (Annual only)
  {
    name: 'SILO Docker Monitor',
    description: 'Real-time Docker container monitoring and security analysis for SILO. Requires SILO Business or Enterprise license.',
    category: 'silo-addons',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'ONLINE',
    priceMonthly: null,
    priceAnnual: 29000,       // SGD 290.00/year
    licenseDurationDays: null,
    features: ['container-monitoring', 'image-scanning', 'runtime-security', 'network-analysis', 'log-aggregation', 'alerting', 'silo-integration'],
    s3PackageKey: 'silo/addons/silo-docker-monitor-addon.zip',
    version: '1.0.0',
  },
];

async function seed() {
  console.log('Seeding SILO products...');

  for (const product of siloProducts) {
    // Check if product already exists by name and category
    const existing = await prisma.product.findFirst({
      where: {
        name: product.name,
        category: product.category,
      },
    });

    if (existing) {
      // Update existing product
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          description: product.description,
          purchaseType: product.purchaseType,
          pricingType: product.pricingType,
          validationMode: product.validationMode,
          priceMonthly: product.priceMonthly,
          priceAnnual: product.priceAnnual,
          licenseDurationDays: product.licenseDurationDays,
          features: product.features,
          s3PackageKey: product.s3PackageKey,
          version: product.version,
        },
      });
      console.log(`  Updated: ${product.name}`);
    } else {
      // Create new product
      await prisma.product.create({
        data: {
          name: product.name,
          description: product.description,
          category: product.category,
          purchaseType: product.purchaseType,
          pricingType: product.pricingType,
          validationMode: product.validationMode,
          priceMonthly: product.priceMonthly,
          priceAnnual: product.priceAnnual,
          licenseDurationDays: product.licenseDurationDays,
          features: product.features,
          s3PackageKey: product.s3PackageKey,
          version: product.version,
        },
      });
      console.log(`  Created: ${product.name}`);
    }
  }

  console.log('Done seeding SILO products.');
}

seed()
  .catch((e) => {
    console.error('Error seeding SILO products:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
