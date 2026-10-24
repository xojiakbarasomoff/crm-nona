import pino from 'pino';

/**
 * Structured logger with PII/secret redaction (TZ §22.2). Raw webhook payloads are never logged.
 */
export type Logger = pino.Logger;

export function createLogger(level = process.env.LOG_LEVEL ?? 'info', name = 'crm'): Logger {
  return pino({
    name,
    level,
    redact: {
      paths: [
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
        '*.access_token',
        '*.refresh_token',
        '*.secret',
        '*.phone',
        '*.email',
        '*.payload',
        '*.rawBody',
        'req.headers.cookie',
        'req.headers.authorization',
        'headers.cookie',
        'headers.authorization',
      ],
      censor: '[REDACTED]',
    },
  });
}
