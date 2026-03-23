import { stripe } from '../config/stripe.js';
import { prisma } from '../config/database.js';
import { config } from '../config/index.js';
import * as customerService from './customer.service.js';
import * as licenseService from './license.service.js';
import * as productService from './product.service.js';
import * as emailService from './email.service.js';
import { logger } from './logger.service.js';
import Stripe from 'stripe';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// IDEMPOTENCY KEY GENERATION
// ============================================================================

/**
 * Generate an idempotency key for Stripe API calls
 * Format: {operation}-{resourceId}-{timestamp}
 */
function generateIdempotencyKey(operation: string, resourceId?: string): string {
  const id = resourceId || uuidv4();
  return `${operation}-${id}-${Date.now()}`;
}

/**
 * Generate a deterministic idempotency key for retryable operations
 * This ensures the same key is used for retries of the same logical operation
 */
function generateDeterministicKey(operation: string, ...parts: string[]): string {
  return `${operation}-${parts.join('-')}`;
}

// ============================================================================
// CHECKOUT SESSION CREATION
// ============================================================================

export interface CreateCheckoutSessionInput {
  productId: string;
  customerId?: string;
  customerEmail?: string;
  successUrl?: string;
  cancelUrl?: string;
  quantity?: number;
  trialPeriodDays?: number;
  promotionCode?: string;
  billingInterval?: 'monthly' | 'annual';
  metadata?: Record<string, string>;
}

export async function createCheckoutSession(input: CreateCheckoutSessionInput): Promise<string> {
  const product = await productService.getProductById(input.productId);

  if (!product) {
    throw new Error('Product not found');
  }

  // Determine the price ID based on billing interval
  let priceId: string | null = null;
  if (input.billingInterval === 'annual' && product.stripePriceIdAnnual) {
    priceId = product.stripePriceIdAnnual;
  } else {
    priceId = product.stripePriceId;
  }

  if (!priceId) {
    throw new Error('Product does not have a Stripe price configured');
  }

  let stripeCustomerId: string | undefined;

  if (input.customerId) {
    const customer = await customerService.getCustomerById(input.customerId);
    stripeCustomerId = customer?.stripeCustomerId || undefined;
  }

  // Determine if this is a one-time purchase or subscription
  const isOneTime = product.purchaseType === 'ONE_TIME';
  const isMetered = product.pricingType === 'METERED';

  // Build line items
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price: priceId,
      // Don't pass quantity for metered billing
      ...(isMetered ? {} : { quantity: input.quantity || 1 }),
    },
  ];

  // Build session params
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: isOneTime ? 'payment' : 'subscription',
    payment_method_types: ['card'],
    line_items: lineItems,
    customer: stripeCustomerId,
    customer_email: stripeCustomerId ? undefined : input.customerEmail,
    success_url: `${input.successUrl || config.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: input.cancelUrl || config.STRIPE_CANCEL_URL,
    billing_address_collection: config.STRIPE_BILLING_ADDRESS_COLLECTION as 'auto' | 'required',
    metadata: {
      productId: product.id,
      purchaseType: product.purchaseType,
      billingInterval: input.billingInterval || 'monthly',
    },
  };

  // Add subscription-specific data
  if (!isOneTime) {
    const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
      metadata: {
        productId: product.id,
        ...input.metadata,
      },
    };

    // Add trial period if configured (only for subscriptions)
    const trialDays = input.trialPeriodDays ||
      (config.STRIPE_TRIAL_PERIOD_DAYS ? parseInt(config.STRIPE_TRIAL_PERIOD_DAYS, 10) : undefined);

    if (trialDays && trialDays > 0) {
      subscriptionData.trial_period_days = trialDays;
    }

    sessionParams.subscription_data = subscriptionData;
  } else {
    // For one-time payments, add payment intent data
    sessionParams.payment_intent_data = {
      metadata: {
        productId: product.id,
        ...input.metadata,
      },
    };
  }

  // Enable automatic tax if configured
  if (config.STRIPE_TAX_ENABLED === 'true') {
    sessionParams.automatic_tax = { enabled: true };
    // Tax calculation requires customer location
    if (!isOneTime) {
      sessionParams.customer_update = {
        address: 'auto',
        name: 'auto',
      };
    }
  }

  // Add promotion code if provided
  if (input.promotionCode) {
    sessionParams.discounts = [{ promotion_code: input.promotionCode }];
  } else {
    sessionParams.allow_promotion_codes = true;
  }

  // Create session with idempotency key
  const idempotencyKey = generateIdempotencyKey('checkout', input.customerId || input.customerEmail);

  const session = await stripe.checkout.sessions.create(sessionParams, {
    idempotencyKey,
  });

  if (!session.url) {
    throw new Error('Failed to create checkout session');
  }

  return session.url;
}

// ============================================================================
// BILLING PORTAL
// ============================================================================

export async function createBillingPortalSession(customerId: string): Promise<string> {
  const customer = await customerService.getCustomerById(customerId);

  if (!customer?.stripeCustomerId) {
    throw new Error('Customer does not have a Stripe account');
  }

  const idempotencyKey = generateIdempotencyKey('portal', customerId);

  const session = await stripe.billingPortal.sessions.create({
    customer: customer.stripeCustomerId,
    return_url: config.STRIPE_SUCCESS_URL,
  }, {
    idempotencyKey,
  });

  return session.url;
}

// ============================================================================
// WEBHOOK HANDLERS
// ============================================================================

export async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const customerEmail = session.customer_details?.email;
  const stripeCustomerId = session.customer as string;
  const productId = session.metadata?.productId;
  const purchaseType = session.metadata?.purchaseType || 'SUBSCRIPTION';
  const subscriptionId = session.subscription as string | null;

  if (!customerEmail || !productId) {
    logger.error('Missing customer email or product ID in checkout session');
    return;
  }

  // Find or create customer
  let customer = await prisma.customer.findUnique({
    where: { stripeCustomerId },
  });

  if (!customer) {
    customer = await prisma.customer.findUnique({
      where: { email: customerEmail },
    });

    if (customer) {
      await prisma.customer.update({
        where: { id: customer.id },
        data: { stripeCustomerId },
      });
    }
  }

  if (!customer) {
    const tempPassword = crypto.randomUUID();
    const bcrypt = await import('bcrypt');
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    customer = await prisma.customer.create({
      data: {
        email: customerEmail,
        passwordHash,
        name: session.customer_details?.name,
        stripeCustomerId,
      },
    });
  }

  const product = await productService.getProductById(productId);
  if (!product) {
    logger.error('Product not found:', productId);
    return;
  }

  // Handle subscription purchases
  if (purchaseType === 'SUBSCRIPTION' && subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    await prisma.subscription.upsert({
      where: { stripeSubscriptionId: subscriptionId },
      create: {
        customerId: customer.id,
        stripeSubscriptionId: subscriptionId,
        status: 'ACTIVE',
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
      update: {
        status: 'ACTIVE',
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
    });
  }

  // Calculate license expiration
  let expiresAt: Date | undefined;
  if (product.licenseDurationDays) {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + product.licenseDurationDays);
  } else if (purchaseType === 'ONE_TIME') {
    // One-time purchases get perpetual licenses (no expiration) unless duration is set
    expiresAt = undefined;
  }

  // Create license for the customer
  const license = await licenseService.createLicense({
    customerId: customer.id,
    productId: product.id,
    expiresAt,
  });

  // Send license activated email
  await emailService.sendLicenseActivatedEmail(
    customer.email,
    customer.name || undefined,
    product.name,
    license.key
  );
}

export async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const stripeSubscriptionId = subscription.id;
  const status = mapStripeStatus(subscription.status);

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId },
    create: {
      customerId: '', // This will be filled if it doesn't exist
      stripeSubscriptionId,
      status,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    },
    update: {
      status,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    },
  });

  if (status === 'ACTIVE') {
    const dbSubscription = await prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
    });

    if (dbSubscription) {
      await prisma.license.updateMany({
        where: {
          customerId: dbSubscription.customerId,
          status: 'SUSPENDED',
        },
        data: { status: 'ACTIVE' },
      });
    }
  }
}

export async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const stripeSubscriptionId = subscription.id;

  await prisma.subscription.update({
    where: { stripeSubscriptionId },
    data: { status: 'CANCELED' },
  });

  await licenseService.expireLicensesForSubscription(stripeSubscriptionId);
}

export async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const subscriptionId = invoice.subscription as string;
  const stripeCustomerId = invoice.customer as string;

  if (!subscriptionId) {
    return;
  }

  await prisma.subscription.update({
    where: { stripeSubscriptionId: subscriptionId },
    data: { status: 'PAST_DUE' },
  });

  await licenseService.suspendLicensesForSubscription(subscriptionId);

  // Send payment failed notification email
  if (stripeCustomerId) {
    const customer = await prisma.customer.findUnique({
      where: { stripeCustomerId },
    });

    if (customer) {
      // Get product name from subscription metadata or invoice
      const productName = invoice.lines?.data?.[0]?.description || 'your subscription';

      // Create billing portal URL for the customer
      try {
        const portalUrl = await createBillingPortalSession(customer.id);
        await emailService.sendPaymentFailedEmail(
          customer.email,
          customer.name || undefined,
          productName,
          portalUrl
        );
      } catch (error) {
        logger.error('Failed to send payment failed email:', error);
      }
    }
  }
}

/**
 * Handle charge.refunded webhook
 * Revokes licenses when a charge is fully refunded
 */
export async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const refundAmount = charge.amount_refunded;
  const isFullRefund = charge.refunded;
  const stripeCustomerId = charge.customer as string;

  if (!stripeCustomerId) {
    logger.info('Refund processed for guest checkout, no customer to update');
    return;
  }

  // Find the customer
  const customer = await prisma.customer.findUnique({
    where: { stripeCustomerId },
  });

  if (!customer) {
    logger.error('Customer not found for refund:', stripeCustomerId);
    return;
  }

  // Fetch refunds from Stripe API (webhook payload may not include expanded refunds)
  let refunds: Stripe.Refund[] = [];
  try {
    const refundList = await stripe.refunds.list({
      charge: charge.id,
      limit: 100,
    });
    refunds = refundList.data;
  } catch (error) {
    logger.error('Failed to fetch refunds from Stripe:', error);
    // Fall back to charge.refunds if available
    refunds = charge.refunds?.data || [];
  }

  for (const refund of refunds) {
    // Check if we've already processed this refund
    const existingRefund = await prisma.refund.findUnique({
      where: { stripeRefundId: refund.id },
    });

    if (existingRefund) {
      continue;
    }

    // Record the refund
    await prisma.refund.create({
      data: {
        stripeRefundId: refund.id,
        stripeChargeId: charge.id,
        customerId: customer.id,
        amount: refund.amount,
        currency: refund.currency,
        reason: refund.reason || undefined,
        status: refund.status || 'succeeded',
        licensesRevoked: isFullRefund,
      },
    });

    logger.info(`Recorded refund ${refund.id} for ${refund.amount} ${refund.currency}`);
  }

  // If fully refunded, revoke all active licenses for this customer
  if (isFullRefund) {
    logger.info(`Full refund processed for customer ${customer.id}, revoking licenses`);

    await prisma.license.updateMany({
      where: {
        customerId: customer.id,
        status: 'ACTIVE',
      },
      data: { status: 'REVOKED' },
    });
  } else {
    logger.info(`Partial refund of ${refundAmount} cents processed for customer ${customer.id}`);
  }

  // Send refund notification email
  await emailService.sendRefundProcessedEmail(
    customer.email,
    customer.name || undefined,
    refundAmount,
    charge.currency,
    isFullRefund
  );
}

/**
 * Handle customer.subscription.trial_will_end webhook
 * Triggers 3 days before trial ends (configurable in Stripe)
 */
export async function handleTrialWillEnd(subscription: Stripe.Subscription): Promise<void> {
  const stripeSubscriptionId = subscription.id;
  const stripeCustomerId = subscription.customer as string;
  const trialEnd = subscription.trial_end;

  if (!trialEnd) {
    return;
  }

  const customer = await prisma.customer.findUnique({
    where: { stripeCustomerId },
  });

  if (!customer) {
    logger.error('Customer not found for trial ending:', stripeCustomerId);
    return;
  }

  const trialEndDate = new Date(trialEnd * 1000);
  const daysRemaining = Math.ceil((trialEndDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  logger.info(`Trial ending for customer ${customer.id} in ${daysRemaining} days`);

  // Update subscription with trial end info
  await prisma.subscription.update({
    where: { stripeSubscriptionId },
    data: {
      trialEnd: trialEndDate,
    },
  });

  // Get product name for the email
  const productId = subscription.metadata?.productId;
  let productName = 'your subscription';
  if (productId) {
    const product = await productService.getProductById(productId);
    if (product) {
      productName = product.name;
    }
  }

  // Send trial ending notification email
  await emailService.sendTrialEndingEmail(
    customer.email,
    customer.name || undefined,
    productName,
    daysRemaining
  );
}

// ============================================================================
// USAGE-BASED BILLING
// ============================================================================

export interface ReportUsageInput {
  subscriptionId: string;
  quantity: number;
  action?: 'increment' | 'set';
  timestamp?: Date;
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

/**
 * Report usage for a metered subscription
 */
export async function reportUsage(input: ReportUsageInput): Promise<{ success: boolean; usageRecordId?: string; error?: string }> {
  const subscription = await prisma.subscription.findUnique({
    where: { id: input.subscriptionId },
  });

  if (!subscription) {
    return { success: false, error: 'Subscription not found' };
  }

  // Get the subscription from Stripe to find the subscription item
  const stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);

  if (!stripeSubscription.items.data.length) {
    return { success: false, error: 'No subscription items found' };
  }

  // Get the first subscription item (assumes single product subscription)
  const subscriptionItemId = stripeSubscription.items.data[0].id;

  // Generate idempotency key if not provided
  const idempotencyKey = input.idempotencyKey ||
    generateDeterministicKey('usage', input.subscriptionId, input.timestamp?.toISOString() || new Date().toISOString());

  // Check if we've already recorded this usage
  const existingRecord = await prisma.usageRecord.findUnique({
    where: { idempotencyKey },
  });

  if (existingRecord) {
    return {
      success: true,
      usageRecordId: existingRecord.stripeUsageRecordId || undefined,
    };
  }

  try {
    // Report usage to Stripe
    const usageRecord = await stripe.subscriptionItems.createUsageRecord(
      subscriptionItemId,
      {
        quantity: input.quantity,
        action: input.action || 'increment',
        timestamp: input.timestamp ? Math.floor(input.timestamp.getTime() / 1000) : 'now',
      },
      {
        idempotencyKey,
      }
    );

    // Store the usage record locally
    await prisma.usageRecord.create({
      data: {
        subscriptionId: subscription.id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        quantity: input.quantity,
        action: input.action || 'increment',
        timestamp: input.timestamp || new Date(),
        idempotencyKey,
        stripeUsageRecordId: usageRecord.id,
        metadata: input.metadata || undefined,
      },
    });

    return { success: true, usageRecordId: usageRecord.id };
  } catch (error) {
    logger.error('Failed to report usage:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to report usage',
    };
  }
}

/**
 * Get usage records for a subscription
 */
export async function getUsageRecords(subscriptionId: string, options?: {
  startDate?: Date;
  endDate?: Date;
  limit?: number;
}) {
  return prisma.usageRecord.findMany({
    where: {
      subscriptionId,
      ...(options?.startDate || options?.endDate ? {
        timestamp: {
          ...(options.startDate ? { gte: options.startDate } : {}),
          ...(options.endDate ? { lte: options.endDate } : {}),
        },
      } : {}),
    },
    orderBy: { timestamp: 'desc' },
    take: options?.limit || 100,
  });
}

/**
 * Get usage summary from Stripe for a subscription
 */
export async function getUsageSummary(subscriptionId: string): Promise<{
  totalUsage: number;
  currentPeriodUsage: number;
  subscriptionItemId: string;
} | null> {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
  });

  if (!subscription) {
    return null;
  }

  const stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);

  if (!stripeSubscription.items.data.length) {
    return null;
  }

  const subscriptionItem = stripeSubscription.items.data[0];

  // Get usage record summaries from Stripe
  const summaries = await stripe.subscriptionItems.listUsageRecordSummaries(
    subscriptionItem.id,
    { limit: 1 }
  );

  const currentSummary = summaries.data[0];

  return {
    totalUsage: currentSummary?.total_usage || 0,
    currentPeriodUsage: currentSummary?.total_usage || 0,
    subscriptionItemId: subscriptionItem.id,
  };
}

// ============================================================================
// TAX HELPERS
// ============================================================================

/**
 * Calculate tax for a price using Stripe Tax
 */
export async function calculateTax(priceId: string, customerAddress: {
  country: string;
  state?: string;
  postalCode?: string;
}): Promise<{
  taxAmount: number;
  taxRate: number;
  taxBehavior: string;
} | null> {
  if (config.STRIPE_TAX_ENABLED !== 'true') {
    return null;
  }

  try {
    // Use Stripe's tax calculation API
    const calculation = await stripe.tax.calculations.create({
      currency: 'usd',
      line_items: [
        {
          amount: 0, // Will be calculated from price
          reference: priceId,
        },
      ],
      customer_details: {
        address: {
          country: customerAddress.country,
          state: customerAddress.state,
          postal_code: customerAddress.postalCode,
        },
        address_source: 'billing',
      },
    });

    return {
      taxAmount: calculation.tax_amount_exclusive,
      taxRate: calculation.tax_breakdown?.[0]?.tax_rate_details?.percentage_decimal
        ? parseFloat(calculation.tax_breakdown[0].tax_rate_details.percentage_decimal)
        : 0,
      taxBehavior: config.STRIPE_TAX_BEHAVIOR,
    };
  } catch (error) {
    logger.error('Tax calculation failed:', error);
    return null;
  }
}

// ============================================================================
// SUBSCRIPTION MANAGEMENT
// ============================================================================

export async function getSubscriptionsByCustomerId(customerId: string) {
  return prisma.subscription.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
    include: {
      usageRecords: {
        orderBy: { timestamp: 'desc' },
        take: 10,
      },
    },
  });
}

/**
 * Cancel a subscription at period end
 */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
  });

  if (!subscription) {
    throw new Error('Subscription not found');
  }

  const idempotencyKey = generateIdempotencyKey('cancel', subscriptionId);

  await stripe.subscriptions.update(
    subscription.stripeSubscriptionId,
    { cancel_at_period_end: true },
    { idempotencyKey }
  );

  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { cancelAtPeriodEnd: true },
  });
}

/**
 * Reactivate a subscription that was set to cancel
 */
export async function reactivateSubscription(subscriptionId: string): Promise<void> {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
  });

  if (!subscription) {
    throw new Error('Subscription not found');
  }

  const idempotencyKey = generateIdempotencyKey('reactivate', subscriptionId);

  await stripe.subscriptions.update(
    subscription.stripeSubscriptionId,
    { cancel_at_period_end: false },
    { idempotencyKey }
  );

  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { cancelAtPeriodEnd: false },
  });
}

/**
 * Get all refunds for a customer
 */
export async function getRefundsByCustomerId(customerId: string) {
  return prisma.refund.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function mapStripeStatus(status: Stripe.Subscription.Status): 'ACTIVE' | 'CANCELED' | 'PAST_DUE' {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'ACTIVE';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'CANCELED';
    case 'past_due':
    case 'incomplete':
    case 'paused':
      return 'PAST_DUE';
    default:
      return 'PAST_DUE';
  }
}

// ============================================================================
// COUPON & PROMOTION CODE MANAGEMENT
// ============================================================================

export interface CreateCouponInput {
  name: string;
  percentOff?: number;
  amountOff?: number;
  currency?: string;
  duration: 'once' | 'repeating' | 'forever';
  durationInMonths?: number;
  maxRedemptions?: number;
  redeemBy?: Date;
  appliesTo?: string[]; // Product IDs
}

export interface CreatePromotionCodeInput {
  couponId: string;
  code: string;
  maxRedemptions?: number;
  expiresAt?: Date;
  firstTimeTransaction?: boolean;
  minimumAmount?: number;
  minimumAmountCurrency?: string;
}

/**
 * Create a new coupon in Stripe
 */
export async function createCoupon(input: CreateCouponInput): Promise<Stripe.Coupon> {
  const idempotencyKey = generateIdempotencyKey('coupon', input.name);

  const params: Stripe.CouponCreateParams = {
    name: input.name,
    duration: input.duration,
  };

  if (input.percentOff) {
    params.percent_off = input.percentOff;
  } else if (input.amountOff) {
    params.amount_off = input.amountOff;
    params.currency = input.currency || 'usd';
  }

  if (input.duration === 'repeating' && input.durationInMonths) {
    params.duration_in_months = input.durationInMonths;
  }

  if (input.maxRedemptions) {
    params.max_redemptions = input.maxRedemptions;
  }

  if (input.redeemBy) {
    params.redeem_by = Math.floor(input.redeemBy.getTime() / 1000);
  }

  if (input.appliesTo && input.appliesTo.length > 0) {
    // Get Stripe product IDs from our product IDs
    const products = await prisma.product.findMany({
      where: { id: { in: input.appliesTo } },
      select: { stripeProductId: true },
    });
    const stripeProductIds = products
      .map(p => p.stripeProductId)
      .filter((id): id is string => id !== null);

    if (stripeProductIds.length > 0) {
      params.applies_to = { products: stripeProductIds };
    }
  }

  return stripe.coupons.create(params, { idempotencyKey });
}

/**
 * Create a promotion code for a coupon (the code customers actually enter)
 */
export async function createPromotionCode(input: CreatePromotionCodeInput): Promise<Stripe.PromotionCode> {
  const idempotencyKey = generateIdempotencyKey('promo', input.code);

  const params: Stripe.PromotionCodeCreateParams = {
    coupon: input.couponId,
    code: input.code,
  };

  if (input.maxRedemptions) {
    params.max_redemptions = input.maxRedemptions;
  }

  if (input.expiresAt) {
    params.expires_at = Math.floor(input.expiresAt.getTime() / 1000);
  }

  if (input.firstTimeTransaction) {
    params.restrictions = {
      ...params.restrictions,
      first_time_transaction: true,
    };
  }

  if (input.minimumAmount) {
    params.restrictions = {
      ...params.restrictions,
      minimum_amount: input.minimumAmount,
      minimum_amount_currency: input.minimumAmountCurrency || 'usd',
    };
  }

  return stripe.promotionCodes.create(params, { idempotencyKey });
}

/**
 * List all coupons
 */
export async function listCoupons(options?: {
  limit?: number;
  startingAfter?: string;
}): Promise<Stripe.ApiList<Stripe.Coupon>> {
  return stripe.coupons.list({
    limit: options?.limit || 20,
    starting_after: options?.startingAfter,
  });
}

/**
 * Get a coupon by ID
 */
export async function getCoupon(couponId: string): Promise<Stripe.Coupon> {
  return stripe.coupons.retrieve(couponId);
}

/**
 * Update a coupon (only name and metadata can be updated)
 */
export async function updateCoupon(couponId: string, data: {
  name?: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.Coupon> {
  const idempotencyKey = generateIdempotencyKey('update-coupon', couponId);
  return stripe.coupons.update(couponId, data, { idempotencyKey });
}

/**
 * Delete a coupon
 */
export async function deleteCoupon(couponId: string): Promise<Stripe.DeletedCoupon> {
  return stripe.coupons.del(couponId);
}

/**
 * List all promotion codes
 */
export async function listPromotionCodes(options?: {
  couponId?: string;
  active?: boolean;
  limit?: number;
  startingAfter?: string;
}): Promise<Stripe.ApiList<Stripe.PromotionCode>> {
  return stripe.promotionCodes.list({
    coupon: options?.couponId,
    active: options?.active,
    limit: options?.limit || 20,
    starting_after: options?.startingAfter,
  });
}

/**
 * Get a promotion code by ID
 */
export async function getPromotionCode(promoCodeId: string): Promise<Stripe.PromotionCode> {
  return stripe.promotionCodes.retrieve(promoCodeId);
}

/**
 * Update a promotion code (can deactivate)
 */
export async function updatePromotionCode(promoCodeId: string, data: {
  active?: boolean;
  metadata?: Record<string, string>;
}): Promise<Stripe.PromotionCode> {
  const idempotencyKey = generateIdempotencyKey('update-promo', promoCodeId);
  return stripe.promotionCodes.update(promoCodeId, data, { idempotencyKey });
}

/**
 * Validate a promotion code
 */
export async function validatePromotionCode(code: string): Promise<{
  valid: boolean;
  promotionCode?: Stripe.PromotionCode;
  error?: string;
}> {
  try {
    const promoCodes = await stripe.promotionCodes.list({
      code,
      active: true,
      limit: 1,
    });

    if (promoCodes.data.length === 0) {
      return { valid: false, error: 'Invalid or expired promotion code' };
    }

    const promoCode = promoCodes.data[0];

    // Check if expired
    if (promoCode.expires_at && promoCode.expires_at < Date.now() / 1000) {
      return { valid: false, error: 'Promotion code has expired' };
    }

    // Check redemption limit
    if (promoCode.max_redemptions && promoCode.times_redeemed >= promoCode.max_redemptions) {
      return { valid: false, error: 'Promotion code has reached its redemption limit' };
    }

    return { valid: true, promotionCode: promoCode };
  } catch (error) {
    return { valid: false, error: 'Failed to validate promotion code' };
  }
}
