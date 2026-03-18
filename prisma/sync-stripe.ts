/**
 * Sync products to Stripe Sandbox
 *
 * This script creates Stripe products and prices for all products
 * that don't already have Stripe IDs.
 *
 * Usage: npx tsx prisma/sync-stripe.ts
 */

import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import 'dotenv/config';

const prisma = new PrismaClient();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
  console.error('STRIPE_SECRET_KEY not configured');
  process.exit(1);
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: '2024-12-18.acacia',
});

async function syncProductsToStripe() {
  console.log('Syncing products to Stripe...\n');

  // Get all products without Stripe IDs
  const products = await prisma.product.findMany({
    where: {
      stripeProductId: null,
    },
    orderBy: { name: 'asc' },
  });

  console.log(`Found ${products.length} products to sync\n`);

  for (const product of products) {
    // Skip POA (Price on Application) products
    if (product.priceMonthly === null && product.priceAnnual === null) {
      console.log(`⏭️  Skipping ${product.name} (POA - contact sales)`);
      continue;
    }

    // Skip free products (no payment needed)
    if (product.priceMonthly === 0 && product.priceAnnual === null) {
      console.log(`⏭️  Skipping ${product.name} (Free tier)`);
      continue;
    }

    console.log(`📦 Processing: ${product.name}`);

    try {
      // Create Stripe product
      const stripeProduct = await stripe.products.create({
        name: product.name,
        description: product.description || undefined,
        metadata: {
          category: product.category || '',
          productId: product.id,
        },
      });

      console.log(`   ✓ Created Stripe product: ${stripeProduct.id}`);

      let stripePriceId: string | null = null;
      let stripePriceIdAnnual: string | null = null;

      const isOneTime = product.purchaseType === 'ONE_TIME';
      const currency = 'sgd'; // Singapore Dollars as per seed data

      // Create monthly price (or one-time price for ONE_TIME products)
      if (product.priceMonthly && product.priceMonthly > 0) {
        const priceParams: Stripe.PriceCreateParams = {
          product: stripeProduct.id,
          currency,
          unit_amount: product.priceMonthly,
        };

        if (!isOneTime) {
          priceParams.recurring = { interval: 'month' };
        }

        const monthlyPrice = await stripe.prices.create(priceParams);
        stripePriceId = monthlyPrice.id;
        console.log(`   ✓ Created ${isOneTime ? 'one-time' : 'monthly'} price: ${monthlyPrice.id} (${formatPrice(product.priceMonthly)} SGD)`);
      }

      // Create annual price for subscriptions
      if (!isOneTime && product.priceAnnual && product.priceAnnual > 0) {
        const annualPrice = await stripe.prices.create({
          product: stripeProduct.id,
          currency,
          unit_amount: product.priceAnnual,
          recurring: { interval: 'year' },
        });
        stripePriceIdAnnual = annualPrice.id;
        console.log(`   ✓ Created annual price: ${annualPrice.id} (${formatPrice(product.priceAnnual)} SGD/year)`);
      }

      // Update product in database
      await prisma.product.update({
        where: { id: product.id },
        data: {
          stripeProductId: stripeProduct.id,
          stripePriceId,
          stripePriceIdAnnual,
        },
      });

      console.log(`   ✓ Updated database\n`);
    } catch (error) {
      console.error(`   ✗ Error: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    }
  }

  console.log('\nDone!');
}

function formatPrice(cents: number): string {
  return (cents / 100).toFixed(2);
}

syncProductsToStripe()
  .catch((e) => {
    console.error('Error syncing products:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
