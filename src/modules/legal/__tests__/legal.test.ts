import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, json, type TestApp } from '../../../../test/harness.js';
import { TERMS_VERSION } from '../index.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('legal', () => {
  it('serves the terms and the privacy policy publicly, with the version accepted at sign-up', async () => {
    for (const doc of ['conditions', 'confidentialite']) {
      const res = await t.app.inject({ url: `/api/v1/reference/legal/${doc}` });
      expect(res.statusCode).toBe(200);
      const d = json(res);
      expect(d).toMatchObject({ doc, version: TERMS_VERSION });
      expect(d.sections.length).toBeGreaterThan(3);
      // The support contacts come from the configuration.
      expect(JSON.stringify(d)).toContain(t.c.config.SUPPORT_EMAIL);
    }
    expect((await t.app.inject({ url: '/api/v1/reference/legal/autre' })).statusCode).toBe(404);
  });
});
