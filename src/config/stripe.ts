import Stripe from 'stripe';
import { config } from './index.js';

export const stripe = new Stripe(config.STRIPE_SECRET_KEY);
