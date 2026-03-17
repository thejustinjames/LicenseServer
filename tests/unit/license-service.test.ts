import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma
vi.mock('../../src/config/database.js', () => ({
  prisma: {
    license: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    licenseActivation: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    subscription: {
      findUnique: vi.fn(),
    },
  },
}));

// Mock email service
vi.mock('../../src/services/email.service.js', () => ({
  sendLicenseActivatedEmail: vi.fn().mockResolvedValue(true),
}));

// Mock license key validation to always return true for test keys
vi.mock('../../src/utils/license-key.js', async () => {
  const actual = await vi.importActual('../../src/utils/license-key.js');
  return {
    ...actual,
    validateLicenseKeyFormat: vi.fn().mockReturnValue(true),
  };
});

import { prisma } from '../../src/config/database.js';
import * as licenseService from '../../src/services/license.service.js';

describe('License Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createLicense', () => {
    it('should create a license with a generated key', async () => {
      const mockLicense = {
        id: 'test-id',
        key: 'ABCD-EFGH-IJKL-MNOP',
        customerId: 'customer-1',
        productId: 'product-1',
        status: 'ACTIVE',
        maxActivations: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.license.create).mockResolvedValue(mockLicense as any);

      const result = await licenseService.createLicense({
        customerId: 'customer-1',
        productId: 'product-1',
      });

      expect(prisma.license.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          customerId: 'customer-1',
          productId: 'product-1',
          maxActivations: 1,
          key: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/),
        }),
      });
      expect(result.id).toBe('test-id');
    });

    it('should use custom maxActivations if provided', async () => {
      const mockLicense = {
        id: 'test-id',
        key: 'ABCD-EFGH-IJKL-MNOP',
        customerId: 'customer-1',
        productId: 'product-1',
        status: 'ACTIVE',
        maxActivations: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.license.create).mockResolvedValue(mockLicense as any);

      await licenseService.createLicense({
        customerId: 'customer-1',
        productId: 'product-1',
        maxActivations: 5,
      });

      expect(prisma.license.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          maxActivations: 5,
        }),
      });
    });
  });

  describe('validateLicense', () => {
    it('should return valid for active license', async () => {
      const mockLicense = {
        id: 'test-id',
        key: 'ABCD-EFGH-IJKL-MNOP',
        status: 'ACTIVE',
        expiresAt: null,
        maxActivations: 3,
        activations: [],
        product: {
          id: 'product-1',
          name: 'Test Product',
          features: ['feature1', 'feature2'],
        },
        customer: {
          id: 'customer-1',
          email: 'test@example.com',
          name: 'Test User',
        },
      };

      vi.mocked(prisma.license.findUnique).mockResolvedValue(mockLicense as any);
      vi.mocked(prisma.license.update).mockResolvedValue(mockLicense as any);

      const result = await licenseService.validateLicense('ABCD-EFGH-IJKL-MNOP');

      expect(result.valid).toBe(true);
      expect(result.product).toBe('Test Product');
      expect(result.features).toEqual(['feature1', 'feature2']);
    });

    it('should return invalid for revoked license', async () => {
      const mockLicense = {
        id: 'test-id',
        key: 'ABCD-EFGH-IJKL-MNOP',
        status: 'REVOKED',
        expiresAt: null,
        maxActivations: 3,
        activations: [],
        product: {
          id: 'product-1',
          name: 'Test Product',
          features: [],
        },
        customer: {
          id: 'customer-1',
          email: 'test@example.com',
          name: 'Test User',
        },
      };

      vi.mocked(prisma.license.findUnique).mockResolvedValue(mockLicense as any);

      const result = await licenseService.validateLicense('ABCD-EFGH-IJKL-MNOP');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('License has been revoked');
    });

    it('should return invalid for expired license', async () => {
      const mockLicense = {
        id: 'test-id',
        key: 'ABCD-EFGH-IJKL-MNOP',
        status: 'ACTIVE',
        expiresAt: new Date('2020-01-01'), // Expired
        maxActivations: 3,
        activations: [],
        product: {
          id: 'product-1',
          name: 'Test Product',
          features: [],
        },
        customer: {
          id: 'customer-1',
          email: 'test@example.com',
          name: 'Test User',
        },
      };

      vi.mocked(prisma.license.findUnique).mockResolvedValue(mockLicense as any);

      const result = await licenseService.validateLicense('ABCD-EFGH-IJKL-MNOP');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('License has expired');
    });

    it('should return invalid for non-existent license', async () => {
      vi.mocked(prisma.license.findUnique).mockResolvedValue(null);

      const result = await licenseService.validateLicense('XXXX-XXXX-XXXX-XXXX');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid license key');
    });
  });

  describe('activateLicense', () => {
    it('should create new activation for valid license', async () => {
      const mockLicense = {
        id: 'test-id',
        key: 'ABCD-EFGH-IJKL-MNOP',
        status: 'ACTIVE',
        expiresAt: null,
        maxActivations: 3,
        activations: [],
        product: {
          id: 'product-1',
          name: 'Test Product',
          features: [],
        },
        customer: {
          id: 'customer-1',
          email: 'test@example.com',
          name: 'Test User',
        },
      };

      const mockActivation = {
        id: 'activation-1',
        licenseId: 'test-id',
        machineFingerprint: 'device-123',
        machineName: 'Test Device',
        ipAddress: '127.0.0.1',
        activatedAt: new Date(),
        lastSeenAt: new Date(),
      };

      vi.mocked(prisma.license.findUnique).mockResolvedValue(mockLicense as any);
      vi.mocked(prisma.licenseActivation.create).mockResolvedValue(mockActivation);

      const result = await licenseService.activateLicense(
        'ABCD-EFGH-IJKL-MNOP',
        'device-123',
        'Test Device',
        '127.0.0.1'
      );

      expect(result.success).toBe(true);
      expect(result.activation).toBeDefined();
      expect(prisma.licenseActivation.create).toHaveBeenCalled();
    });

    it('should reject activation when max reached', async () => {
      const mockLicense = {
        id: 'test-id',
        key: 'ABCD-EFGH-IJKL-MNOP',
        status: 'ACTIVE',
        expiresAt: null,
        maxActivations: 1,
        activations: [{ machineFingerprint: 'other-device' }],
        product: {
          id: 'product-1',
          name: 'Test Product',
          features: [],
        },
        customer: {
          id: 'customer-1',
          email: 'test@example.com',
          name: 'Test User',
        },
      };

      vi.mocked(prisma.license.findUnique).mockResolvedValue(mockLicense as any);

      const result = await licenseService.activateLicense(
        'ABCD-EFGH-IJKL-MNOP',
        'device-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Maximum activations reached');
    });

    it('should update existing activation for same device', async () => {
      const mockLicense = {
        id: 'test-id',
        key: 'ABCD-EFGH-IJKL-MNOP',
        status: 'ACTIVE',
        expiresAt: null,
        maxActivations: 3,
        activations: [
          {
            id: 'existing-activation',
            machineFingerprint: 'device-123',
          },
        ],
        product: {
          id: 'product-1',
          name: 'Test Product',
          features: [],
        },
        customer: {
          id: 'customer-1',
          email: 'test@example.com',
          name: 'Test User',
        },
      };

      const mockUpdatedActivation = {
        id: 'existing-activation',
        licenseId: 'test-id',
        machineFingerprint: 'device-123',
        lastSeenAt: new Date(),
      };

      vi.mocked(prisma.license.findUnique).mockResolvedValue(mockLicense as any);
      vi.mocked(prisma.licenseActivation.update).mockResolvedValue(mockUpdatedActivation as any);

      const result = await licenseService.activateLicense(
        'ABCD-EFGH-IJKL-MNOP',
        'device-123'
      );

      expect(result.success).toBe(true);
      expect(prisma.licenseActivation.update).toHaveBeenCalled();
      expect(prisma.licenseActivation.create).not.toHaveBeenCalled();
    });
  });

  describe('revokeLicense', () => {
    it('should update license status to REVOKED', async () => {
      const mockLicense = {
        id: 'test-id',
        status: 'REVOKED',
      };

      vi.mocked(prisma.license.update).mockResolvedValue(mockLicense as any);

      const result = await licenseService.revokeLicense('test-id');

      expect(prisma.license.update).toHaveBeenCalledWith({
        where: { id: 'test-id' },
        data: { status: 'REVOKED' },
      });
      expect(result.status).toBe('REVOKED');
    });
  });

  describe('suspendLicense', () => {
    it('should update license status to SUSPENDED', async () => {
      const mockLicense = {
        id: 'test-id',
        status: 'SUSPENDED',
      };

      vi.mocked(prisma.license.update).mockResolvedValue(mockLicense as any);

      const result = await licenseService.suspendLicense('test-id');

      expect(prisma.license.update).toHaveBeenCalledWith({
        where: { id: 'test-id' },
        data: { status: 'SUSPENDED' },
      });
      expect(result.status).toBe('SUSPENDED');
    });
  });
});
