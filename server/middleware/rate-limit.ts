import type { NextFunction, Request, Response } from 'express';
import { getPool } from '../db/client';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * Fixed-window rate limiter backed by PostgreSQL so limits hold across
 * multiple Autoscale instances. Keys combine the limiter name with the
 * authenticated user (preferred) or the client IP (Express is configured
 * with trust proxy for Replit's perimeter).
 */
export function rateLimit(options: { name: string; limit: number; windowSeconds: number }) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const who = req.userId ?? req.ip ?? 'anonymous';
      const key = `${options.name}:${who}`;
      const result = await getPool().query<{ count: number }>(
        `INSERT INTO rate_limit_buckets (key, window_start, count)
         VALUES ($1, now(), 1)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE
             WHEN rate_limit_buckets.window_start < now() - make_interval(secs => $2)
             THEN 1 ELSE rate_limit_buckets.count + 1 END,
           window_start = CASE
             WHEN rate_limit_buckets.window_start < now() - make_interval(secs => $2)
             THEN now() ELSE rate_limit_buckets.window_start END
         RETURNING count`,
        [key, options.windowSeconds],
      );
      const count = result.rows[0]?.count ?? 0;
      if (count > options.limit) {
        next(AppError.tooManyRequests());
        return;
      }
      next();
    } catch (err) {
      // Rate limiting must not take the product down, but log loudly.
      logger.error({ err: (err as Error).message }, 'rate limiter failure');
      next();
    }
  };
}
