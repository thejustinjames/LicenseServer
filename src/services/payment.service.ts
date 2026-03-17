import { stripe } from '../config/stripe.js';
import { prisma } from '../config/database.js';
import { config } from '../config/index.js';
import * as customerService from './customer.service.js';
import * as licenseService from './license.service.js';
import * as productService from './product.service.js';
import Stripe from 'stripe';

export interface CreateCheckoutSessionInput {
  productId: string;
  customerId?: string;
  customerEmail?: string;
  successUrl?: string;
  cancelUrl?: string;
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

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [
      {
        price: product.stripePriceId,
        quantity: 1,
      },
    ],
    customer: stripeCustomerId,
    customer_email: stripeCustomerId ? undefined : input.customerEmail,
    success_url: input.successUrl || config.STRIPE_SUCCESS_URL,
    cancel_url: input.cancelUrl || config.STRIPE_CANCEL_URL,
    metadata: {
      productId: product.id,
    },
  });

  if (!session.url) {
    throw new Error('Failed to create checkout session');
  }

  return session.url;
}

export async function createBillingPortalSession(customerId: string): Promise<string> {
  const customer = await customerService.getCustomerById(customerId);

  if (!customer?.stripeCustomerId) {
    throw new Error('Customer does not have a Stripe account');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customer.stripeCustomerId,
    return_url: config.STRIPE_SUCCESS_URL,
  });

  return session.url;
}

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
    },
    update: {
      status: 'ACTIVE',
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
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
    },
    update: {
      status,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
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

  if (!subscriptionId) {
    return;
  }

  await prisma.subscription.update({
    where: { stripeSubscriptionId: subscriptionId },
    data: { status: 'PAST_DUE' },
  });

  await licenseService.suspendLicensesForSubscription(subscriptionId);
}

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

export async function getSubscriptionsByCustomerId(customerId: string) {
  return prisma.subscription.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
  });
}
