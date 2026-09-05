import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConfig } = vi.hoisted(() => ({ mockConfig: {} as { ADMIN_API_KEY?: string } }));

vi.mock('../../src/config/index.js', () => ({
  config: mockConfig,
  isProduction: false,
  isDevelopment: true,
}));

vi.mock('../../src/services/logger.service.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { isValidAdminApiKey, requireApiKey } from '../../src/utils/apiKey.js';

describe('isValidAdminApiKey', () => {
  beforeEach(() => {
    delete mockConfig.ADMIN_API_KEY;
  });

  it('fails closed when no key is configured, even for a missing header', () => {
    expect(isValidAdminApiKey(undefined)).toBe(false);
    expect(isValidAdminApiKey('')).toBe(false);
    expect(isValidAdminApiKey('anything')).toBe(false);
  });

  it('accepts only the exact configured key', () => {
    mockConfig.ADMIN_API_KEY = 'a'.repeat(40);
    expect(isValidAdminApiKey('a'.repeat(40))).toBe(true);
    expect(isValidAdminApiKey('a'.repeat(39))).toBe(false);
    expect(isValidAdminApiKey('a'.repeat(39) + 'b')).toBe(false);
    expect(isValidAdminApiKey(['a'.repeat(40)])).toBe(false);
  });
});

describe('requireApiKey middleware', () => {
  it('responds 401 and does not call next when the key is wrong', () => {
    mockConfig.ADMIN_API_KEY = 'secret-key-secret-key-secret-key-1234567';
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn();
    const req = { headers: { 'x-api-key': 'nope' }, originalUrl: '/x', ip: '1.2.3.4' };

    requireApiKey(req as never, { status, json } as never, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when the key matches', () => {
    mockConfig.ADMIN_API_KEY = 'secret-key-secret-key-secret-key-1234567';
    const next = vi.fn();
    const req = { headers: { 'x-api-key': mockConfig.ADMIN_API_KEY }, originalUrl: '/x', ip: '1.2.3.4' };

    requireApiKey(req as never, { status: vi.fn(), json: vi.fn() } as never, next);

    expect(next).toHaveBeenCalled();
  });
});
