import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, type FieldErrors } from '../lib/errors';
import { logger } from '../lib/logger';
import { getEnv } from '../config/env';

export function zodToFieldErrors(err: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let appError: AppError;
  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof ZodError) {
    appError = AppError.validation('Request validation failed', zodToFieldErrors(err));
  } else {
    appError = AppError.internal();
  }

  if (appError.status >= 500) {
    logger.error(
      { correlationId: req.correlationId, err: err instanceof Error ? err : String(err) },
      'unhandled error',
    );
  }

  const body: {
    error: {
      code: string;
      message: string;
      fieldErrors?: FieldErrors;
      correlationId: string;
      detail?: string;
    };
  } = {
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : 'Something went wrong',
      correlationId: req.correlationId ?? 'unknown',
    },
  };
  if (appError.fieldErrors) body.error.fieldErrors = appError.fieldErrors;
  if (getEnv().NODE_ENV !== 'production' && appError.status >= 500 && err instanceof Error) {
    body.error.detail = err.message;
  }
  res.status(appError.status).json(body);
}
