/**
 * Central application error type and the stable API error envelope:
 * { error: { code, message, fieldErrors?, correlationId } }
 * Stack traces never leave the server in production.
 */

export type FieldErrors = Record<string, string[]>;

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: FieldErrors | undefined;
  readonly expose: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: { fieldErrors?: FieldErrors; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fieldErrors = options?.fieldErrors;
    this.expose = status < 500;
  }

  static badRequest(message: string, fieldErrors?: FieldErrors): AppError {
    return new AppError(400, 'BAD_REQUEST', message, { fieldErrors });
  }
  static validation(message: string, fieldErrors?: FieldErrors): AppError {
    return new AppError(400, 'VALIDATION_ERROR', message, { fieldErrors });
  }
  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have permission to do that'): AppError {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Not found'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }
  static conflict(code: string, message: string): AppError {
    return new AppError(409, code, message);
  }
  static unprocessable(code: string, message: string, fieldErrors?: FieldErrors): AppError {
    return new AppError(422, code, message, { fieldErrors });
  }
  static tooManyRequests(message = 'Too many requests; slow down'): AppError {
    return new AppError(429, 'RATE_LIMITED', message);
  }
  static serviceUnavailable(code: string, message: string): AppError {
    return new AppError(503, code, message);
  }
  static internal(message = 'Something went wrong'): AppError {
    return new AppError(500, 'INTERNAL_ERROR', message);
  }
}
