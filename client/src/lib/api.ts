/**
 * Typed API client. All requests carry credentials/authorization supplied by
 * the active auth mode; errors arrive as the stable envelope and are thrown
 * as ApiError.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
  correlationId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: Record<string, string[]> | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.fieldErrors = body.fieldErrors;
  }
}

type TokenGetter = () => Promise<string | null>;
let tokenGetter: TokenGetter | null = null;

/** Registered by the Clerk bridge; test/disabled modes leave it null. */
export function setTokenGetter(getter: TokenGetter | null): void {
  tokenGetter = getter;
}

async function requestJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (tokenGetter) {
    const token = await tokenGetter();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // fallthrough to status handling
  }
  if (!res.ok) {
    const err = (json as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(
      res.status,
      err ?? { code: 'UNKNOWN', message: `Request failed (${res.status})` },
    );
  }
  return json as T;
}

export const api = {
  get: <T>(url: string) => requestJson<T>('GET', url),
  post: <T>(url: string, body?: unknown) => requestJson<T>('POST', url, body),
  patch: <T>(url: string, body?: unknown) => requestJson<T>('PATCH', url, body),
  put: <T>(url: string, body?: unknown) => requestJson<T>('PUT', url, body),
  delete: <T>(url: string) => requestJson<T>('DELETE', url),
};

/** Multipart upload with the same auth handling as JSON requests. */
export async function apiUpload<T>(url: string, formData: FormData): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const getter = tokenGetter;
  if (getter) {
    const token = await getter();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: formData,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // handled below
  }
  if (!res.ok) {
    const err = (json as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(
      res.status,
      err ?? { code: 'UNKNOWN', message: `Upload failed (${res.status})` },
    );
  }
  return json as T;
}
