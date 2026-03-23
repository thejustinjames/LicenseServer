import { prisma } from '../config/database.js';
import { stripe } from '../config/stripe.js';
import { Product, ValidationMode, PricingType, PurchaseType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.service.js';

export interface CreateProductInput {
  name: string;
  description?: string;
  category?: string;
  validationMode?: ValidationMode;
  pricingType?: PricingType;
  purchaseType?: PurchaseType;
  licenseDurationDays?: number;
  s3PackageKey?: string;
  version?: string;
  features?: string[];
  createStripeProduct?: boolean;
  // Monthly pricing
  stripePriceAmount?: number;
  stripePriceCurrency?: string;
  stripePriceInterval?: 'month' | 'year';
  // Annual pricing (optional, for subscription products)
  stripePriceAmountAnnual?: number;
  // Local price display (in cents)
  priceMonthly?: number;
  priceAnnual?: number;
  // Metered billing options
  meteredUsageType?: 'licensed' | 'metered' | 'aggregated';
  meteredAggregateUsage?: 'sum' | 'last_during_period' | 'last_ever' | 'max';
  // Tax options
  taxCode?: string;
  taxBehavior?: 'exclusive' | 'inclusive' | 'unspecified';
}

export interface ProductSearchOptions {
  search?: string;
  category?: string;
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  category?: string | null;
  validationMode?: ValidationMode;
  pricingType?: PricingType;
  purchaseType?: PurchaseType;
  licenseDurationDays?: number | null;
  s3PackageKey?: string;
  version?: string;
  features?: string[];
  priceMonthly?: number | null;
  priceAnnual?: number | null;
}

/**
 * Generate an idempotency key for Stripe operations
 */
function generateIdempotencyKey(operation: string, resourceId?: string): string {
  const id = resourceId || uuidv4();
  return `${operation}-${id}-${Date.now()}`;
}

export async function createProduct(input: CreateProductInput): Promise<Product> {
  let stripeProductId: string | undefined;
  let stripePriceId: string | undefined;
  let stripePriceIdAnnual: string | undefined;

  const isOneTime = input.purchaseType === 'ONE_TIME';

  if (input.createStripeProduct && input.stripePriceAmount !== undefined) {
    const idempotencyKey = generateIdempotencyKey('create-product', input.name);

    // Create product in Stripe with tax code if provided
    const productParams: Parameters<typeof stripe.products.create>[0] = {
      name: input.name,
      description: input.description,
    };

    // Add tax code for Stripe Tax
    if (input.taxCode) {
      productParams.tax_code = input.taxCode;
    }

    const stripeProduct = await stripe.products.create(productParams, {
      idempotencyKey,
    });
    stripeProductId = stripeProduct.id;

    // Create price in Stripe
    const priceIdempotencyKey = generateIdempotencyKey('create-price', stripeProduct.id);

    const isMetered = input.pricingType === 'METERED';

    const priceParams: Parameters<typeof stripe.prices.create>[0] = {
      product: stripeProduct.id,
      currency: input.stripePriceCurrency || 'usd',
    };

    if (isMetered) {
      // Metered pricing - usage-based
      priceParams.recurring = {
        interval: input.stripePriceInterval || 'month',
        usage_type: 'metered',
        aggregate_usage: input.meteredAggregateUsage || 'sum',
      };
      // For metered pricing, unit_amount is the price per unit
      priceParams.unit_amount = input.stripePriceAmount;
    } else if (isOneTime) {
      // One-time payment - no recurring
      priceParams.unit_amount = input.stripePriceAmount;
      // No recurring field for one-time payments
    } else {
      // Subscription - monthly pricing
      priceParams.unit_amount = input.stripePriceAmount;
      priceParams.recurring = {
        interval: 'month',
      };
    }

    // Add tax behavior
    if (input.taxBehavior) {
      priceParams.tax_behavior = input.taxBehavior;
    }

    const stripePrice = await stripe.prices.create(priceParams, {
      idempotencyKey: priceIdempotencyKey,
    });
    stripePriceId = stripePrice.id;

    // Create annual price for subscriptions if amount provided
    if (!isOneTime && !isMetered && input.stripePriceAmountAnnual) {
      const annualPriceIdempotencyKey = generateIdempotencyKey('create-annual-price', stripeProduct.id);

      const annualPriceParams: Parameters<typeof stripe.prices.create>[0] = {
        product: stripeProduct.id,
        currency: input.stripePriceCurrency || 'usd',
        unit_amount: input.stripePriceAmountAnnual,
        recurring: {
          interval: 'year',
        },
      };

      if (input.taxBehavior) {
        annualPriceParams.tax_behavior = input.taxBehavior;
      }

      const stripeAnnualPrice = await stripe.prices.create(annualPriceParams, {
        idempotencyKey: annualPriceIdempotencyKey,
      });
      stripePriceIdAnnual = stripeAnnualPrice.id;
    }
  }

  return prisma.product.create({
    data: {
      name: input.name,
      description: input.description,
      category: input.category,
      validationMode: input.validationMode || 'ONLINE',
      pricingType: input.pricingType || 'FIXED',
      purchaseType: input.purchaseType || 'SUBSCRIPTION',
      licenseDurationDays: input.licenseDurationDays,
      s3PackageKey: input.s3PackageKey,
      version: input.version,
      features: input.features || [],
      stripeProductId,
      stripePriceId,
      stripePriceIdAnnual,
      priceMonthly: input.priceMonthly,
      priceAnnual: input.priceAnnual,
    },
  });
}

export async function getProductById(id: string): Promise<Product | null> {
  return prisma.product.findUnique({
    where: { id },
  });
}

export async function getProductByStripeProductId(stripeProductId: string): Promise<Product | null> {
  return prisma.product.findUnique({
    where: { stripeProductId },
  });
}

export async function listProducts(options?: ProductSearchOptions): Promise<Product[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {};

  if (options?.category) {
    where.category = options.category;
  }

  if (options?.search) {
    where.OR = [
      { name: { contains: options.search, mode: 'insensitive' } },
      { description: { contains: options.search, mode: 'insensitive' } },
    ];
  }

  return prisma.product.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });
}

export async function listCategories(): Promise<string[]> {
  const products = await prisma.product.findMany({
    where: { category: { not: null } },
    select: { category: true },
    distinct: ['category'],
    orderBy: { category: 'asc' },
  });

  return products.map(p => p.category).filter((c): c is string => c !== null);
}

export async function updateProduct(id: string, input: UpdateProductInput): Promise<Product> {
  const product = await prisma.product.findUnique({ where: { id } });

  if (!product) {
    throw new Error('Product not found');
  }

  // If product has Stripe integration, update Stripe product too
  if (product.stripeProductId && (input.name || input.description)) {
    try {
      const idempotencyKey = generateIdempotencyKey('update-product', product.stripeProductId);
      await stripe.products.update(
        product.stripeProductId,
        {
          name: input.name,
          description: input.description,
        },
        { idempotencyKey }
      );
    } catch (error) {
      logger.warn('Failed to update Stripe product', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  return prisma.product.update({
    where: { id },
    data: input,
  });
}

export async function deleteProduct(id: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id },
    include: { licenses: true },
  });

  if (product?.licenses.length) {
    throw new Error('Cannot delete product with active licenses');
  }

  if (product?.stripeProductId) {
    try {
      const idempotencyKey = generateIdempotencyKey('archive-product', product.stripeProductId);
      await stripe.products.update(
        product.stripeProductId,
        { active: false },
        { idempotencyKey }
      );
    } catch (error) {
      logger.warn('Failed to archive Stripe product', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  await prisma.product.delete({ where: { id } });
}

export async function linkStripeProduct(
  productId: string,
  stripeProductId: string,
  stripePriceId: string
): Promise<Product> {
  return prisma.product.update({
    where: { id: productId },
    data: { stripeProductId, stripePriceId },
  });
}

/**
 * Create a metered price for an existing product
 */
export async function createMeteredPrice(
  productId: string,
  options: {
    unitAmount: number;
    currency?: string;
    interval?: 'month' | 'year';
    aggregateUsage?: 'sum' | 'last_during_period' | 'last_ever' | 'max';
    taxBehavior?: 'exclusive' | 'inclusive' | 'unspecified';
  }
): Promise<Product> {
  const product = await prisma.product.findUnique({ where: { id: productId } });

  if (!product) {
    throw new Error('Product not found');
  }

  if (!product.stripeProductId) {
    throw new Error('Product does not have a Stripe product linked');
  }

  const idempotencyKey = generateIdempotencyKey('create-metered-price', product.stripeProductId);

  const stripePrice = await stripe.prices.create(
    {
      product: product.stripeProductId,
      unit_amount: options.unitAmount,
      currency: options.currency || 'usd',
      recurring: {
        interval: options.interval || 'month',
        usage_type: 'metered',
        aggregate_usage: options.aggregateUsage || 'sum',
      },
      tax_behavior: options.taxBehavior,
    },
    { idempotencyKey }
  );

  return prisma.product.update({
    where: { id: productId },
    data: {
      stripePriceId: stripePrice.id,
      pricingType: 'METERED',
    },
  });
}

/**
 * Update the tax code for a product
 */
export async function updateProductTaxCode(productId: string, taxCode: string): Promise<Product> {
  const product = await prisma.product.findUnique({ where: { id: productId } });

  if (!product) {
    throw new Error('Product not found');
  }

  if (!product.stripeProductId) {
    throw new Error('Product does not have a Stripe product linked');
  }

  const idempotencyKey = generateIdempotencyKey('update-tax-code', product.stripeProductId);

  await stripe.products.update(
    product.stripeProductId,
    { tax_code: taxCode },
    { idempotencyKey }
  );

  return product;
}

/**
 * List common tax codes for software products
 */
export function getCommonTaxCodes(): Array<{ code: string; name: string; description: string }> {
  return [
    {
      code: 'txcd_10000000',
      name: 'General - Tangible Goods',
      description: 'General category for physical goods',
    },
    {
      code: 'txcd_10103001',
      name: 'Software - SaaS',
      description: 'Software as a Service subscriptions',
    },
    {
      code: 'txcd_10103002',
      name: 'Software - Downloaded',
      description: 'Downloadable software products',
    },
    {
      code: 'txcd_10103003',
      name: 'Software - Pre-written',
      description: 'Pre-written, non-customized software',
    },
    {
      code: 'txcd_10103004',
      name: 'Software - Custom',
      description: 'Custom software development',
    },
    {
      code: 'txcd_10401000',
      name: 'Digital Goods',
      description: 'General digital goods category',
    },
  ];
}

/**
 * Get Stripe product pricing info
 */
export async function getStripePricingInfo(productId: string): Promise<{
  priceId: string;
  unitAmount: number;
  currency: string;
  interval?: string;
  isMetered: boolean;
  taxBehavior?: string;
} | null> {
  const product = await prisma.product.findUnique({ where: { id: productId } });

  if (!product?.stripePriceId) {
    return null;
  }

  try {
    const price = await stripe.prices.retrieve(product.stripePriceId);

    return {
      priceId: price.id,
      unitAmount: price.unit_amount || 0,
      currency: price.currency,
      interval: price.recurring?.interval,
      isMetered: price.recurring?.usage_type === 'metered',
      taxBehavior: price.tax_behavior || undefined,
    };
  } catch (error) {
    logger.error('Failed to retrieve Stripe price:', error);
    return null;
  }
}
