import { stripe } from '../config/stripe.js';
import { prisma } from '../config/database.js';
import { config } from '../config/index.js';
import * as customerService from './customer.service.js';
import * as licenseService from './license.service.js';
import * as productService from './product.service.js';
import * as emailService from './email.service.js';
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
  metadata?: Record<string, string>;
}

export async function createCheckoutSession(input: CreateCheckoutSessionInput): Promise<string> {
  const product = await productService.getProductById(input.productId);

  if (!product) {
    throw new Error('Product not found');
  }

  if (!product.stripePriceId) {
    throw new Error('Product does not have a Stripe price configured');
  }

  let stripeCustomerId: string | undefined;

  if (input.customerId) {
    const customer = await customerService.getCustomerById(input.customerId);
    stripeCustomerId = customer?.stripeCustomerId || undefined;
  }

  // Determine if this is a metered product (no quantity for usage-based)
  const isMetered = product.pricingType === 'METERED';

  // Build line items
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price: product.stripePriceId,
      // Don't pass quantity for metered billing
      ...(isMetered ? {} : { quantity: input.quantity || 1 }),
    },
  ];

  // Build subscription data
  const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
    metadata: {
      productId: product.id,
      ...input.metadata,
    },
  };

  // Add trial period if configured
  const trialDays = input.trialPeriodDays ||
    (config.STRIPE_TRIAL_PERIOD_DAYS ? parseInt(config.STRIPE_TRIAL_PERIOD_DAYS, 10) : undefined);

  if (trialDays && trialDays > 0) {
    subscriptionData.trial_period_days = trialDays;
  }

  // Build session params
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: lineItems,
    customer: stripeCustomerId,
    customer_email: stripeCustomerId ? undefined : input.customerEmail,
    success_url: `${input.successUrl || config.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: input.cancelUrl || config.STRIPE_CANCEL_URL,
    subscription_data: subscriptionData,
    billing_address_collection: config.STRIPE_BILLING_ADDRESS_COLLECTION as 'auto' | 'required',
    metadata: {
      productId: product.id,
    },
  };

  // Enable automatic tax if configured
  if (config.STRIPE_TAX_ENABLED === 'true') {
    sessionParams.automatic_tax = { enabled: true };
    // Tax calculation requires customer location
    sessionParams.customer_update = {
      address: 'auto',
      name: 'auto',
    };
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
  const subscriptionId = session.subscription as string;

  if (!customerEmail || !productId) {
    console.error('Missing customer email or product ID in checkout session');
    return;
  }

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
    console.error('Product not found:', productId);
    return;
  }

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

  let expiresAt: Date | undefined;
  if (product.licenseDurationDays) {
    expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + product.licenseDurationDays);
  }

  await licenseService.createLicense({
    customerId: customer.id,
    productId: product.id,
    expiresAt,
  });
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
        console.error('Failed to send payment failed email:', error);
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
    console.log('Refund processed for guest checkout, no customer to update');
    return;
  }

  // Find the customer
  const customer = await prisma.customer.findUnique({
    where: { stripeCustomerId },
  });

  if (!customer) {
    console.error('Customer not found for refund:', stripeCustomerId);
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
    console.error('Failed to fetch refunds from Stripe:', error);
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

    console.log(`Recorded refund ${refund.id} for ${refund.amount} ${refund.currency}`);
  }

  // If fully refunded, revoke all active licenses for this customer
  if (isFullRefund) {
    console.log(`Full refund processed for customer ${customer.email}, revoking licenses`);

    await prisma.license.updateMany({
      where: {
        customerId: customer.id,
        status: 'ACTIVE',
      },
      data: { status: 'REVOKED' },
    });
  } else {
    console.log(`Partial refund of ${refundAmount} cents processed for customer ${customer.email}`);
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
    console.error('Customer not found for trial ending:', stripeCustomerId);
    return;
  }

  const trialEndDate = new Date(trialEnd * 1000);
  const daysRemaining = Math.ceil((trialEndDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  console.log(`Trial ending for customer ${customer.email} in ${daysRemaining} days`);

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
    console.error('Failed to report usage:', error);
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
    console.error('Tax calculation failed:', error);
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
