import { Router, Request, Response } from 'express';
import { stripe } from '../config/stripe.js';
import { config } from '../config/index.js';
import * as paymentService from '../services/payment.service.js';
import Stripe from 'stripe';

const router = Router();

router.post(
  '/stripe',
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
      console.error('Webhook signature verification failed:', error);
      res.status(400).json({ error: 'Webhook signature verification failed' });
      return;
    }

    console.log(`Received Stripe webhook: ${event.type}`);

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
          // Handle subscription creation (useful for logging/analytics)
          const subscription = event.data.object as Stripe.Subscription;
          console.log(`New subscription created: ${subscription.id}`);
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
          // Trial ending soon (default: 3 days before)
          const subscription = event.data.object as Stripe.Subscription;
          await paymentService.handleTrialWillEnd(subscription);
          break;
        }

        case 'customer.subscription.paused': {
          // Subscription paused (for payment collection pause feature)
          const subscription = event.data.object as Stripe.Subscription;
          console.log(`Subscription paused: ${subscription.id}`);
          await paymentService.handleSubscriptionUpdated(subscription);
          break;
        }

        case 'customer.subscription.resumed': {
          // Subscription resumed after pause
          const subscription = event.data.object as Stripe.Subscription;
          console.log(`Subscription resumed: ${subscription.id}`);
          await paymentService.handleSubscriptionUpdated(subscription);
          break;
        }

        // =====================================================================
        // INVOICE EVENTS
        // =====================================================================
        case 'invoice.payment_succeeded': {
          // Payment successful - can be used for notifications
          const invoice = event.data.object as Stripe.Invoice;
          console.log(`Invoice payment succeeded: ${invoice.id}`);
          // Subscription will be updated via customer.subscription.updated
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice;
          await paymentService.handleInvoicePaymentFailed(invoice);
          break;
        }

        case 'invoice.upcoming': {
          // Invoice will be created soon (useful for notifications)
          const invoice = event.data.object as Stripe.Invoice;
          console.log(`Upcoming invoice for subscription: ${invoice.subscription}`);
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
          // Chargeback/dispute initiated
          const dispute = event.data.object as Stripe.Dispute;
          console.warn(`Dispute created for charge: ${dispute.charge}`);
          // You may want to suspend the license until dispute is resolved
          break;
        }

        case 'charge.dispute.closed': {
          // Dispute resolved
          const dispute = event.data.object as Stripe.Dispute;
          console.log(`Dispute closed for charge: ${dispute.charge}, status: ${dispute.status}`);
          break;
        }

        // =====================================================================
        // CUSTOMER EVENTS
        // =====================================================================
        case 'customer.created': {
          const customer = event.data.object as Stripe.Customer;
          console.log(`Customer created in Stripe: ${customer.id}`);
          break;
        }

        case 'customer.updated': {
          const customer = event.data.object as Stripe.Customer;
          console.log(`Customer updated in Stripe: ${customer.id}`);
          break;
        }

        case 'customer.deleted': {
          const customer = event.data.object as Stripe.Customer;
          console.log(`Customer deleted in Stripe: ${customer.id}`);
          break;
        }

        // =====================================================================
        // PAYMENT METHOD EVENTS
        // =====================================================================
        case 'payment_method.attached': {
          const paymentMethod = event.data.object as Stripe.PaymentMethod;
          console.log(`Payment method attached to customer: ${paymentMethod.customer}`);
          break;
        }

        case 'payment_method.detached': {
          const paymentMethod = event.data.object as Stripe.PaymentMethod;
          console.log(`Payment method detached: ${paymentMethod.id}`);
          break;
        }

        // =====================================================================
        // TAX EVENTS (when using Stripe Tax)
        // =====================================================================
        case 'tax.settings.updated': {
          console.log('Tax settings updated');
          break;
        }

        // =====================================================================
        // DEFAULT
        // =====================================================================
        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      console.error(`Error handling webhook ${event.type}:`, error);
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  }
);

export default router;
