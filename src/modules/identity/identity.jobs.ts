import type { Job } from 'bullmq';

import type { SmsSender } from '../../platform/sms/sms.js';
import { OTP_QUEUE, type OtpJob } from './otp.service.js';

const TEXT: Record<OtpJob['purpose'], (code: string) => string> = {
  register: (code) => `UGB Campus : ton code de vérification est ${code}. Il expire dans 5 minutes. Ne le partage avec personne.`,
  reset_password: (code) => `UGB Campus : code pour changer ton mot de passe : ${code}. Si tu n’as rien demandé, ignore ce message.`,
};

/** Worker side of OTP delivery: retried with backoff by BullMQ, one job per (challenge, send). */
export function otpProcessors(sms: SmsSender) {
  return {
    [OTP_QUEUE]: async (job: Job<OtpJob>) => {
      await sms.send(job.data.phone, TEXT[job.data.purpose](job.data.code));
    },
  };
}
