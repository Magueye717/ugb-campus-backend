import type { Clock } from '../../platform/clock.js';
import { hmac, randomCode, safeEqual } from '../../platform/security/crypto.js';
import type { ProviderId } from './payments.types.js';

/** A verified provider event, already translated to our vocabulary. */
export type ProviderEvent = {
  eventId: string;
  type: string;
  reference: string;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  amount: number;
  currency: string;
  transactionId: string | null;
};

/**
 * What every provider adapter implements (06-domain-designs §1.2). Wave and Orange Money arrive with the merchant
 * accounts (Q-1); until then only the simulator exists.
 */
export interface PaymentProvider {
  id: ProviderId;
  createCheckout(p: { reference: string; amount: number; description: string; expiresAt: Date; baseUrl: string }): Promise<{ sessionId: string; checkoutUrl: string }>;
  /** Null when the signature is missing, wrong or too old: the event is stored for forensics and never processed. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent | null;
  /** Sends money to a Wave / Orange Money number (refunds, organizer claims). */
  disburse(p: { phone: string; amount: number; idempotencyKey: string }): Promise<{ transferId: string }>;
}

export const SIMULATOR_SIGNATURE_HEADER = 'x-simulator-signature';
const SIGNATURE_TOLERANCE_S = 300;

export type SimulatedEventType = 'checkout.completed' | 'checkout.failed' | 'checkout.cancelled';

/** Signs like Wave does (`t=<unix>,v1=<hmac(t.body)>`), so the webhook path is the one real providers will use. */
export function signSimulatorBody(secret: string, body: string, at: Date) {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${hmac(secret, `${t}.${body}`)}`;
}

/** Development stand-in for Wave and Orange Money: a checkout page on this API and signed webhooks. */
export class SimulatedProvider implements PaymentProvider {
  readonly id = 'simulated' as const;

  constructor(
    private readonly secret: string,
    private readonly clock: Clock,
  ) {}

  async createCheckout(p: { reference: string; baseUrl: string }) {
    return { sessionId: `sim_${p.reference}`, checkoutUrl: `${p.baseUrl}/api/v1/dev/payment-simulator/${p.reference}` };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderEvent | null {
    const header = headers[SIMULATOR_SIGNATURE_HEADER];
    if (typeof header !== 'string') return null;
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
    const t = Number(parts.t);
    if (!Number.isFinite(t) || !parts.v1) return null;
    if (Math.abs(this.clock.now().getTime() / 1000 - t) > SIGNATURE_TOLERANCE_S) return null;
    if (!safeEqual(parts.v1, hmac(this.secret, `${t}.${rawBody.toString('utf8')}`))) return null;

    let body: { id?: unknown; type?: unknown; data?: Record<string, unknown> };
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const outcomes: Record<SimulatedEventType, ProviderEvent['outcome']> = {
      'checkout.completed': 'succeeded',
      'checkout.failed': 'failed',
      'checkout.cancelled': 'cancelled',
    };
    const outcome = outcomes[body.type as SimulatedEventType];
    const d = body.data ?? {};
    if (typeof body.id !== 'string' || !outcome || typeof d.reference !== 'string' || typeof d.amount !== 'number') return null;
    return {
      eventId: body.id,
      type: body.type as string,
      reference: d.reference,
      outcome,
      amount: d.amount,
      currency: String(d.currency ?? ''),
      transactionId: typeof d.transactionId === 'string' ? d.transactionId : null,
    };
  }

  async disburse() {
    return { transferId: `simtr_${randomCode(16)}` };
  }
}
