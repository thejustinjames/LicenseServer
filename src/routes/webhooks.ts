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
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          await paymentService.handleCheckoutCompleted(session);
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

        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice;
          await paymentService.handleInvoicePaymentFailed(invoice);
          break;
        }

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
