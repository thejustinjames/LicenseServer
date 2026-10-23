/**
 * The Agencie Lab products: one licence key per machine.
 *
 *   agencie-lab          the Docker host (bosgame or its equivalent): AOS, Code Easy and CloudCode
 *                        are its three licensed modules (`components`); the features are the
 *                        entitlements AOS reads.
 *   agencie-lab-models   a models host (a DGX Spark, a CT with a GPU): its one module.
 *
 * Idempotent: upserts by slug. Run with `npm run seed:agencie-lab`.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const products = [
  {
    slug: 'agencie-lab',
    name: 'Agencie Lab - Docker host',
    description: 'The Agencie Lab on one Docker host: AOS (the gateway and console), Code Easy and CloudCode, licensed as three modules of one product. One key per host.',
    category: 'agencie-lab',
    purchaseType: 'SUBSCRIPTION' as const,
    pricingType: 'FIXED' as const,
    validationMode: 'HYBRID' as const,
    // Placeholder prices, USD cents: change them in the admin UI (Products) when the offer is set.
    priceMonthly: 49900,
    priceAnnual: 499000,
    licenseDurationDays: 365,
    requiresActivation: true,
    offlineGraceDays: 7,
    checkInIntervalDays: 1,
    components: ['aos', 'codeeasy', 'cloudcode'],
    features: ['connectors', 'escalation', 'images', 'update-channel:stable', 'max-accounts:10'],
    platforms: ['WEB' as const],
    version: '1.1',
  },
  {
    slug: 'agencie-lab-models',
    name: 'Agencie Lab - Models host',
    description: 'A models host of the Agencie Lab: llama-server, the image server and their gateway on a GPU machine such as a DGX Spark. One key per machine.',
    category: 'agencie-lab',
    purchaseType: 'SUBSCRIPTION' as const,
    pricingType: 'FIXED' as const,
    validationMode: 'HYBRID' as const,
    priceMonthly: 19900,
    priceAnnual: 199000,
    licenseDurationDays: 365,
    requiresActivation: true,
    offlineGraceDays: 7,
    checkInIntervalDays: 1,
    components: ['models-host'],
    features: ['update-channel:stable'],
    platforms: ['WEB' as const],
    version: '1.0',
  },
];

async function main(): Promise<void> {
  for (const p of products) {
    const { slug, ...rest } = p;
    const row = await prisma.product.upsert({ where: { slug }, update: rest, create: { slug, ...rest } });
    console.log(`${row.slug}: ${row.name} (${row.components.join(', ')})`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
