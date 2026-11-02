import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * A business error with a stable machine code and a French message the app can show as-is.
 * Everything else becomes a 500 with no detail.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const errors = {
  validation: (message = 'Certaines informations sont invalides.', extra = {}) => new AppError(400, 'VALIDATION_ERROR', message, extra),
  unauthenticated: (message = 'Connecte-toi pour continuer.') => new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'Tu n’as pas accès à cette action.') => new AppError(403, 'FORBIDDEN', message),
  /** Also used for other users' resources: never confirm that they exist. */
  notFound: (message = 'Introuvable.') => new AppError(404, 'NOT_FOUND', message),
  conflict: (code: string, message: string, extra = {}) => new AppError(409, code, message, extra),
  gone: (code: string, message: string) => new AppError(410, code, message),
  rule: (code: string, message: string, extra = {}) => new AppError(422, code, message, extra),
  locked: (code: string, message: string, extra = {}) => new AppError(423, code, message, extra),
  tooMany: (message = 'Trop de tentatives. Réessaie plus tard.', retryAfterS?: number) =>
    new AppError(429, 'TOO_MANY_REQUESTS', message, retryAfterS ? { retryAfter: retryAfterS } : {}),
};

const slug = (code: string) => code.toLowerCase().replace(/_/g, '-');

/** RFC 9457 problem+json for every error; stack traces stay in the logs. */
export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      if (err.status === 429 && typeof err.extra.retryAfter === 'number') reply.header('retry-after', String(err.extra.retryAfter));
      return reply
        .status(err.status)
        .type('application/problem+json')
        .send({ type: `about:blank#${slug(err.code)}`, title: err.code, status: err.status, code: err.code, message: err.message, ...err.extra, requestId });
    }
    if ('validation' in err && err.validation) {
      const fields = err.validation.map((v) => ({ path: v.instancePath || (v.params as { missingProperty?: string })?.missingProperty || '', rule: v.keyword }));
      return reply.status(400).type('application/problem+json').send({
        type: 'about:blank#validation-error', title: 'VALIDATION_ERROR', status: 400, code: 'VALIDATION_ERROR',
        message: 'Certaines informations sont invalides.', fields, requestId,
      });
    }
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, 'unhandled error');
    const code = status === 429 ? 'TOO_MANY_REQUESTS' : status === 500 ? 'INTERNAL_ERROR' : (err.code ?? 'BAD_REQUEST');
    const message = status === 500 ? 'Une erreur est survenue. Réessaie.' : status === 429 ? 'Trop de requêtes. Réessaie plus tard.' : 'Requête invalide.';
    return reply.status(status).type('application/problem+json').send({ type: `about:blank#${slug(code)}`, title: code, status, code, message, requestId });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).type('application/problem+json').send({
      type: 'about:blank#not-found', title: 'NOT_FOUND', status: 404, code: 'NOT_FOUND', message: 'Introuvable.', requestId: req.id,
    }),
  );
}
