import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/database.js', () => {
  const prisma: Record<string, unknown> = {
    license: { findUnique: vi.fn(), update: vi.fn() },
    deployment: { findUnique: vi.fn(), upsert: vi.fn() },
    licenseActivation: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    licenseAddOn: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { prisma };
});
vi.mock('../../src/services/license.service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/license.service.js')>('../../src/services/license.service.js');
  return { ...actual, validateLicense: vi.fn(), activateLicense: vi.fn() };
});

import { prisma } from '../../src/config/database.js';
import * as licenseService from '../../src/services/license.service.js';
import { enrolDeployment, entitlementOf } from '../../src/services/deployment.service.js';

/**
 * Enrolment is how a product that installs itself gets a deployment without the admin key: the
 * licence key and the machine decide, and the secret comes back once.
 */
const license = {
  id: 'lic-1', key: 'AAAA-BBBB-CCCC-DDDD', customerId: 'cus-1', productId: 'prod-1', status: 'ACTIVE', expiresAt: new Date('2027-01-01T00:00:00Z'),
  licenseType: 'TEAM', enabledComponents: [], parentLicenseId: null,
  product: { id: 'prod-1', name: 'Agencie Lab - Docker host', slug: 'agencie-lab', features: ['connectors', 'escalation'], components: ['aos', 'codeeasy', 'cloudcode'], offlineGraceDays: 7, checkInIntervalDays: 1 },
  customer: { id: 'cus-1', email: 'owner@example.com', name: 'The Lab' },
};
const input = { licenseKey: license.key, deploymentId: 'bosgame-aos', machineHash: 'f'.repeat(64), machineName: 'bosgame', version: '1.1.106', component: 'aos', ipAddress: '192.168.1.177' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(licenseService.validateLicense).mockResolvedValue({ valid: true, features: license.product.features, components: license.product.components });
  vi.mocked(licenseService.activateLicense).mockResolvedValue({ success: true, activation: {} as any, product: license.product.name });
  vi.mocked(prisma.license.findUnique).mockResolvedValue(license as any);
  vi.mocked(prisma.deployment.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.deployment.upsert).mockImplementation(async (args: any) => ({ id: args.where.id, ...args.create }));
});

describe('enrolDeployment', () => {
  it('validates and activates the licence for the machine, creates the deployment, and returns the secret once with the entitlement', async () => {
    const r = await enrolDeployment(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deployment.id).toBe('bosgame-aos');
    expect(r.deployment.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(r.components).toEqual(['aos', 'codeeasy', 'cloudcode']);
    expect(r.features).toEqual(['connectors', 'escalation']);
    expect(r.tier).toBe('TEAM');
    expect(r.slug).toBe('agencie-lab');
    expect(r.graceDays).toBe(7);
    expect(r.expiresAt).toBe('2027-01-01T00:00:00.000Z');
    expect(licenseService.validateLicense).toHaveBeenCalledWith(license.key, input.machineHash, 'aos');
    expect(licenseService.activateLicense).toHaveBeenCalledWith(license.key, input.machineHash, 'bosgame', '192.168.1.177');
    const upsert = vi.mocked(prisma.deployment.upsert).mock.calls[0]![0] as any;
    expect(upsert.create.licenseId).toBe('lic-1');
    expect(upsert.create.customerId).toBe('cus-1');
    expect(upsert.create.productId).toBe('prod-1');
    expect(upsert.create.secret).toBe(r.deployment.secret);
    expect(upsert.create.metadata.component).toBe('aos');
  });

  it('refuses a licence the service refuses, a bad id, and a short fingerprint', async () => {
    vi.mocked(licenseService.validateLicense).mockResolvedValue({ valid: false, error: 'Maximum activations reached' });
    expect(await enrolDeployment(input)).toEqual({ ok: false, status: 403, error: 'Maximum activations reached' });
    expect(prisma.deployment.upsert).not.toHaveBeenCalled();
    expect((await enrolDeployment({ ...input, deploymentId: 'a b' })).ok).toBe(false);
    expect((await enrolDeployment({ ...input, machineHash: 'short' })).ok).toBe(false);
  });

  it('the same machine enrolling again is re-keyed; another machine or licence on a taken id is refused', async () => {
    vi.mocked(prisma.deployment.findUnique).mockResolvedValue({ id: 'bosgame-aos', licenseId: 'lic-1', machineHash: input.machineHash, status: 'ACTIVE', metadata: { enrolledAt: 'before' }, version: '1.1.100' } as any);
    const again = await enrolDeployment(input);
    expect(again.ok).toBe(true);
    const upsert = vi.mocked(prisma.deployment.upsert).mock.calls[0]![0] as any;
    expect(upsert.update.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(upsert.update.metadata.reEnrolledAt).toBeDefined();
    vi.mocked(prisma.deployment.findUnique).mockResolvedValue({ id: 'bosgame-aos', licenseId: 'lic-2', machineHash: 'e'.repeat(64), status: 'ACTIVE' } as any);
    const taken = await enrolDeployment(input);
    expect(taken).toMatchObject({ ok: false, status: 409 });
    vi.mocked(prisma.deployment.findUnique).mockResolvedValue({ id: 'bosgame-aos', licenseId: 'lic-1', machineHash: input.machineHash, status: 'KILL' } as any);
    expect(await enrolDeployment(input)).toMatchObject({ ok: false, status: 403 });
  });

  it('the same machine enrolling with a new licence key is moved to it and its seat on the old licence freed', async () => {
    vi.mocked(prisma.deployment.findUnique).mockResolvedValue({ id: 'bosgame-aos', licenseId: 'lic-0', customerId: 'cus-0', productId: 'prod-0', machineHash: input.machineHash, status: 'ACTIVE', metadata: {}, version: '1.1.100' } as any);
    const moved = await enrolDeployment(input);
    expect(moved.ok).toBe(true);
    const upsert = vi.mocked(prisma.deployment.upsert).mock.calls[0]![0] as any;
    expect(upsert.update).toMatchObject({ licenseId: 'lic-1', customerId: 'cus-1', productId: 'prod-1', machineHash: input.machineHash });
    expect(upsert.update.metadata.reboundFrom).toBe('lic-0');
    expect(prisma.licenseActivation.deleteMany).toHaveBeenCalledWith({ where: { licenseId: 'lic-0', machineFingerprint: input.machineHash } });
    // The same key on the same machine is a plain re-enrolment: nothing to free.
    vi.mocked(prisma.licenseActivation.deleteMany).mockClear();
    vi.mocked(prisma.deployment.findUnique).mockResolvedValue({ id: 'bosgame-aos', licenseId: 'lic-1', machineHash: input.machineHash, status: 'ACTIVE', metadata: {} } as any);
    expect((await enrolDeployment(input)).ok).toBe(true);
    expect(prisma.licenseActivation.deleteMany).not.toHaveBeenCalled();
    // A different machine on another licence is still refused, and so is another licence when no machine is on record.
    vi.mocked(prisma.deployment.findUnique).mockResolvedValue({ id: 'bosgame-aos', licenseId: 'lic-0', machineHash: 'e'.repeat(64), status: 'ACTIVE' } as any);
    expect(await enrolDeployment(input)).toMatchObject({ ok: false, status: 409 });
    vi.mocked(prisma.deployment.findUnique).mockResolvedValue({ id: 'bosgame-aos', licenseId: 'lic-0', machineHash: null, status: 'ACTIVE' } as any);
    expect(await enrolDeployment(input)).toMatchObject({ ok: false, status: 409 });
    expect(prisma.licenseActivation.deleteMany).not.toHaveBeenCalled();
  });

  it('entitlementOf answers the licence\'s components and features, or null without a licence', async () => {
    expect(await entitlementOf({ licenseId: 'lic-1' })).toEqual({ components: ['aos', 'codeeasy', 'cloudcode'], features: ['connectors', 'escalation'] });
    expect(await entitlementOf({ licenseId: null })).toBeNull();
  });
});
