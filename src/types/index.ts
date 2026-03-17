import { Request } from 'express';
import { Customer } from '@prisma/client';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    isAdmin: boolean;
    cognitoSub?: string;
    groups?: string[];
  };
  token?: string;
  tokenPayload?: {
    id: string;
    email: string;
    isAdmin: boolean;
    jti?: string;
    iat?: number;
    exp?: number;
  };
}

export interface LicenseValidationRequest {
  licenseKey: string;
  machineFingerprint?: string;
  productId?: string;
}

export interface LicenseValidationResponse {
  valid: boolean;
  product?: string;
  expiresAt?: string;
  features?: string[];
  error?: string;
}

export interface LicenseActivationRequest {
  licenseKey: string;
  machineFingerprint: string;
  machineName?: string;
}

export interface CreateCheckoutRequest {
  productId: string;
  customerId?: string;
  customerEmail?: string;
}

export interface OfflineLicensePayload {
  licenseId: string;
  productId: string;
  customerId: string;
  features: string[];
  expiresAt: string | null;
  issuedAt: string;
  gracePeriodDays: number;
}

export type CustomerWithoutPassword = Omit<Customer, 'passwordHash'>;
