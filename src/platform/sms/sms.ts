import type { FastifyBaseLogger } from 'fastify';

import type { Config } from '../../config/env.js';
import { maskPhone } from '../phone.js';

export interface SmsSender {
  send(to: string, text: string): Promise<void>;
}

/**
 * A send that will fail the same way if retried (wrong number, number not allowed on a trial account, bad
 * credentials): the job stops instead of retrying. Anything else (network, provider down, rate limit) is retried.
 */
export class PermanentSmsError extends Error {}

/** Development: writes the SMS to the log instead of sending it. Refused in production by loadConfig. */
export class ConsoleSmsSender implements SmsSender {
  constructor(private readonly log: Pick<FastifyBaseLogger, 'info'>) {}
  async send(to: string, text: string) {
    this.log.info({ to: maskPhone(to), sms: text }, 'SMS (console provider, not sent)');
  }
}

export type TwilioOptions = {
  accountSid: string;
  /** An API key (SK…) and its secret, or the account's auth token. */
  auth: { keySid: string; keySecret: string } | { authToken: string };
  /** A Twilio number (+1…), an approved sender name, or a Messaging Service (MG…) that picks the sender. */
  from: { number: string } | { messagingServiceSid: string };
};

const TWILIO_API = 'https://api.twilio.com/2010-04-01';

/** Twilio Programmable Messaging: one REST call per SMS. The text (it holds the code) is never logged. */
export class TwilioSmsSender implements SmsSender {
  constructor(
    private readonly o: TwilioOptions,
    private readonly log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(to: string, text: string) {
    const [user, password] = 'authToken' in this.o.auth ? [this.o.accountSid, this.o.auth.authToken] : [this.o.auth.keySid, this.o.auth.keySecret];
    const form = new URLSearchParams({ To: to, Body: text });
    if ('number' in this.o.from) form.set('From', this.o.from.number);
    else form.set('MessagingServiceSid', this.o.from.messagingServiceSid);

    const res = await this.fetchImpl(`${TWILIO_API}/Accounts/${this.o.accountSid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; code?: number; message?: string };
    if (res.ok) {
      this.log.info({ to: maskPhone(to), sid: body.sid, status: body.status }, 'SMS sent (Twilio)');
      return;
    }
    // Twilio's own code (21608: unverified number on a trial account, 21211: invalid number…) says what to fix.
    const reason = `Twilio HTTP ${res.status}${body.code ? ` ${body.code}` : ''}: ${body.message ?? 'error'}`;
    this.log.warn({ to: maskPhone(to), status: res.status, code: body.code, reason }, 'SMS refused (Twilio)');
    if (res.status === 429 || res.status >= 500) throw new Error(reason);
    throw new PermanentSmsError(reason);
  }
}

/** The sender SMS_PROVIDER names. loadConfig has already checked that the provider's settings are complete. */
export function createSmsSender(config: Config, log: Pick<FastifyBaseLogger, 'info' | 'warn'>): SmsSender {
  if (config.SMS_PROVIDER === 'twilio') {
    return new TwilioSmsSender(
      {
        accountSid: config.TWILIO_ACCOUNT_SID!,
        auth: config.TWILIO_API_KEY_SID ? { keySid: config.TWILIO_API_KEY_SID, keySecret: config.TWILIO_API_KEY_SECRET! } : { authToken: config.TWILIO_AUTH_TOKEN! },
        from: config.TWILIO_MESSAGING_SERVICE_SID ? { messagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID } : { number: config.TWILIO_FROM! },
      },
      log,
    );
  }
  return new ConsoleSmsSender(log);
}
