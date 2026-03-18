import { PrismaClient, PurchaseType, PricingType, ValidationMode } from '@prisma/client';

const prisma = new PrismaClient();

interface K8inspectorProduct {
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
}

// k8inspector product tiers with SGD pricing (stored in cents)
const k8inspectorProducts: K8inspectorProduct[] = [
  {
    name: 'k8inspector Free Edition',
    description: 'Free license with monthly key renewal. Perfect for learning and personal projects.',
    category: 'k8inspector',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'ONLINE',
    priceMonthly: 0,
    priceAnnual: null,
    licenseDurationDays: 30,
    features: ['basic-inspection', 'cli-access', 'community-support'],
  },
  {
    name: 'k8inspector Professional',
    description: 'Professional tier for individual developers and small teams. Includes advanced features and priority support.',
    category: 'k8inspector',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: 7900,      // SGD 79.00
    priceAnnual: 79000,      // SGD 790.00 (save ~17%)
    licenseDurationDays: null,
    features: ['basic-inspection', 'cli-access', 'advanced-inspection', 'api-access', 'priority-support', 'offline-mode'],
  },
  {
    name: 'k8inspector Enterprise',
    description: 'Enterprise tier for organizations. Includes team management, SSO, and dedicated support.',
    category: 'k8inspector',
    purchaseType: 'SUBSCRIPTION',
    pricingType: 'FIXED',
    validationMode: 'HYBRID',
    priceMonthly: 19900,     // SGD 199.00
    priceAnnual: 199000,     // SGD 1990.00 (save ~17%)
    licenseDurationDays: null,
    features: ['basic-inspection', 'cli-access', 'advanced-inspection', 'api-access', 'priority-support', 'offline-mode', 'team-management', 'sso', 'audit-logs', 'dedicated-support'],
  },
  {
    name: 'k8inspector Enterprise Custom',
    description: 'Custom licensing for large organizations. Contact sales for pricing and custom integrations.',
    category: 'k8inspector',
    purchaseType: 'ONE_TIME',
    pricingType: 'FIXED',
    validationMode: 'OFFLINE',
    priceMonthly: null,      // POA - Price on Application
    priceAnnual: null,
    licenseDurationDays: 365, // 1 year default, customizable
    features: ['all-features', 'custom-integration', 'on-premise', 'sla', 'dedicated-account-manager'],
  },
  {
    name: 'k8inspector Enterprise Source',
    description: 'Enterprise with source code access. Contact sales for pricing, white-label options, and premium SLA.',
    category: 'k8inspector',
    purchaseType: 'ONE_TIME',
    pricingType: 'FIXED',
    validationMode: 'OFFLINE',
    priceMonthly: null,      // POA
    priceAnnual: null,
    licenseDurationDays: 365, // 1 year default, customizable
    features: ['all-features', 'source-code-access', 'custom-builds', 'white-label', 'premium-sla'],
  },
];

async function seed() {
  console.log('Seeding k8inspector products...');

  for (const product of k8inspectorProducts) {
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
        },
      });
      console.log(`  Created: ${product.name}`);
    }
  }

  console.log('Done seeding k8inspector products.');
}

seed()
  .catch((e) => {
    console.error('Error seeding k8inspector products:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
