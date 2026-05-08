/**
 * Credit Service
 * Manages AI credit balances, transactions, and purchases
 */

import { prisma } from '../config/database.js';
import { stripe } from '../config/stripe.js';
import { config } from '../config/index.js';
import { logger } from './logger.service.js';
import { CreditTransactionType, CreditTransactionStatus, Prisma } from '@prisma/client';
import { v4 as uuid } from 'uuid';
import Stripe from 'stripe';

// =============================================================================
// TYPES
// =============================================================================

export interface CreditBalanceResponse {
  available: number;
  reserved: number;
  effective: number;
  lifetime: {
    purchased: number;
    consumed: number;
    bonus: number;
    refunded: number;
  };
  autoRefill: {
    enabled: boolean;
    amount: number | null;
    trigger: number | null;
    packageId: string | null;
    maxCount: number;
    currentCount: number;
    requiresReauth: boolean;
    paymentMethodLast4: string | null;
  };
  lowBalanceAlertCents: number;
}

export interface ReservationResult {
  success: boolean;
  reservationId: string;
  amountReserved: number;
  available: number;
  error?: string;
}

export interface ConsumptionResult {
  success: boolean;
  newBalance: number;
  transactionId: string;
  autoRefillTriggered: boolean;
}

// =============================================================================
// CREDIT BALANCE MANAGEMENT
// =============================================================================

/**
 * Get or create credit balance for customer
 */
export async function getOrCreateCreditBalance(customerId: string): Promise<CreditBalanceResponse> {
  let balance = await prisma.creditBalance.findUnique({
    where: { customerId },
    include: { autoRefillPackage: true },
  });

  if (!balance) {
    balance = await prisma.creditBalance.create({
      data: { customerId },
      include: { autoRefillPackage: true },
    });
  }

  // Get payment method last 4 if set
  let paymentMethodLast4: string | null = null;
  if (balance.autoRefillPaymentMethodId) {
    try {
      const pm = await stripe.paymentMethods.retrieve(balance.autoRefillPaymentMethodId);
      paymentMethodLast4 = pm.card?.last4 || null;
    } catch {
      // Payment method may be invalid
    }
  }

  return {
    available: balance.availableCents,
    reserved: balance.reservedCents,
    effective: balance.availableCents - balance.reservedCents,
    lifetime: {
      purchased: balance.totalPurchased,
      consumed: balance.totalConsumed,
      bonus: balance.totalBonus,
      refunded: balance.totalRefunded,
    },
    autoRefill: {
      enabled: balance.autoRefillEnabled,
      amount: balance.autoRefillAmountCents,
      trigger: balance.autoRefillTriggerCents,
      packageId: balance.autoRefillPackageId,
      maxCount: balance.autoRefillMaxCount,
      currentCount: balance.autoRefillCurrentCount,
      requiresReauth: balance.autoRefillCurrentCount >= balance.autoRefillMaxCount,
      paymentMethodLast4,
    },
    lowBalanceAlertCents: balance.lowBalanceAlertCents,
  };
}

/**
 * Check if customer has sufficient credits
 */
export async function checkCredits(
  customerId: string,
  requiredCents: number
): Promise<{ sufficient: boolean; available: number; required: number }> {
  const balance = await getOrCreateCreditBalance(customerId);
  return {
    sufficient: balance.effective >= requiredCents,
    available: balance.effective,
    required: requiredCents,
  };
}

// =============================================================================
// CREDIT RESERVATION (Prevents overdraft)
// =============================================================================

/**
 * Reserve credits before an AI operation
 * Prevents overdraft by reserving credits before the call is made
 */
export async function reserveCredits(
  customerId: string,
  amountCents: number,
  idempotencyKey: string
): Promise<ReservationResult> {
  // Check for existing reservation with same idempotency key
  const existing = await prisma.creditTransaction.findUnique({
    where: { idempotencyKey },
  });

  if (existing) {
    // Return existing reservation
    const reservationId = (existing.metadata as any)?.reservationId || existing.id;
    return {
      success: existing.status === CreditTransactionStatus.COMPLETED,
      reservationId,
      amountReserved: Math.abs(existing.amountCents),
      available: 0, // Would need to fetch balance
    };
  }

  return prisma.$transaction(async (tx) => {
    const balance = await tx.creditBalance.findUnique({
      where: { customerId },
    });

    if (!balance) {
      return {
        success: false,
        reservationId: '',
        amountReserved: 0,
        available: 0,
        error: 'Credit balance not found',
      };
    }

    const effective = balance.availableCents - balance.reservedCents;
    if (effective < amountCents) {
      return {
        success: false,
        reservationId: '',
        amountReserved: 0,
        available: effective,
        error: 'Insufficient credits',
      };
    }

    const reservationId = uuid();

    // Create reservation transaction
    await tx.creditTransaction.create({
      data: {
        creditBalanceId: balance.id,
        type: CreditTransactionType.RESERVATION,
        status: CreditTransactionStatus.COMPLETED,
        amountCents: -amountCents,
        balanceBefore: balance.availableCents,
        balanceAfter: balance.availableCents, // Available doesn't change, only reserved
        idempotencyKey,
        metadata: { reservationId },
      },
    });

    // Update reserved amount
    await tx.creditBalance.update({
      where: { id: balance.id },
      data: { reservedCents: balance.reservedCents + amountCents },
    });

    return {
      success: true,
      reservationId,
      amountReserved: amountCents,
      available: effective - amountCents,
    };
  });
}

/**
 * Release a reservation (call failed, credits not used)
 */
export async function releaseReservation(
  customerId: string,
  reservationId: string
): Promise<{ success: boolean; released: number }> {
  return prisma.$transaction(async (tx) => {
    // Find the reservation transaction
    const reservation = await tx.creditTransaction.findFirst({
      where: {
        creditBalance: { customerId },
        type: CreditTransactionType.RESERVATION,
        metadata: { path: ['reservationId'], equals: reservationId },
      },
      include: { creditBalance: true },
    });

    if (!reservation) {
      return { success: false, released: 0 };
    }

    const amountToRelease = Math.abs(reservation.amountCents);

    // Create release transaction
    await tx.creditTransaction.create({
      data: {
        creditBalanceId: reservation.creditBalanceId,
        type: CreditTransactionType.RELEASE,
        status: CreditTransactionStatus.COMPLETED,
        amountCents: amountToRelease,
        balanceBefore: reservation.creditBalance.availableCents,
        balanceAfter: reservation.creditBalance.availableCents,
        description: `Released reservation ${reservationId}`,
        metadata: { originalReservationId: reservationId },
      },
    });

    // Decrease reserved amount
    await tx.creditBalance.update({
      where: { id: reservation.creditBalanceId },
      data: {
        reservedCents: Math.max(0, reservation.creditBalance.reservedCents - amountToRelease),
      },
    });

    return { success: true, released: amountToRelease };
  });
}

// =============================================================================
// CREDIT CONSUMPTION
// =============================================================================

/**
 * Consume credits after successful AI operation
 * Converts a reservation to actual consumption
 */
export async function consumeCredits(
  customerId: string,
  reservationId: string,
  actualAmountCents: number,
  usage: {
    externalCallId?: string;
    model?: string;
    provider?: string;
    inputTokens?: number;
    outputTokens?: number;
  }
): Promise<ConsumptionResult> {
  return prisma.$transaction(async (tx) => {
    const balance = await tx.creditBalance.findUnique({
      where: { customerId },
    });

    if (!balance) {
      throw new Error('Credit balance not found');
    }

    // Find reservation to get reserved amount
    const reservation = await tx.creditTransaction.findFirst({
      where: {
        creditBalanceId: balance.id,
        type: CreditTransactionType.RESERVATION,
        metadata: { path: ['reservationId'], equals: reservationId },
      },
    });

    const reservedAmount = reservation ? Math.abs(reservation.amountCents) : actualAmountCents;

    // Create consumption transaction
    const transaction = await tx.creditTransaction.create({
      data: {
        creditBalanceId: balance.id,
        type: CreditTransactionType.CONSUMPTION,
        status: CreditTransactionStatus.COMPLETED,
        amountCents: -actualAmountCents,
        balanceBefore: balance.availableCents,
        balanceAfter: balance.availableCents - actualAmountCents,
        externalCallId: usage.externalCallId,
        model: usage.model,
        provider: usage.provider,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        metadata: { reservationId },
      },
    });

    // Update balance
    const updated = await tx.creditBalance.update({
      where: { id: balance.id },
      data: {
        availableCents: balance.availableCents - actualAmountCents,
        reservedCents: Math.max(0, balance.reservedCents - reservedAmount),
        totalConsumed: balance.totalConsumed + actualAmountCents,
      },
    });

    // Check if auto-refill is needed
    let autoRefillTriggered = false;
    if (await shouldTriggerAutoRefill(updated)) {
      autoRefillTriggered = await triggerAutoRefill(tx, updated);
    }

    return {
      success: true,
      newBalance: updated.availableCents,
      transactionId: transaction.id,
      autoRefillTriggered,
    };
  });
}

// =============================================================================
// CREDIT PURCHASE
// =============================================================================

/**
 * Add purchased credits to customer balance
 */
export async function addPurchasedCredits(
  customerId: string,
  amountCents: number,
  bonusCents: number,
  payment: {
    stripePaymentIntentId?: string;
    stripeChargeId?: string;
    packageId?: string;
  },
  idempotencyKey: string,
  transactionType: CreditTransactionType = CreditTransactionType.PURCHASE
): Promise<{ newBalance: number; transactionId: string }> {
  // Check for existing transaction with same idempotency key
  const existing = await prisma.creditTransaction.findUnique({
    where: { idempotencyKey },
  });

  if (existing) {
    const balance = await prisma.creditBalance.findFirst({
      where: { id: existing.creditBalanceId },
    });
    return {
      newBalance: balance?.availableCents || 0,
      transactionId: existing.id,
    };
  }

  return prisma.$transaction(async (tx) => {
    let balance = await tx.creditBalance.findUnique({
      where: { customerId },
    });

    if (!balance) {
      balance = await tx.creditBalance.create({
        data: { customerId },
      });
    }

    const totalAmount = amountCents + bonusCents;

    // Create purchase transaction
    const transaction = await tx.creditTransaction.create({
      data: {
        creditBalanceId: balance.id,
        type: transactionType,
        status: CreditTransactionStatus.COMPLETED,
        amountCents: amountCents,
        balanceBefore: balance.availableCents,
        balanceAfter: balance.availableCents + amountCents,
        stripePaymentIntentId: payment.stripePaymentIntentId,
        stripeChargeId: payment.stripeChargeId,
        packageId: payment.packageId,
        idempotencyKey,
      },
    });

    // Create bonus transaction if applicable
    if (bonusCents > 0) {
      await tx.creditTransaction.create({
        data: {
          creditBalanceId: balance.id,
          type: CreditTransactionType.BONUS,
          status: CreditTransactionStatus.COMPLETED,
          amountCents: bonusCents,
          balanceBefore: balance.availableCents + amountCents,
          balanceAfter: balance.availableCents + totalAmount,
          description: 'Purchase bonus',
        },
      });
    }

    // Update balance
    const updated = await tx.creditBalance.update({
      where: { id: balance.id },
      data: {
        availableCents: balance.availableCents + totalAmount,
        totalPurchased: balance.totalPurchased + amountCents,
        totalBonus: balance.totalBonus + bonusCents,
      },
    });

    // Reset auto-refill count on manual purchase
    if (transactionType === CreditTransactionType.PURCHASE) {
      await tx.creditBalance.update({
        where: { id: balance.id },
        data: {
          autoRefillCurrentCount: 0,
          autoRefillLastAuthAt: new Date(),
        },
      });
    }

    return {
      newBalance: updated.availableCents,
      transactionId: transaction.id,
    };
  });
}

/**
 * Create Stripe checkout session for credit purchase
 */
export async function createCreditCheckoutSession(
  customerId: string,
  packageId: string,
  successUrl: string,
  cancelUrl: string
): Promise<{ checkoutUrl: string; sessionId: string }> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
  });

  if (!customer) {
    throw new Error('Customer not found');
  }

  const pkg = await prisma.creditPackage.findUnique({
    where: { id: packageId, isActive: true },
  });

  if (!pkg) {
    throw new Error('Credit package not found or inactive');
  }

  // Create Stripe checkout session
  const session = await stripe.checkout.sessions.create({
    customer: customer.stripeCustomerId || undefined,
    customer_email: !customer.stripeCustomerId ? customer.email : undefined,
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: pkg.currency.toLowerCase(),
          unit_amount: pkg.priceCents,
          product_data: {
            name: pkg.name,
            description: pkg.description || `${pkg.creditAmountCents} credits${pkg.bonusCents > 0 ? ` + ${pkg.bonusCents} bonus` : ''}`,
          },
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      type: 'credit_purchase',
      customerId,
      packageId,
      creditAmount: pkg.creditAmountCents.toString(),
      bonusAmount: pkg.bonusCents.toString(),
    },
  });

  return {
    checkoutUrl: session.url!,
    sessionId: session.id,
  };
}

/**
 * Purchase credits directly with saved payment method
 */
export async function purchaseCreditsDirectly(
  customerId: string,
  packageId: string,
  paymentMethodId: string
): Promise<{ success: boolean; newBalance: number; transactionId: string; error?: string }> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
  });

  if (!customer?.stripeCustomerId) {
    return { success: false, newBalance: 0, transactionId: '', error: 'No Stripe customer' };
  }

  const pkg = await prisma.creditPackage.findUnique({
    where: { id: packageId, isActive: true },
  });

  if (!pkg) {
    return { success: false, newBalance: 0, transactionId: '', error: 'Package not found' };
  }

  const idempotencyKey = `credit-purchase:${customerId}:${packageId}:${Date.now()}`;

  try {
    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: pkg.priceCents,
        currency: pkg.currency.toLowerCase(),
        customer: customer.stripeCustomerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        metadata: {
          type: 'credit_purchase',
          customerId,
          packageId,
          creditAmount: pkg.creditAmountCents.toString(),
          bonusAmount: pkg.bonusCents.toString(),
        },
      },
      { idempotencyKey }
    );

    if (paymentIntent.status === 'succeeded') {
      const result = await addPurchasedCredits(
        customerId,
        pkg.creditAmountCents,
        pkg.bonusCents,
        {
          stripePaymentIntentId: paymentIntent.id,
          packageId,
        },
        `pi:${paymentIntent.id}`
      );

      return {
        success: true,
        newBalance: result.newBalance,
        transactionId: result.transactionId,
      };
    }

    return {
      success: false,
      newBalance: 0,
      transactionId: '',
      error: `Payment ${paymentIntent.status}`,
    };
  } catch (err: any) {
    logger.error('Direct credit purchase failed:', err);
    return {
      success: false,
      newBalance: 0,
      transactionId: '',
      error: err.message || 'Payment failed',
    };
  }
}

// =============================================================================
// AUTO-REFILL
// =============================================================================

/**
 * Configure auto-refill settings
 */
export async function configureAutoRefill(
  customerId: string,
  settings: {
    enabled: boolean;
    packageId?: string;
    triggerCents?: number;
    paymentMethodId?: string;
  }
): Promise<CreditBalanceResponse> {
  const balance = await prisma.creditBalance.findUnique({
    where: { customerId },
  });

  if (!balance) {
    throw new Error('Credit balance not found');
  }

  // Validate package if provided
  let amountCents: number | undefined;
  if (settings.packageId) {
    const pkg = await prisma.creditPackage.findUnique({
      where: { id: settings.packageId, isActive: true },
    });
    if (!pkg) {
      throw new Error('Credit package not found');
    }
    amountCents = pkg.creditAmountCents + pkg.bonusCents;
  }

  await prisma.creditBalance.update({
    where: { id: balance.id },
    data: {
      autoRefillEnabled: settings.enabled,
      autoRefillPackageId: settings.packageId || null,
      autoRefillAmountCents: amountCents || null,
      autoRefillTriggerCents: settings.triggerCents || null,
      autoRefillPaymentMethodId: settings.paymentMethodId || null,
      autoRefillCurrentCount: 0, // Reset count on reconfigure
      autoRefillLastAuthAt: new Date(),
    },
  });

  return getOrCreateCreditBalance(customerId);
}

/**
 * Check if auto-refill should trigger
 */
async function shouldTriggerAutoRefill(balance: any): Promise<boolean> {
  if (!balance.autoRefillEnabled) return false;
  if (!balance.autoRefillTriggerCents) return false;
  if (!balance.autoRefillPackageId) return false;
  if (!balance.autoRefillPaymentMethodId) return false;

  // Check if below trigger threshold
  if (balance.availableCents > balance.autoRefillTriggerCents) return false;

  // Check if max refills reached
  if (balance.autoRefillCurrentCount >= balance.autoRefillMaxCount) {
    logger.info(`Auto-refill blocked for customer - max count reached`, {
      customerId: balance.customerId,
      currentCount: balance.autoRefillCurrentCount,
      maxCount: balance.autoRefillMaxCount,
    });
    return false;
  }

  return true;
}

/**
 * Trigger auto-refill purchase
 */
async function triggerAutoRefill(
  tx: Prisma.TransactionClient,
  balance: any
): Promise<boolean> {
  try {
    const customer = await tx.customer.findFirst({
      where: { creditBalance: { id: balance.id } },
    });

    if (!customer?.stripeCustomerId) return false;

    const pkg = await tx.creditPackage.findUnique({
      where: { id: balance.autoRefillPackageId },
    });

    if (!pkg) return false;

    // Increment refill count first (prevents race conditions)
    await tx.creditBalance.update({
      where: { id: balance.id },
      data: { autoRefillCurrentCount: balance.autoRefillCurrentCount + 1 },
    });

    // Queue async payment (don't block the transaction)
    setImmediate(async () => {
      try {
        const result = await purchaseCreditsDirectly(
          customer.id,
          pkg.id,
          balance.autoRefillPaymentMethodId
        );

        if (!result.success) {
          logger.error('Auto-refill payment failed', {
            customerId: customer.id,
            error: result.error,
          });
          // TODO: Send notification to customer
        } else {
          logger.info('Auto-refill successful', {
            customerId: customer.id,
            amount: pkg.creditAmountCents + pkg.bonusCents,
            newBalance: result.newBalance,
          });
        }
      } catch (err) {
        logger.error('Auto-refill error', err);
      }
    });

    return true;
  } catch (err) {
    logger.error('Auto-refill trigger error', err);
    return false;
  }
}

// =============================================================================
// REFUNDS
// =============================================================================

/**
 * Refund credits (deduct from balance)
 */
export async function refundCredits(
  customerId: string,
  amountCents: number,
  stripeChargeId: string,
  reason?: string
): Promise<{ success: boolean; newBalance: number }> {
  return prisma.$transaction(async (tx) => {
    const balance = await tx.creditBalance.findUnique({
      where: { customerId },
    });

    if (!balance) {
      return { success: false, newBalance: 0 };
    }

    // Deduct the refunded amount (can go negative if user spent credits)
    const newAvailable = Math.max(0, balance.availableCents - amountCents);

    await tx.creditTransaction.create({
      data: {
        creditBalanceId: balance.id,
        type: CreditTransactionType.REFUND,
        status: CreditTransactionStatus.COMPLETED,
        amountCents: -amountCents,
        balanceBefore: balance.availableCents,
        balanceAfter: newAvailable,
        stripeChargeId,
        description: reason || 'Stripe refund',
      },
    });

    const updated = await tx.creditBalance.update({
      where: { id: balance.id },
      data: {
        availableCents: newAvailable,
        totalRefunded: balance.totalRefunded + amountCents,
      },
    });

    return { success: true, newBalance: updated.availableCents };
  });
}

// =============================================================================
// ADMIN ADJUSTMENTS
// =============================================================================

/**
 * Admin adjustment of credits
 */
export async function adjustCredits(
  customerId: string,
  amountCents: number,
  reason: string,
  adminId: string
): Promise<{ success: boolean; newBalance: number; transactionId: string }> {
  return prisma.$transaction(async (tx) => {
    let balance = await tx.creditBalance.findUnique({
      where: { customerId },
    });

    if (!balance) {
      balance = await tx.creditBalance.create({
        data: { customerId },
      });
    }

    const newAvailable = Math.max(0, balance.availableCents + amountCents);

    const transaction = await tx.creditTransaction.create({
      data: {
        creditBalanceId: balance.id,
        type: CreditTransactionType.ADJUSTMENT,
        status: CreditTransactionStatus.COMPLETED,
        amountCents,
        balanceBefore: balance.availableCents,
        balanceAfter: newAvailable,
        description: reason,
        metadata: { adminId },
      },
    });

    const updated = await tx.creditBalance.update({
      where: { id: balance.id },
      data: { availableCents: newAvailable },
    });

    return {
      success: true,
      newBalance: updated.availableCents,
      transactionId: transaction.id,
    };
  });
}

// =============================================================================
// TRANSACTION HISTORY
// =============================================================================

/**
 * Get transaction history
 */
export async function getTransactionHistory(
  customerId: string,
  options: {
    limit?: number;
    offset?: number;
    type?: CreditTransactionType;
  } = {}
): Promise<{
  transactions: any[];
  total: number;
  hasMore: boolean;
}> {
  const { limit = 50, offset = 0, type } = options;

  const balance = await prisma.creditBalance.findUnique({
    where: { customerId },
  });

  if (!balance) {
    return { transactions: [], total: 0, hasMore: false };
  }

  const where: Prisma.CreditTransactionWhereInput = {
    creditBalanceId: balance.id,
    ...(type ? { type } : {}),
  };

  const [transactions, total] = await Promise.all([
    prisma.creditTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      include: { package: { select: { name: true, badge: true } } },
    }),
    prisma.creditTransaction.count({ where }),
  ]);

  return {
    transactions,
    total,
    hasMore: offset + transactions.length < total,
  };
}

// =============================================================================
// CREDIT PACKAGES
// =============================================================================

/**
 * List active credit packages
 */
export async function listCreditPackages(): Promise<any[]> {
  return prisma.creditPackage.findMany({
    where: {
      isActive: true,
      OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
    },
    orderBy: { sortOrder: 'asc' },
  });
}

/**
 * Get a single credit package
 */
export async function getCreditPackage(packageId: string): Promise<any | null> {
  return prisma.creditPackage.findUnique({
    where: { id: packageId },
  });
}
