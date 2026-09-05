import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/index.js', () => ({
  config: { APP_NAME: 'License Server' },
}));
vi.mock('../../src/services/logger.service.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { escapeHtml } from '../../src/services/email.service.js';

describe('escapeHtml', () => {
  it('neutralises markup in customer-supplied strings', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('Tom & "Jerry" \'s')).toBe('Tom &amp; &quot;Jerry&quot; &#39;s');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeHtml('Acme Ltd')).toBe('Acme Ltd');
    expect(escapeHtml(42)).toBe('42');
  });
});
