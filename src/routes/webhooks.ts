import { Router, Request, Response } from 'express';
import { stripe } from '../config/stripe.js';
import { config } from '../config/index.js';
import * as paymentService from '../services/payment.service.js';
import { webhookRateLimit } from '../middleware/rateLimit.js';
import { logger } from '../services/logger.service.js';
import Stripe from 'stripe';

const router = Router();

// Track processed webhook events to prevent duplicates (in-memory, use Redis in production)
const processedEvents = new Map<string, number>();
const EVENT_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Cleanup old processed events every hour
setInterval(() => {
  const now = Date.now();
  for (const [eventId, timestamp] of processedEvents.entries()) {
    if (now - timestamp > EVENT_TTL) {
      processedEvents.delete(eventId);
    }
  }
}, 60 * 60 * 1000);

router.post(
  '/stripe',
  webhookRateLimit,
  async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'];

    if (!sig) {
      res.status(400).json({ error: 'Missing stripe-signature header' });
      return;
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        config.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      logger.error('Webhook signature verification failed', error);
      res.status(400).json({ error: 'Webhook signature verification failed' });
      return;
    }

    logger.info('Received Stripe webhook', { eventType: event.type, eventId: event.id });

    // Idempotency check - skip already processed events
    if (processedEvents.has(event.id)) {
      logger.debug('Webhook event already processed, skipping', { eventId: event.id });
      res.json({ received: true, duplicate: true });
      return;
    }

    try {
      switch (event.type) {
        // =====================================================================
        // CHECKOUT EVENTS
        // =====================================================================
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          await paymentService.handleCheckoutCompleted(session);
          break;
        }

        // =====================================================================
        // SUBSCRIPTION EVENTS
        // =====================================================================
        case 'customer.subscription.created': {
          const subscription = event.data.object as Stripe.Subscription;
          logger.info('New subscription created', { subscriptionId: subscription.id });
          await paymentService.handleSubscriptionUpdated(subscription);
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription;
          await paymentService.handleSubscriptionUpdated(subscription);
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;
          await paymentService.handleSubscriptionDeleted(subscription);
          break;
        }

        case 'customer.subscription.trial_will_end': {
          const subscription = event.data.object as Stripe.Subscription;
          await paymentService.handleTrialWillEnd(subscription);
          break;
        }

        case 'customer.subscription.paused': {
          const subscription = event.data.object as Stripe.Subscription;
          logger.info('Subscription paused', { subscriptionId: subscription.id });
          await paymentService.handleSubscriptionUpdated(subscription);
          break;
        }

        case 'customer.subscription.resumed': {
          const subscription = event.data.object as Stripe.Subscription;
          logger.info('Subscription resumed', { subscriptionId: subscription.id });
          await paymentService.handleSubscriptionUpdated(subscription);
          break;
        }

        // =====================================================================
        // INVOICE EVENTS
        // =====================================================================
        case 'invoice.payment_succeeded': {
          const invoice = event.data.object as Stripe.Invoice;
          logger.info('Invoice payment succeeded', { invoiceId: invoice.id });
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice;
          await paymentService.handleInvoicePaymentFailed(invoice);
          break;
        }

        case 'invoice.upcoming': {
          const invoice = event.data.object as Stripe.Invoice;
          logger.info('Upcoming invoice', { subscriptionId: invoice.subscription });
          break;
        }

        // =====================================================================
        // CHARGE & REFUND EVENTS
        // =====================================================================
        case 'charge.refunded': {
          const charge = event.data.object as Stripe.Charge;
          await paymentService.handleChargeRefunded(charge);
          break;
        }

        case 'charge.dispute.created': {
          const dispute = event.data.object as Stripe.Dispute;
          logger.warn('Dispute created', { chargeId: dispute.charge, disputeId: dispute.id });
          break;
        }

        case 'charge.dispute.closed': {
          const dispute = event.data.object as Stripe.Dispute;
          logger.info('Dispute closed', { chargeId: dispute.charge, status: dispute.status });
          break;
        }

        // =====================================================================
        // CUSTOMER EVENTS
        // =====================================================================
        case 'customer.created': {
          const customer = event.data.object as Stripe.Customer;
          logger.debug('Customer created in Stripe', { stripeCustomerId: customer.id });
          break;
        }

        case 'customer.updated': {
          const customer = event.data.object as Stripe.Customer;
          logger.debug('Customer updated in Stripe', { stripeCustomerId: customer.id });
          break;
        }

        case 'customer.deleted': {
          const customer = event.data.object as Stripe.Customer;
          logger.debug('Customer deleted in Stripe', { stripeCustomerId: customer.id });
          break;
        }

        // =====================================================================
        // PAYMENT METHOD EVENTS
        // =====================================================================
        case 'payment_method.attached': {
          const paymentMethod = event.data.object as Stripe.PaymentMethod;
          logger.debug('Payment method attached', { customerId: paymentMethod.customer });
          break;
        }

        case 'payment_method.detached': {
          const paymentMethod = event.data.object as Stripe.PaymentMethod;
          logger.debug('Payment method detached', { paymentMethodId: paymentMethod.id });
          break;
        }

        // =====================================================================
        // TAX EVENTS (when using Stripe Tax)
        // =====================================================================
        case 'tax.settings.updated': {
          logger.info('Tax settings updated');
          break;
        }

        // =====================================================================
        // DEFAULT
        // =====================================================================
        default:
          logger.debug('Unhandled event type', { eventType: event.type });
      }

      // Mark event as processed to prevent duplicate handling
      processedEvents.set(event.id, Date.now());
      res.json({ received: true });
    } catch (error) {
      logger.error('Error handling webhook', error, { eventType: event.type });
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  }
);

export default router;
