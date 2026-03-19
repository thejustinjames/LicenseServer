/**
 * Update Stripe prices for products with changed pricing
 *
 * Stripe prices are immutable, so this script:
 * 1. Archives the old price
 * 2. Creates a new price with the correct amount
 * 3. Updates the database with the new price ID
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

async function updateStripePrices() {
  console.log('Updating Stripe prices for Enterprise Packs...\n');

  // Get Enterprise Pack products
  const products = await prisma.product.findMany({
    where: {
      name: { contains: 'Enterprise Pack' },
      stripeProductId: { not: null },
    },
  });

  for (const product of products) {
    if (!product.stripeProductId || !product.priceAnnual) continue;

    console.log(`📦 ${product.name}`);
    console.log(`   Current DB price: SGD ${(product.priceAnnual / 100).toLocaleString()}/year`);

    try {
      // Archive old annual price if exists
      if (product.stripePriceIdAnnual) {
        await stripe.prices.update(product.stripePriceIdAnnual, { active: false });
        console.log(`   ✓ Archived old price: ${product.stripePriceIdAnnual}`);
      }

      // Create new annual price
      const newPrice = await stripe.prices.create({
        product: product.stripeProductId,
        currency: 'sgd',
        unit_amount: product.priceAnnual,
        recurring: { interval: 'year' },
      });

      console.log(`   ✓ Created new price: ${newPrice.id} (SGD ${(product.priceAnnual / 100).toLocaleString()}/year)`);

      // Update database
      await prisma.product.update({
        where: { id: product.id },
        data: { stripePriceIdAnnual: newPrice.id },
      });

      console.log(`   ✓ Updated database\n`);
    } catch (error) {
      console.error(`   ✗ Error: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
    }
  }

  console.log('Done!');
}

updateStripePrices()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
