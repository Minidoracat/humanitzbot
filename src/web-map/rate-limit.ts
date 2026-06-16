/**
 * Per-IP + path rate limiter factory shared by web-map routes.
 *
 * Extracted verbatim from web-map/server.ts (P1-1 god-file split). Each call
 * returns a fresh express-rate-limit middleware with its own MemoryStore — do
 * NOT hoist the returned instance into a module constant; identity is per
 * call-site by design, keyed on `<ip>:<req.path>`.
 */

import expressRateLimit from 'express-rate-limit';
import { API_ERRORS, sendError } from './api-errors.js';

export function rateLimit(windowMs: number, maxReqs: number) {
  return expressRateLimit({
    windowMs,
    max: maxReqs,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => {
      // Normalize IPv6-mapped IPv4 (::ffff:1.2.3.4 → 1.2.3.4) for consistent rate limiting
      const raw = req.ip ?? 'unknown';
      const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
      return ip + ':' + req.path;
    },
    validate: { keyGeneratorIpFallback: false },
    handler: (_req, res) => {
      sendError(res, API_ERRORS.RATE_LIMITED, 429);
    },
  });
}
