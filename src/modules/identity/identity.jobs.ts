import { UnrecoverableError, type Job } from 'bullmq';

import { PermanentSmsError, type SmsSender } from '../../platform/sms/sms.js';
import { OTP_QUEUE, type OtpJob } from './otp.service.js';

const TEXT: Record<OtpJob['purpose'], (code: string) => string> = {
  register: (code) => `UGB Connect : ton code de vérification est ${code}. Il expire dans 5 minutes. Ne le partage avec personne.`,
  change_phone: (code) => `UGB Connect : code pour utiliser ce numéro sur ton compte : ${code}. Si tu n’as rien demandé, ignore ce message.`,
  reset_password: (code) => `UGB Connect : code pour changer ton mot de passe : ${code}. Si tu n’as rien demandé, ignore ce message.`,
};

/**
 * Worker side of OTP delivery: retried with backoff by BullMQ, one job per (challenge, send). A refusal that a retry
 * can't fix (invalid number, unverified number on a trial account) stops at once.
 */
export function otpProcessors(sms: SmsSender) {
  return {
    [OTP_QUEUE]: async (job: Job<OtpJob>) => {
      try {
        await sms.send(job.data.phone, TEXT[job.data.purpose](job.data.code));
      } catch (err) {
        if (err instanceof PermanentSmsError) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
  };
}
