/**
 * Local (first-party) auth provider suite. This file runs in its own forked
 * worker, so setting AUTH_PROVIDER before any server import makes the app
 * select the local adapter while the rest of the suite keeps the test-header
 * adapter.
 */
process.env.AUTH_PROVIDER = 'local';

import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { getApp, resetDatabase } from './helpers';

let app: Express;

const OWNER_EMAIL = 'owner@example.test'; // helpers set BOOTSTRAP_OWNER_EMAIL to this
const OWNER_PASSWORD = 'correct-horse-battery';

// Supertest agents persist cookies like a browser.
function agent() {
  return request.agent(app);
}
const CSRF = { 'X-Requested-With': 'fetch' } as const;

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
});

describe('local auth provider', () => {
  it('reports local mode to the client and ignores test headers', async () => {
    const config = await request(app).get('/api/public/auth-config');
    expect(config.body.mode).toBe('local');

    const spoofed = await request(app)
      .get('/api/v1/me')
      .set('x-test-auth', JSON.stringify({ authProviderId: 'test|x', email: 'x@example.test' }));
    expect(spoofed.body.authenticated).toBe(false);
  });

  it('refuses owner registration for a non-configured email', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register-owner')
      .set(CSRF)
      .send({ email: 'intruder@example.test', password: 'long-enough-pass', name: 'Intruder' });
    expect(res.status).toBe(403);
  });

  it('enforces the password policy', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register-owner')
      .set(CSRF)
      .send({ email: OWNER_EMAIL, password: 'short', name: 'Olive Owner' });
    expect(res.status).toBe(400);
  });

  const owner = agentHolder();
  it('registers the owner, sets a session cookie, and can bootstrap', async () => {
    owner.a = agent();
    const res = await owner.a
      .post('/api/v1/auth/register-owner')
      .set(CSRF)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: 'Olive Owner' });
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']?.[0]).toContain('ledgeros_session=');
    expect(res.headers['set-cookie']?.[0]).toContain('HttpOnly');

    const me = await owner.a.get('/api/v1/me');
    expect(me.body.authenticated).toBe(true);
    expect(me.body.user.email).toBe(OWNER_EMAIL);

    const bootstrap = await owner.a
      .post('/api/v1/bootstrap')
      .set(CSRF)
      .send({ companyName: 'Local Auth Co' });
    expect(bootstrap.status).toBe(201);
  });

  it('closes owner registration after bootstrap', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register-owner')
      .set(CSRF)
      .send({ email: OWNER_EMAIL, password: 'another-password-1', name: 'Copycat' });
    expect(res.status).toBe(409);
  });

  it('rejects cookie-authenticated writes without the CSRF header', async () => {
    // Same session cookie, but no X-Requested-With: the adapter treats the
    // request as anonymous, exactly as a cross-site form post would be.
    const res = await owner.a!.post('/api/v1/customers').send({ displayName: 'CSRF Probe' });
    expect([401, 403]).toContain(res.status);
    const reads = await owner.a!.get('/api/v1/me');
    expect(reads.body.authenticated).toBe(true);
  });

  it('rejects wrong passwords without revealing whether the email exists', async () => {
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .set(CSRF)
      .send({ email: OWNER_EMAIL, password: 'not-the-password' });
    const noSuchUser = await request(app)
      .post('/api/v1/auth/login')
      .set(CSRF)
      .send({ email: 'ghost@example.test', password: 'not-the-password' });
    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(noSuchUser.body.error.message);
  });

  const invited = agentHolder();
  it('a member joins by registering through the invitation token', async () => {
    const roles = await owner.a!.get('/api/v1/roles');
    const bookkeeper = roles.body.items.find((r: { key: string }) => r.key === 'bookkeeper');
    const invite = await owner
      .a!.post('/api/v1/invitations')
      .set(CSRF)
      .send({ email: 'bk@example.test', roleId: bookkeeper.id });
    expect(invite.status).toBe(201);
    const token = new URL(invite.body.inviteUrl).searchParams.get('token')!;

    invited.a = agent();
    const res = await invited.a
      .post('/api/v1/auth/register-with-invitation')
      .set(CSRF)
      .send({ token, password: 'bookkeeper-pass-1', name: 'Billie Books' });
    expect(res.status).toBe(201);

    const me = await invited.a.get('/api/v1/me');
    expect(me.body.authenticated).toBe(true);
    expect(me.body.member).toBe(true);
    expect(me.body.org.roleKey).toBe('bookkeeper');

    // Single use: registering again with the same token fails.
    const reuse = await agent()
      .post('/api/v1/auth/register-with-invitation')
      .set(CSRF)
      .send({ token, password: 'whatever-pass-1', name: 'Second Try' });
    expect(reuse.status).toBe(404);
  });

  it('changing the password revokes every other session', async () => {
    const secondSession = agent();
    const login = await secondSession
      .post('/api/v1/auth/login')
      .set(CSRF)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(login.status).toBe(200);
    expect((await secondSession.get('/api/v1/me')).body.authenticated).toBe(true);

    const change = await owner
      .a!.post('/api/v1/auth/change-password')
      .set(CSRF)
      .send({ currentPassword: OWNER_PASSWORD, newPassword: 'brand-new-password-9' });
    expect(change.status).toBe(200);

    // The other session is dead; the changing session lives on.
    expect((await secondSession.get('/api/v1/me')).body.authenticated).toBe(false);
    expect((await owner.a!.get('/api/v1/me')).body.authenticated).toBe(true);

    // Old password no longer works; the new one does.
    const oldLogin = await request(app)
      .post('/api/v1/auth/login')
      .set(CSRF)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post('/api/v1/auth/login')
      .set(CSRF)
      .send({ email: OWNER_EMAIL, password: 'brand-new-password-9' });
    expect(newLogin.status).toBe(200);
  });

  it('logout revokes the session server-side', async () => {
    const s = agent();
    await s
      .post('/api/v1/auth/login')
      .set(CSRF)
      .send({ email: OWNER_EMAIL, password: 'brand-new-password-9' });
    expect((await s.get('/api/v1/me')).body.authenticated).toBe(true);
    const out = await s.post('/api/v1/auth/logout').set(CSRF);
    expect(out.status).toBe(200);
    expect((await s.get('/api/v1/me')).body.authenticated).toBe(false);
  });
});

function agentHolder(): { a: ReturnType<typeof request.agent> | null } {
  return { a: null };
}
