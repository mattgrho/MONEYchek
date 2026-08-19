import type { z } from 'zod';
import type { Request } from 'express';
import { AppError } from '../lib/errors';
import { zodToFieldErrors } from './error-handler';

/** Parses and returns req.body against a schema (400 with field errors). */
export function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw AppError.validation('Request validation failed', zodToFieldErrors(result.error));
  }
  return result.data;
}

export function parseQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw AppError.validation('Query validation failed', zodToFieldErrors(result.error));
  }
  return result.data;
}

export function parseParams<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const result = schema.safeParse(req.params);
  if (!result.success) {
    throw AppError.validation('Path validation failed', zodToFieldErrors(result.error));
  }
  return result.data;
}

/** Wraps an async route handler so rejections reach the error middleware. */
export function asyncHandler<
  H extends (req: Request, res: import('express').Response) => Promise<unknown>,
>(handler: H) {
  return (req: Request, res: import('express').Response, next: import('express').NextFunction) => {
    handler(req, res).catch(next);
  };
}
