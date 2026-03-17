import { prisma } from '../config/database.js';
import { stripe } from '../config/stripe.js';
import { Product, ValidationMode } from '@prisma/client';

export interface CreateProductInput {
  name: string;
  description?: string;
  validationMode?: ValidationMode;
  licenseDurationDays?: number;
  s3PackageKey?: string;
  version?: string;
  features?: string[];
  createStripeProduct?: boolean;
  stripePriceAmount?: number;
  stripePriceCurrency?: string;
  stripePriceInterval?: 'month' | 'year';
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  validationMode?: ValidationMode;
  licenseDurationDays?: number | null;
  s3PackageKey?: string;
  version?: string;
  features?: string[];
}

export async function createProduct(input: CreateProductInput): Promise<Product> {
  let stripeProductId: string | undefined;
  let stripePriceId: string | undefined;

  if (input.createStripeProduct && input.stripePriceAmount) {
    const stripeProduct = await stripe.products.create({
      name: input.name,
      description: input.description,
    });
    stripeProductId = stripeProduct.id;

    const stripePrice = await stripe.prices.create({
      product: stripeProduct.id,
      unit_amount: input.stripePriceAmount,
      currency: input.stripePriceCurrency || 'usd',
      recurring: input.stripePriceInterval
        ? { interval: input.stripePriceInterval }
        : undefined,
    });
    stripePriceId = stripePrice.id;
  }

  return prisma.product.create({
    data: {
      name: input.name,
      description: input.description,
      validationMode: input.validationMode || 'ONLINE',
      licenseDurationDays: input.licenseDurationDays,
      s3PackageKey: input.s3PackageKey,
      version: input.version,
      features: input.features || [],
      stripeProductId,
      stripePriceId,
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

export async function listProducts(): Promise<Product[]> {
  return prisma.product.findMany({
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateProduct(id: string, input: UpdateProductInput): Promise<Product> {
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
    await stripe.products.update(product.stripeProductId, { active: false });
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
