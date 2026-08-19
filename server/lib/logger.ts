import { pino } from 'pino';
import { getEnv } from '../config/env';

/**
 * Structured operational logging with aggressive redaction. Request bodies
 * are never logged by default; the paths below are defense in depth for
 * anything that slips into log arguments.
 */
export const logger = pino({
  level: getEnv().LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-test-auth"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.secret',
      '*.tokenHash',
      '*.taxId',
      '*.bankAccount',
      '*.connectionString',
      'DATABASE_URL',
      'CLERK_SECRET_KEY',
    ],
    censor: '[redacted]',
  },
  base: undefined,
});
