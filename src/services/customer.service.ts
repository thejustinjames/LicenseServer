import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database.js';
import { stripe } from '../config/stripe.js';
import { config } from '../config/index.js';
import { Customer } from '@prisma/client';
import type { CustomerWithoutPassword } from '../types/index.js';
import * as emailService from './email.service.js';

const SALT_ROUNDS = 12;

export interface CreateCustomerInput {
  email: string;
  password: string;
  name?: string;
  isAdmin?: boolean;
}

export interface UpdateCustomerInput {
  email?: string;
  name?: string;
  password?: string;
}

function omitPassword(customer: Customer): CustomerWithoutPassword {
  const { passwordHash, ...rest } = customer;
  return rest;
}

export async function createCustomer(input: CreateCustomerInput): Promise<CustomerWithoutPassword> {
  const existingCustomer = await prisma.customer.findUnique({
    where: { email: input.email },
  });

  if (existingCustomer) {
    throw new Error('Customer with this email already exists');
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  let stripeCustomerId: string | undefined;
  try {
    const stripeCustomer = await stripe.customers.create({
      email: input.email,
      name: input.name,
    });
    stripeCustomerId = stripeCustomer.id;
  } catch (error) {
    console.warn('Failed to create Stripe customer:', error instanceof Error ? error.message : error);
  }

  const customer = await prisma.customer.create({
    data: {
      email: input.email,
      passwordHash,
      name: input.name,
      isAdmin: input.isAdmin || false,
      stripeCustomerId,
    },
  });

  // Send welcome email (don't await - fire and forget)
  if (!input.isAdmin) {
    emailService.sendWelcomeEmail(customer.email, customer.name || undefined).catch((err) => {
      console.error('Failed to send welcome email:', err);
    });
  }

  return omitPassword(customer);
}

export async function getCustomerById(id: string): Promise<CustomerWithoutPassword | null> {
  const customer = await prisma.customer.findUnique({
    where: { id },
  });

  return customer ? omitPassword(customer) : null;
}

export async function getCustomerByEmail(email: string): Promise<Customer | null> {
  return prisma.customer.findUnique({
    where: { email },
  });
}

export async function getCustomerByStripeId(stripeCustomerId: string): Promise<CustomerWithoutPassword | null> {
  const customer = await prisma.customer.findUnique({
    where: { stripeCustomerId },
  });

  return customer ? omitPassword(customer) : null;
}

export async function listCustomers(): Promise<CustomerWithoutPassword[]> {
  const customers = await prisma.customer.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return customers.map(omitPassword);
}

export async function updateCustomer(id: string, input: UpdateCustomerInput): Promise<CustomerWithoutPassword> {
  const data: Record<string, unknown> = {};

  if (input.email) data.email = input.email;
  if (input.name) data.name = input.name;
  if (input.password) {
    data.passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
  }

  const customer = await prisma.customer.update({
    where: { id },
    data,
  });

  return omitPassword(customer);
}

export async function deleteCustomer(id: string): Promise<void> {
  const customer = await prisma.customer.findUnique({
    where: { id },
  });

  if (customer?.stripeCustomerId) {
    try {
      await stripe.customers.del(customer.stripeCustomerId);
    } catch (error) {
      console.warn('Failed to delete Stripe customer:', error instanceof Error ? error.message : error);
    }
  }

  await prisma.customer.delete({ where: { id } });
}

export async function authenticateCustomer(email: string, password: string): Promise<{ customer: CustomerWithoutPassword; token: string } | null> {
  const customer = await prisma.customer.findUnique({
    where: { email },
  });

  // Constant-time comparison to prevent timing attacks
  // Always perform bcrypt comparison even for non-existent users
  const dummyHash = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.SQyf6Vn6Qq.Sjy';
  const hashToCompare = customer?.passwordHash || dummyHash;
  const isValid = await bcrypt.compare(password, hashToCompare);

  if (!customer || !isValid) {
    return null;
  }

  const token = jwt.sign(
    { id: customer.id, email: customer.email, isAdmin: customer.isAdmin },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );

  return { customer: omitPassword(customer), token };
}

export async function createOrGetCustomerByEmail(email: string, name?: string): Promise<CustomerWithoutPassword> {
  let customer = await prisma.customer.findUnique({
    where: { email },
  });

  if (customer) {
    return omitPassword(customer);
  }

  let stripeCustomerId: string | undefined;
  try {
    const stripeCustomer = await stripe.customers.create({
      email,
      name,
    });
    stripeCustomerId = stripeCustomer.id;
  } catch (error) {
    console.warn('Failed to create Stripe customer:', error instanceof Error ? error.message : error);
  }

  const temporaryPassword = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(temporaryPassword, SALT_ROUNDS);

  customer = await prisma.customer.create({
    data: {
      email,
      passwordHash,
      name,
      stripeCustomerId,
    },
  });

  return omitPassword(customer);
}

export async function ensureAdminExists(): Promise<void> {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
    return;
  }

  const existingAdmin = await prisma.customer.findUnique({
    where: { email: config.ADMIN_EMAIL },
  });

  if (existingAdmin) {
    return;
  }

  console.log('Creating initial admin user...');
  await createCustomer({
    email: config.ADMIN_EMAIL,
    password: config.ADMIN_PASSWORD,
    name: 'Admin',
    isAdmin: true,
  });
  console.log('Admin user created successfully');
}
