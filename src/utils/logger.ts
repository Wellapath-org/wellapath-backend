import pino from 'pino';
import { buildLogRedactionPaths } from '../telemetry/prohibited';

/**
 * Standalone logger, used by scripts that run outside the Fastify lifecycle (`src/db/migrate.ts`,
 * the contract generator). It now shares the centralized redaction list with the request logger
 * in `src/app.ts` — previously this file redacted only `authorization` while the server also
 * redacted `cookie`, which `docs/SECURITY_CHECKLIST.md` flagged as a drift risk.
 */
export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  redact: buildLogRedactionPaths(),
});
