import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { OWNER, authHeader, bootstrapCompany, getApp, resetDatabase } from './helpers';

let app: Express;
let orgId: string;

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
  orgId = await bootstrapCompany(app, 'Outbox Test Co');
});

describe('email outbox', () => {
  it('creating an invitation queues exactly one email event transactionally', async () => {
    const rolesRes = await get('/api/v1/roles');
    const role = rolesRes.body.items.find((r: { key: string }) => r.key === 'bookkeeper');
    const invite = await post('/api/v1/invitations', {
      email: 'newhire@example.test',
      roleId: role.id,
    });
    expect(invite.status).toBe(201);

    const { getDb } = await import('@server/db/client');
    const { outboxEvents } = await import('@server/db/schema/index');
    const { eq } = await import('drizzle-orm');
    const rows = await getDb()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.organizationId, orgId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.jobType).toBe('email.invitation');
    expect(rows[0]!.state).toBe('pending');
    const payload = rows[0]!.payload as { to: string; subject: string; text: string };
    expect(payload.to).toBe('newhire@example.test');
    expect(payload.text).toContain('/accept-invitation?token=');
  });

  it('the drain delivers via the adapter and scrubs the queued body', async () => {
    const { getDb } = await import('@server/db/client');
    const { drainEmailOutbox } = await import('@server/services/outbox');
    const { capturedTestEmails } = await import('@server/email/adapter');
    const before = capturedTestEmails.length;

    const result = await drainEmailOutbox(getDb());
    expect(result.skippedNoProvider).toBe(false);
    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);

    expect(capturedTestEmails.length).toBe(before + 1);
    const email = capturedTestEmails[capturedTestEmails.length - 1]!;
    expect(email.to).toBe('newhire@example.test');
    expect(email.text).toContain('/accept-invitation?token=');

    const { outboxEvents } = await import('@server/db/schema/index');
    const { eq } = await import('drizzle-orm');
    const rows = await getDb()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.organizationId, orgId));
    expect(rows[0]!.state).toBe('completed');
    const payload = rows[0]!.payload as { text: string; providerMessageId: string };
    // The live accept link must not be retained after delivery.
    expect(payload.text).not.toContain('token=');
    expect(payload.providerMessageId).toMatch(/^test-/);
  });

  it('a second drain finds nothing to do', async () => {
    const { getDb } = await import('@server/db/client');
    const { drainEmailOutbox } = await import('@server/services/outbox');
    const result = await drainEmailOutbox(getDb());
    expect(result.claimed).toBe(0);
  });

  it('the invitation link from the queued email is genuinely usable once', async () => {
    const { capturedTestEmails } = await import('@server/email/adapter');
    const email = capturedTestEmails[capturedTestEmails.length - 1]!;
    const url = email.text.match(/\/accept-invitation\?token=([0-9a-f]{64})/);
    expect(url).toBeTruthy();
    const accept = await request(app)
      .post('/api/v1/invitations/accept')
      .set(
        'x-test-auth',
        JSON.stringify({
          authProviderId: 'test|newhire@example.test',
          email: 'newhire@example.test',
          name: 'New Hire',
        }),
      )
      .send({ token: url![1] });
    expect(accept.status).toBe(200);
  });
});
