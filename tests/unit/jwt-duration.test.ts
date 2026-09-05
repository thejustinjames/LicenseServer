import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/index.js', () => ({
  config: { JWT_SECRET: 'x'.repeat(40), JWT_EXPIRES_IN: '12h' },
}));
vi.mock('../../src/config/redis.js', () => ({
  isTokenBlacklisted: vi.fn().mockResolvedValue(false),
  blacklistToken: vi.fn(),
}));
vi.mock('../../src/services/logger.service.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), audit: vi.fn() },
}));

import { durationToMs, COOKIE_OPTIONS, JWTAuthProvider } from '../../src/auth/jwt.auth.js';

describe('durationToMs', () => {
  it('parses jsonwebtoken style durations', () => {
    expect(durationToMs('30s')).toBe(30_000);
    expect(durationToMs('15m')).toBe(15 * 60_000);
    expect(durationToMs('12h')).toBe(12 * 3_600_000);
    expect(durationToMs('7d')).toBe(7 * 86_400_000);
    expect(durationToMs(60)).toBe(60_000);
  });

  it('falls back to 7 days for unrecognised input', () => {
    expect(durationToMs('soon')).toBe(7 * 86_400_000);
    expect(durationToMs(undefined)).toBe(7 * 86_400_000);
  });

  it('aligns the auth cookie lifetime with JWT_EXPIRES_IN', () => {
    expect(COOKIE_OPTIONS.maxAge).toBe(12 * 3_600_000);
  });
});

describe('JWTAuthProvider token types', () => {
  it('rejects a refresh token presented as an access token', async () => {
    const provider = new JWTAuthProvider();
    const user = { id: 'u1', email: 'u@example.com', isAdmin: false };
    const refresh = provider.generateRefreshToken(user);
    const access = provider.generateToken(user);

    expect(await provider.verifyToken(refresh.token)).toBeNull();
    expect(await provider.verifyToken(access.token)).toMatchObject({ id: 'u1' });
  });
});
