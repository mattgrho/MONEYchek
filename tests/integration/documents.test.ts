import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { OWNER, authHeader, bootstrapCompany, getApp, identity, resetDatabase } from './helpers';

let app: Express;
let customerId: string;
let invoiceId: string;
let checkingId: string;

async function post(url: string, body: unknown, as = OWNER) {
  return request(app)
    .post(url)
    .set('x-test-auth', authHeader(as))
    .send(body as object);
}
async function get(url: string, as = OWNER) {
  return request(app).get(url).set('x-test-auth', authHeader(as));
}

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
  const orgId = await bootstrapCompany(app, 'Docs Test Co');
  const { getDb } = await import('@server/db/client');
  const { applyChartTemplate } = await import('@server/accounting/accounts');
  await getDb().transaction(async (tx) => {
    await applyChartTemplate(tx, orgId, 'general_service');
  });
  const accounts = await get('/api/v1/accounts');
  checkingId = accounts.body.items.find((a: { name: string }) => a.name === 'Checking').id;

  // A customer whose name is a spreadsheet-formula-injection attempt.
  const customer = await post('/api/v1/customers', {
    displayName: '=HYPERLINK("http://evil.test","Client A")',
  });
  customerId = customer.body.id;
  const product = await post('/api/v1/products', {
    type: 'service',
    name: 'Advisory',
    salesPrice: '400',
  });
  const invoice = await post('/api/v1/invoices', {
    customerId,
    invoiceDate: '2025-05-01',
    lines: [{ productId: product.body.id, quantity: '2', unitPrice: '400' }],
  });
  invoiceId = invoice.body.id;
  await post(`/api/v1/invoices/${invoiceId}/post`, { idempotencyKey: 'docs-inv-1' });
  await post('/api/v1/payments', {
    customerId,
    paymentDate: '2025-05-10',
    amount: '300',
    depositToAccountId: checkingId,
    allocations: [{ invoiceId, amount: '300' }],
    idempotencyKey: 'docs-pay-1',
  });
});

describe('branded PDFs', () => {
  it('renders the invoice PDF from the frozen snapshot with balance due', async () => {
    const res = await get(`/api/v1/invoices/${invoiceId}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.length).toBeGreaterThan(1500);
    expect(Buffer.from(res.body).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('renders a customer statement that ties to the AR subledger', async () => {
    const json = await get(`/api/v1/customers/${customerId}/statement?asOf=2025-05-31`);
    expect(json.status).toBe(200);
    expect(json.body.endingBalance).toBe('500.00');
    const aging = await get('/api/v1/reports/ar-aging?asOf=2025-05-31');
    expect(aging.body.total).toBe(json.body.endingBalance);

    const pdf = await get(`/api/v1/customers/${customerId}/statement?asOf=2025-05-31&format=pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });
});

describe('CSV exports', () => {
  it('neutralizes spreadsheet formula injection while keeping numbers numeric', async () => {
    const res = await get('/api/v1/reports/trial-balance?asOf=2025-05-31&format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = res.text;
    expect(text).toContain('TOTAL,800.00,800.00');
    // No cell may begin with a bare "=" (quoted or not).
    for (const line of text.split('\r\n')) {
      for (const cell of line.split(',')) {
        expect(cell.startsWith('=')).toBe(false);
        expect(cell.startsWith('"=')).toBe(false);
      }
    }
  });
});

describe('owner full export', () => {
  it('streams every table with a manifest of counts and checksums', async () => {
    const res = await get('/api/v1/exports/full');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.format).toBe('ledgeros-full-export');
    expect(body.tables.invoices.length).toBe(1);
    expect(body.tables.journal_entries.length).toBeGreaterThanOrEqual(2);
    expect(body.manifest.invoices.rows).toBe(1);
    expect(body.manifest.journal_lines.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Money fields exported as strings, never JSON numbers.
    expect(typeof body.tables.invoices[0].total).toBe('string');
  });

  it('is denied to members without export permission', async () => {
    const clerk = identity('docs-clerk@example.test');
    const roles = await get('/api/v1/roles');
    const viewerRole = roles.body.items.find((r: { key: string }) => r.key === 'reports_viewer');
    const invite = await post('/api/v1/invitations', {
      email: clerk.email,
      roleId: viewerRole.id,
    });
    const token = new URL(invite.body.inviteUrl).searchParams.get('token')!;
    await post('/api/v1/invitations/accept', { token }, clerk);
    const res = await get('/api/v1/exports/full', clerk);
    expect(res.status).toBe(403);
  });
});

describe('attachments', () => {
  it('accepts a valid PDF, rejects extension/content mismatches, serves download', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    const upload = await request(app)
      .post('/api/v1/attachments')
      .set('x-test-auth', authHeader(OWNER))
      .field('kind', 'receipt')
      .attach('file', pdfBytes, { filename: 'receipt.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);
    expect(upload.body.scanState).toBe('unscanned_download_only');
    expect(upload.body.storageKey).toMatch(/^[0-9a-f]{48}$/);

    const bad = await request(app)
      .post('/api/v1/attachments')
      .set('x-test-auth', authHeader(OWNER))
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), {
        filename: 'evil.pdf',
        contentType: 'application/pdf',
      });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('FILE_CONTENT_MISMATCH');

    const svg = await request(app)
      .post('/api/v1/attachments')
      .set('x-test-auth', authHeader(OWNER))
      .attach('file', Buffer.from('<svg onload="alert(1)"/>'), {
        filename: 'image.svg',
        contentType: 'image/svg+xml',
      });
    expect(svg.status).toBe(422);

    const download = await get(`/api/v1/attachments/${upload.body.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['content-type']).toBe('application/octet-stream');

    const link = await post(`/api/v1/attachments/${upload.body.id}/link`, {
      entityType: 'invoice',
      entityId: invoiceId,
    });
    expect(link.status).toBe(200);
    const del = await request(app)
      .delete(`/api/v1/attachments/${upload.body.id}`)
      .set('x-test-auth', authHeader(OWNER));
    expect(del.status).toBe(409); // linked files are retained
  });
});
