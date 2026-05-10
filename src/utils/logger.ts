import pino, { type Logger, type LoggerOptions } from 'pino';
import { env, isProd } from '../config/env.js';

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: 'splitzy-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Defense in depth: even if a developer accidentally logs an object that
  // includes a token field, Pino replaces it before serialization. The
  // wildcard paths catch nested shapes without enumerating every depth.
  redact: {
    paths: [
      // HTTP request headers
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers.cookie',
      'headers.authorization',
      'headers.cookie',
      // Common sensitive field names — anywhere in the log object tree
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.tokenHash',
      '*.accessToken',
      '*.refreshToken',
      '*.challengeToken',
      '*.otp',
      '*.devOtp',
      // Two-deep variants for objects like { auth: { ... } }
      '*.*.password',
      '*.*.token',
      '*.*.refreshToken',
      '*.*.accessToken',
      '*.*.otp',
    ],
    censor: '[REDACTED]',
    remove: false,
  },
};

const prettyTransport: LoggerOptions = {
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname,service',
    },
  },
};

export const logger: Logger = pino({
  ...baseOptions,
  ...(isProd ? {} : prettyTransport),
});
