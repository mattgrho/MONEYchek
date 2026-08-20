import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { OWNER, authHeader, bootstrapCompany, getApp, resetDatabase } from './helpers';

let app: Express;
let customerId: string;
const invoiceIds: string[] = [];

async function post(url: string, body: unknown) {
  return request(app)
    .post(url)
    .set('x-test-auth', authHeader(OWNER))
    .send(body as object);
}
async function get(url: string) {
  return request(app).get(url).set('x-test-auth', authHeader(OWNER));
}

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
  const orgId = await bootstrapCompany(app, 'Pagination Test Co');
  const { getDb } = await import('@server/db/client');
  const { applyChartTemplate } = await import('@server/accounting/accounts');
  await getDb().transaction(async (tx) => {
    await applyChartTemplate(tx, orgId, 'general_service');
  });
  const customer = await post('/api/v1/customers', { displayName: 'Cursor Customer' });
  expect(customer.status).toBe(201);
  customerId = customer.body.id;

  for (let i = 0; i < 7; i++) {
    const day = String(i + 1).padStart(2, '0');
    const res = await post('/api/v1/invoices', {
      customerId,
      invoiceDate: `2026-03-${day}`,
      lines: [{ description: `Work day ${day}`, quantity: '1', unitPrice: '100' }],
    });
    expect(res.status).toBe(201);
    invoiceIds.push(res.body.id);
  }
  // Posting is audited; post them all so the audit log has enough events
  // to exercise seq-based pagination.
  for (const [i, id] of invoiceIds.entries()) {
    const posted = await post(`/api/v1/invoices/${id}/post`, {
      idempotencyKey: `pagination-post-${i}-0001`,
    });
    expect(posted.status).toBe(200);
  }
});

describe('cursor pagination', () => {
  it('walks every invoice exactly once across pages', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/api/v1/invoices?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await get(url);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(3);
      for (const item of res.body.items as { id: string }[]) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen.size).toBe(7);
    expect(pages).toBe(3); // 3 + 3 + 1
  });

  it('orders newest first and keeps order stable across page boundaries', async () => {
    const page1 = await get('/api/v1/invoices?limit=4');
    expect(page1.status).toBe(200);
    const page2 = await get(
      `/api/v1/invoices?limit=4&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    expect(page2.status).toBe(200);
    const all = [...page1.body.items, ...page2.body.items] as { invoiceDate: string }[];
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1]!.invoiceDate >= all[i]!.invoiceDate).toBe(true);
    }
    expect(page2.body.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor with 400, not a query error', async () => {
    const res = await get('/api/v1/invoices?cursor=not-a-cursor');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('paginates the audit log by seq with beforeSeq applied', async () => {
    const page1 = await get('/api/v1/audit-log?limit=5');
    expect(page1.status).toBe(200);
    expect(page1.body.items.length).toBe(5);
    expect(page1.body.nextBeforeSeq).toBe(page1.body.items[4].seq);
    const page2 = await get(`/api/v1/audit-log?limit=5&beforeSeq=${page1.body.nextBeforeSeq}`);
    expect(page2.status).toBe(200);
    for (const ev of page2.body.items as { seq: number }[]) {
      expect(ev.seq).toBeLessThan(page1.body.nextBeforeSeq);
    }
  });
});
