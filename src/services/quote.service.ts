import { prisma } from '../config/database.js';
import { Quote, QuoteStatus, LicenseTerm, Prisma } from '@prisma/client';
import { generateLicenseKey } from '../utils/license-key.js';
import * as emailService from './email.service.js';
import { logger } from './logger.service.js';

export interface CreateQuoteInput {
  productId: string;
  contactEmail: string;
  contactName?: string;
  companyName?: string;
  customerId?: string;
  seatCount: number;
  term?: LicenseTerm;
  termYears?: number;
  discount?: number;
  customFeatures?: string[];
  notes?: string;
  validDays?: number;
}

export interface QuoteWithProduct extends Quote {
  product?: {
    id: string;
    name: string;
    priceMonthly: number | null;
    priceAnnual: number | null;
    seatPriceMonthly: number | null;
    seatPriceAnnual: number | null;
  };
}

/**
 * Generate a unique quote number
 */
function generateQuoteNumber(): string {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `Q${year}${month}-${random}`;
}

/**
 * Calculate quote pricing
 */
async function calculatePricing(
  productId: string,
  seatCount: number,
  term: LicenseTerm,
  termYears: number,
  discount?: number
): Promise<{ basePrice: number; finalPrice: number }> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  });

  if (!product) {
    throw new Error('Product not found');
  }

  let basePrice = 0;

  // Calculate base price based on seat pricing or product pricing
  if (product.seatPriceAnnual && term !== 'SUBSCRIPTION') {
    // Per-seat annual pricing
    basePrice = product.seatPriceAnnual * seatCount * termYears;
  } else if (product.seatPriceMonthly) {
    // Per-seat monthly pricing (convert to annual)
    basePrice = product.seatPriceMonthly * seatCount * 12 * termYears;
  } else if (product.priceAnnual && term !== 'SUBSCRIPTION') {
    // Flat annual pricing
    basePrice = product.priceAnnual * termYears;
  } else if (product.priceMonthly) {
    // Flat monthly pricing (convert to annual)
    basePrice = product.priceMonthly * 12 * termYears;
  }

  // Apply volume discounts
  let autoDiscount = 0;
  if (seatCount >= 50) {
    autoDiscount = 0.25; // 25% for 50+ seats
  } else if (seatCount >= 20) {
    autoDiscount = 0.15; // 15% for 20+ seats
  } else if (seatCount >= 10) {
    autoDiscount = 0.10; // 10% for 10+ seats
  }

  // Apply multi-year discount
  if (termYears >= 3) {
    autoDiscount += 0.10; // Additional 10% for 3+ years
  } else if (termYears >= 2) {
    autoDiscount += 0.05; // Additional 5% for 2 years
  }

  // Use the higher of auto discount or manual discount
  const effectiveDiscount = Math.max(autoDiscount, discount || 0);

  const finalPrice = Math.round(basePrice * (1 - effectiveDiscount));

  return { basePrice, finalPrice };
}

/**
 * Create a new quote
 */
export async function createQuote(input: CreateQuoteInput): Promise<Quote> {
  const term = input.term || 'SUBSCRIPTION';
  const termYears = input.termYears || 1;

  const { basePrice, finalPrice } = await calculatePricing(
    input.productId,
    input.seatCount,
    term,
    termYears,
    input.discount
  );

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + (input.validDays || 30));

  const quote = await prisma.quote.create({
    data: {
      quoteNumber: generateQuoteNumber(),
      productId: input.productId,
      customerId: input.customerId,
      contactEmail: input.contactEmail,
      contactName: input.contactName,
      companyName: input.companyName,
      seatCount: input.seatCount,
      term,
      termYears,
      basePrice,
      discount: input.discount ? new Prisma.Decimal(input.discount) : null,
      finalPrice,
      customFeatures: input.customFeatures || [],
      notes: input.notes,
      validUntil,
    },
  });

  return quote;
}

/**
 * Get quote by ID
 */
export async function getQuoteById(id: string): Promise<QuoteWithProduct | null> {
  return prisma.quote.findUnique({
    where: { id },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          priceMonthly: true,
          priceAnnual: true,
          seatPriceMonthly: true,
          seatPriceAnnual: true,
        },
      },
    },
  }) as Promise<QuoteWithProduct | null>;
}

/**
 * Get quote by quote number
 */
export async function getQuoteByNumber(quoteNumber: string): Promise<QuoteWithProduct | null> {
  return prisma.quote.findUnique({
    where: { quoteNumber },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          priceMonthly: true,
          priceAnnual: true,
          seatPriceMonthly: true,
          seatPriceAnnual: true,
        },
      },
    },
  }) as Promise<QuoteWithProduct | null>;
}

/**
 * List quotes with filters
 */
export async function listQuotes(filters?: {
  status?: QuoteStatus;
  customerId?: string;
  productId?: string;
}): Promise<QuoteWithProduct[]> {
  return prisma.quote.findMany({
    where: {
      status: filters?.status,
      customerId: filters?.customerId,
      productId: filters?.productId,
    },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          priceMonthly: true,
          priceAnnual: true,
          seatPriceMonthly: true,
          seatPriceAnnual: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  }) as Promise<QuoteWithProduct[]>;
}

/**
 * Update quote status
 */
export async function updateQuoteStatus(
  id: string,
  status: QuoteStatus
): Promise<Quote> {
  const updateData: Prisma.QuoteUpdateInput = { status };

  if (status === 'ACCEPTED') {
    updateData.acceptedAt = new Date();
  }

  return prisma.quote.update({
    where: { id },
    data: updateData,
  });
}

/**
 * Send quote to customer
 */
export async function sendQuote(id: string): Promise<{ success: boolean; error?: string }> {
  const quote = await getQuoteById(id);

  if (!quote) {
    return { success: false, error: 'Quote not found' };
  }

  if (quote.status !== 'DRAFT') {
    return { success: false, error: 'Quote has already been sent' };
  }

  try {
    // Get quote with product details
    const quoteWithProduct = await prisma.quote.findUnique({
      where: { id },
      include: { product: { select: { name: true } } },
    });

    if (!quoteWithProduct || !quoteWithProduct.product) {
      return { success: false, error: 'Quote or product not found' };
    }

    // Generate accept URL
    const baseUrl = process.env.APP_URL || process.env.PUBLIC_URL || 'https://licensing.agencio.cloud';
    const acceptUrl = `${baseUrl}/quote/${quoteWithProduct.quoteNumber}/accept`;

    // Send quote email
    await emailService.sendQuoteEmail(
      quoteWithProduct.contactEmail,
      quoteWithProduct.contactName || undefined,
      quoteWithProduct.quoteNumber,
      quoteWithProduct.product.name,
      quoteWithProduct.seatCount,
      quoteWithProduct.termYears,
      quoteWithProduct.finalPrice,
      quoteWithProduct.currency,
      quoteWithProduct.validUntil.toISOString().split('T')[0],
      acceptUrl
    );

    await prisma.quote.update({
      where: { id },
      data: { status: 'SENT' },
    });

    return { success: true };
  } catch (error) {
    logger.error('Failed to send quote:', error);
    return { success: false, error: 'Failed to send quote email' };
  }
}

/**
 * Convert quote to license
 */
export async function convertQuoteToLicense(
  quoteId: string,
  customerId: string
): Promise<{
  success: boolean;
  licenseId?: string;
  licenseKey?: string;
  error?: string;
}> {
  const quote = await getQuoteById(quoteId);

  if (!quote) {
    return { success: false, error: 'Quote not found' };
  }

  if (quote.status === 'CONVERTED') {
    return { success: false, error: 'Quote has already been converted' };
  }

  if (quote.status === 'EXPIRED' || quote.validUntil < new Date()) {
    return { success: false, error: 'Quote has expired' };
  }

  // Calculate expiration based on term
  let expiresAt: Date | null = null;
  if (quote.term === 'SUBSCRIPTION' || quote.term === 'MULTI_YEAR') {
    expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + quote.termYears);
  }
  // PERPETUAL licenses don't expire

  // Create the license
  const licenseKey = generateLicenseKey();

  const license = await prisma.license.create({
    data: {
      key: licenseKey,
      customerId,
      productId: quote.productId,
      status: 'ACTIVE',
      expiresAt,
      maxActivations: quote.seatCount,
      licenseType: quote.seatCount > 1 ? 'TEAM' : 'INDIVIDUAL',
      seatCount: quote.seatCount,
      seatsUsed: 0,
      isVolumeLicense: quote.seatCount >= 10,
      volumeDiscount: quote.discount,
      licenseTerm: quote.term,
      renewalDate: expiresAt,
      metadata: {
        quoteId: quote.id,
        quoteNumber: quote.quoteNumber,
        companyName: quote.companyName,
        customFeatures: quote.customFeatures,
      },
    },
  });

  // Update quote status
  await prisma.quote.update({
    where: { id: quoteId },
    data: {
      status: 'CONVERTED',
      acceptedAt: new Date(),
      convertedLicenseId: license.id,
    },
  });

  return {
    success: true,
    licenseId: license.id,
    licenseKey,
  };
}

/**
 * Check and expire old quotes
 */
export async function expireOldQuotes(): Promise<number> {
  const result = await prisma.quote.updateMany({
    where: {
      status: { in: ['DRAFT', 'SENT', 'VIEWED'] },
      validUntil: { lt: new Date() },
    },
    data: { status: 'EXPIRED' },
  });

  return result.count;
}

/**
 * Duplicate a quote (for revision)
 */
export async function duplicateQuote(id: string): Promise<Quote> {
  const original = await getQuoteById(id);

  if (!original) {
    throw new Error('Quote not found');
  }

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + 30);

  return prisma.quote.create({
    data: {
      quoteNumber: generateQuoteNumber(),
      productId: original.productId,
      customerId: original.customerId,
      contactEmail: original.contactEmail,
      contactName: original.contactName,
      companyName: original.companyName,
      seatCount: original.seatCount,
      term: original.term,
      termYears: original.termYears,
      basePrice: original.basePrice,
      discount: original.discount,
      finalPrice: original.finalPrice,
      customFeatures: original.customFeatures,
      notes: `Revised from ${original.quoteNumber}`,
      validUntil,
      status: 'DRAFT',
    },
  });
}
