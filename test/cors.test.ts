import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ CORS_ORIGINS: 'http://localhost:8081' });
});
afterAll(async () => {
  await t.close();
});

describe('CORS', () => {
  it('lets the configured web origin call the API, and no other', async () => {
    const preflight = (origin: string) =>
      t.app.inject({ method: 'OPTIONS', url: '/api/v1/auth/login', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect((await preflight('http://localhost:8081')).headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect((await preflight('https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
  });
});
