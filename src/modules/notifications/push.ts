import type { FastifyBaseLogger } from 'fastify';

export type PushMessage = { to: string; title: string; body: string; data: { url: string | null }; channelId: string; sound: 'default'; collapseId?: string };
/** Per message, in order: ok, or why it failed (`DeviceNotRegistered`: the app was uninstalled). */
export type PushOutcome = { ok: true } | { ok: false; error: string };

export interface PushSender {
  send(messages: PushMessage[]): Promise<PushOutcome[]>;
}

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

/** Expo's push service: one request per 100 messages. Delivery receipts are not checked yet. */
export class ExpoPushSender implements PushSender {
  constructor(private readonly accessToken?: string) {}

  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    const out: PushOutcome[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const res = await fetch(EXPO_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`); // the job retries with backoff
      const body = (await res.json()) as { data?: { status: string; details?: { error?: string }; message?: string }[] };
      for (const t of body.data ?? []) out.push(t.status === 'ok' ? { ok: true } : { ok: false, error: t.details?.error ?? t.message ?? 'error' });
    }
    return out;
  }
}

/** Development and tests: written to the log, never sent. */
export class LogPushSender implements PushSender {
  constructor(private readonly log?: FastifyBaseLogger) {}
  readonly sent: PushMessage[] = [];

  async send(messages: PushMessage[]): Promise<PushOutcome[]> {
    this.sent.push(...messages);
    for (const m of messages) this.log?.info({ to: `${m.to.slice(0, 22)}…`, title: m.title, url: m.data.url }, 'push (log only)');
    return messages.map(() => ({ ok: true }));
  }
}
