import { describe, it, expect, vi } from 'vitest';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    JWT_SECRET: 'a-test-secret-that-is-long-enough-for-the-schema',
    APP_URL: 'https://licences.example/',
    S3_BUCKET_NAME: 'bundles',
    S3_ENDPOINT: 'http://minio:9000',
    S3_DOWNLOAD_EXPIRY_HOURS: '4',
    DOWNLOADS_VIA_SERVER: 'auto',
  } as Record<string, string | undefined>,
}));

vi.mock('../../src/config/index.js', () => ({ config: mockConfig, isProduction: false, isDevelopment: true }));
vi.mock('../../src/config/s3.js', () => ({ s3Client: { send: vi.fn() } }));
vi.mock('../../src/services/logger.service.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/services/product.service.js', () => ({}));
vi.mock('../../src/services/license.service.js', () => ({}));

import { presignKey, keyFromDownloadToken } from '../../src/services/storage.service.js';

/** A private store (MinIO on an internal network) is reached through this server's own signed links. */
describe('download links through the server', () => {
  it('points at the public address and names the object only inside a signed token', async () => {
    const link = await presignKey('releases/agencie-lab/1.2.3/aos-any-aos.tar.gz');
    expect(link.url.startsWith('https://licences.example/api/updates/files/')).toBe(true);
    expect(link.filename).toBe('aos-any-aos.tar.gz');
    const token = link.url.split('/files/')[1];
    expect(keyFromDownloadToken(token)).toBe('releases/agencie-lab/1.2.3/aos-any-aos.tar.gz');
  });

  it('refuses a changed key, a changed signature, a malformed token and an expired one', async () => {
    const token = (await presignKey('releases/x/1.0.0/a')).url.split('/files/')[1];
    const [payload, sig] = token.split('.');
    const other = Buffer.from(JSON.stringify({ k: 'releases/x/1.0.0/b', e: 9_999_999_999 })).toString('base64url');
    expect(keyFromDownloadToken(`${other}.${sig}`)).toBeNull();
    expect(keyFromDownloadToken(`${payload}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(keyFromDownloadToken('nonsense')).toBeNull();
    expect(keyFromDownloadToken(token, Date.now() + 5 * 3600 * 1000)).toBeNull();
  });
});
