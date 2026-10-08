import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/database.js', () => {
  const prisma: Record<string, unknown> = {
    license: { findUnique: vi.fn(), update: vi.fn() },
    licenseAddOn: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  };
  return { prisma };
});

import { prisma } from '../../src/config/database.js';
import * as addOns from '../../src/services/addon.service.js';

const m = prisma as unknown as {
  license: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  licenseAddOn: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};

const ENTERPRISE = ['scope-cortex', 'cortex-managed', 'enterprise-plugins'];
const BUSINESS = ['scope-cortex', 'cortex-managed'];
const CHILD = ['scope-child-cortex', 'cortex-managed', 'enterprise-plugins'];
const STANDALONE = ['scope-agent', 'standalone'];

const active = { code: 'causal_trust', revokedAt: null, expiresAt: null };

describe('licence add-ons', () => {
  beforeEach(() => vi.clearAllMocks());

  it('may be granted only to an Enterprise parent Cortex', () => {
    expect(addOns.addOnRefusal(ENTERPRISE, 'causal_trust')).toBeNull();
    expect(addOns.addOnRefusal(BUSINESS, 'causal_trust')).toMatch(/Enterprise only/);
    expect(addOns.addOnRefusal(CHILD, 'causal_trust')).toMatch(/parent/);
    expect(addOns.addOnRefusal(STANDALONE, 'causal_trust')).toMatch(/Cortex-only/);
    expect(addOns.addOnRefusal(['standalone'], 'causal_trust')).toMatch(/Cortex-only/);
    expect(addOns.addOnRefusal(ENTERPRISE, 'free_lunch')).toMatch(/unknown add-on/);
  });

  it('refuses a grant to a child licence and creates nothing', async () => {
    m.license.findUnique.mockResolvedValue({ id: 'c', product: { features: CHILD }, addOns: [] });
    await expect(addOns.grantAddOn({ licenseId: 'c', code: 'causal_trust' })).rejects.toThrow(/parent/);
    expect(m.licenseAddOn.create).not.toHaveBeenCalled();
  });

  it('adds an Enterprise licence’s own active add-on to its features', async () => {
    m.licenseAddOn.findMany.mockResolvedValue([active]);
    const f = await addOns.effectiveFeatures({ id: 'p', product: { features: ENTERPRISE } });
    expect(f).toContain('causal_trust');
  });

  it('drops a revoked or expired add-on', async () => {
    const past = new Date(Date.now() - 1000);
    m.licenseAddOn.findMany.mockResolvedValue([
      { code: 'causal_trust', revokedAt: past, expiresAt: null },
      { code: 'causal_trust', revokedAt: null, expiresAt: past },
    ]);
    const f = await addOns.effectiveFeatures({ id: 'p', product: { features: ENTERPRISE } });
    expect(f).not.toContain('causal_trust');
  });

  it('a linked child inherits an active parent’s add-on', async () => {
    m.licenseAddOn.findMany.mockResolvedValue([]);
    m.license.findUnique.mockResolvedValue({ id: 'p', status: 'ACTIVE', expiresAt: null, addOns: [active] });
    const f = await addOns.effectiveFeatures({ id: 'c', parentLicenseId: 'p', product: { features: CHILD } });
    expect(f).toContain('causal_trust');
  });

  it('a child inherits nothing from a revoked, suspended or expired parent', async () => {
    m.licenseAddOn.findMany.mockResolvedValue([]);
    for (const parent of [
      { status: 'REVOKED', expiresAt: null },
      { status: 'SUSPENDED', expiresAt: null },
      { status: 'ACTIVE', expiresAt: new Date(Date.now() - 1000) },
    ]) {
      m.license.findUnique.mockResolvedValue({ id: 'p', ...parent, addOns: [active] });
      const f = await addOns.effectiveFeatures({ id: 'c', parentLicenseId: 'p', product: { features: CHILD } });
      expect(f).not.toContain('causal_trust');
    }
  });

  it('an unlinked child, and a non-child with a parent link, inherit nothing', async () => {
    m.licenseAddOn.findMany.mockResolvedValue([]);
    m.license.findUnique.mockResolvedValue({ id: 'p', status: 'ACTIVE', expiresAt: null, addOns: [active] });
    expect(await addOns.effectiveFeatures({ id: 'c', parentLicenseId: null, product: { features: CHILD } })).not.toContain('causal_trust');
    expect(await addOns.effectiveFeatures({ id: 's', parentLicenseId: 'p', product: { features: STANDALONE } })).not.toContain('causal_trust');
  });

  it('links a child only to a Cortex parent of the same customer', async () => {
    m.license.findUnique
      .mockResolvedValueOnce({ id: 'c', customerId: 'x', product: { features: CHILD } })
      .mockResolvedValueOnce({ id: 'p', customerId: 'y', product: { features: ENTERPRISE } });
    await expect(addOns.setParent('c', 'p')).rejects.toThrow(/different customers/);
    m.license.findUnique
      .mockResolvedValueOnce({ id: 's', customerId: 'x', product: { features: STANDALONE } });
    await expect(addOns.setParent('s', 'p')).rejects.toThrow(/child Cortex/);
    expect(m.license.update).not.toHaveBeenCalled();
  });
});
