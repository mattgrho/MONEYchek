import { z } from 'zod';
import { AppError } from './errors';

/**
 * Keyset (cursor) pagination for transactional list endpoints.
 *
 * A cursor encodes the ORDER BY key values of the last row of the previous
 * page (base64url JSON array). It is opaque to clients and validated on the
 * way back in; a malformed or wrong-shape cursor is a 400, never a query
 * error. Cursors are org-scoped by construction because every list query
 * also filters on organization_id.
 */

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().min(1).max(600).optional(),
});
export type PageQueryInput = z.infer<typeof PageQuery>;

export function encodeCursor(values: (string | number)[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, expectedLength: number): (string | number)[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw AppError.validation('Invalid pagination cursor');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expectedLength ||
    parsed.some((v) => typeof v !== 'string' && typeof v !== 'number')
  ) {
    throw AppError.validation('Invalid pagination cursor');
  }
  return parsed as (string | number)[];
}

/**
 * Slice a `limit + 1` row fetch into the page and its next cursor. Fetching
 * one extra row is how we know whether another page exists without a COUNT.
 */
export function pageResult<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => (string | number)[],
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}
