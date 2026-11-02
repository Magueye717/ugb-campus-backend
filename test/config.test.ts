import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/env.js';

describe('configuration', () => {
  it('refuses development conveniences in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', OTP_DEV_MODE: 'true' })).toThrow(/OTP_DEV_MODE.*OTP_PEPPER.*JWT keys.*SMS_PROVIDER/);
    expect(() => loadConfig({ NODE_ENV: 'production', RATE_LIMIT_SCALE: '10' })).toThrow(/RATE_LIMIT_SCALE/);
    expect(() => loadConfig({ NODE_ENV: 'production', PAYMENTS_SIMULATOR: 'true' })).toThrow(/PAYMENTS_SIMULATOR/);
  });

  it('reports invalid fields without echoing any value', () => {
    const secret = 'super-secret-pepper-value-0123456789abcdef';
    try {
      loadConfig({ PORT: 'not-a-number', OTP_PEPPER: secret, OTP_LENGTH: '99' });
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/PORT|OTP_LENGTH/);
      expect(message).not.toContain(secret);
    }
  });

  it('parses numbers and booleans from strings', () => {
    const c = loadConfig({ PORT: '4000', DOCS_ENABLED: 'true', OTP_DEV_MODE: 'false' });
    expect(c).toMatchObject({ PORT: 4000, DOCS_ENABLED: true, OTP_DEV_MODE: false });
  });
});
