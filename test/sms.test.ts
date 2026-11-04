import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config/env.js';
import { createSmsSender, PermanentSmsError, TwilioSmsSender } from '../src/platform/sms/sms.js';

const SID = `AC${'a'.repeat(32)}`;
const KEY = `SK${'b'.repeat(32)}`;
const log = { info: vi.fn(), warn: vi.fn() };
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('Twilio SMS', () => {
  it('sends with the API key and the sender number, without logging the text', async () => {
    const fetch = reply(201, { sid: 'SM1', status: 'queued' });
    const sms = new TwilioSmsSender({ accountSid: SID, auth: { keySid: KEY, keySecret: 'secret-secret-123' }, from: { number: '+15005550006' } }, log, fetch);
    await sms.send('+221771234567', 'UGB Campus : ton code est 4821.');

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`${KEY}:secret-secret-123`).toString('base64')}`);
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({ To: '+221771234567', Body: 'UGB Campus : ton code est 4821.', From: '+15005550006' });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('4821');
  });

  it('uses the auth token and a Messaging Service when given', async () => {
    const fetch = reply(201, { sid: 'SM2' });
    const sms = new TwilioSmsSender({ accountSid: SID, auth: { authToken: 'token-token-token-1' }, from: { messagingServiceSid: `MG${'c'.repeat(32)}` } }, log, fetch);
    await sms.send('+221771234567', 'x');
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`${SID}:token-token-token-1`).toString('base64')}`);
    expect(new URLSearchParams(String(init.body)).get('MessagingServiceSid')).toBe(`MG${'c'.repeat(32)}`);
  });

  it('stops on a refusal a retry cannot fix, retries on a provider outage', async () => {
    const opts = { accountSid: SID, auth: { authToken: 'token-token-token-1' }, from: { number: '+15005550006' } };
    const trial = new TwilioSmsSender(opts, log, reply(400, { code: 21608, message: 'The number is unverified.' }));
    await expect(trial.send('+221771234567', 'x')).rejects.toBeInstanceOf(PermanentSmsError);
    await expect(trial.send('+221771234567', 'x')).rejects.toThrow(/21608/);

    const down = new TwilioSmsSender(opts, log, reply(503, {}));
    const err = await down.send('+221771234567', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentSmsError);
  });

  it('refuses to boot with incomplete Twilio settings, and builds the sender when complete', () => {
    expect(() => loadConfig({ SMS_PROVIDER: 'twilio' })).toThrow(/TWILIO_ACCOUNT_SID.*TWILIO_FROM/);
    expect(() => loadConfig({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: SID, TWILIO_API_KEY_SID: KEY, TWILIO_FROM: '+15005550006' })).toThrow(/TWILIO_API_KEY_SECRET/);
    expect(() => loadConfig({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'nope', TWILIO_AUTH_TOKEN: 'token-token-token-1', TWILIO_FROM: '+15005550006' })).toThrow(/TWILIO_ACCOUNT_SID/);
    const c = loadConfig({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: 'token-token-token-1', TWILIO_FROM: 'UGBCampus' });
    expect(createSmsSender(c, log)).toBeInstanceOf(TwilioSmsSender);
  });
});
