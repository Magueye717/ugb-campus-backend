import type { FastifyBaseLogger } from 'fastify';

import { maskPhone } from '../phone.js';

export interface SmsSender {
  send(to: string, text: string): Promise<void>;
}

/** Development: writes the SMS to the log instead of sending it. Refused in production by loadConfig. */
export class ConsoleSmsSender implements SmsSender {
  constructor(private readonly log: Pick<FastifyBaseLogger, 'info'>) {}
  async send(to: string, text: string) {
    this.log.info({ to: maskPhone(to), sms: text }, 'SMS (console provider, not sent)');
  }
}
