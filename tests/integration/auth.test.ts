import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { OWNER, authHeader, bootstrapCompany, getApp, identity, resetDatabase } from './helpers';

let app: Express;

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
});

describe('health', () => {
  it('live responds instantly', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
  });

  it('ready verifies database and schema', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.database).toBe('ok');
    expect(res.body.checks.schema).toBe('ok');
  });
});

describe('secure owner bootstrap', () => {
  it('rejects anonymous bootstrap', async () => {
    const res = await request(app).post('/api/v1/bootstrap').send({ companyName: 'X' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an unauthorized email', async () => {
    const res = await request(app)
      .post('/api/v1/bootstrap')
      .set('x-test-auth', authHeader(identity('intruder@example.test')))
      .send({ companyName: 'Hostile Takeover LLC' });
    expect(res.status).toBe(403);
  });

  it('lets the authorized owner claim the deployment exactly once', async () => {
    const orgId = await bootstrapCompany(app, 'Riverbend Services');
    expect(orgId).toMatch(/^[0-9a-f-]{36}$/);

    const again = await request(app)
      .post('/api/v1/bootstrap')
      .set('x-test-auth', authHeader(OWNER))
      .send({ companyName: 'Second Claim Inc' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_BOOTSTRAPPED');
  });

  it('gives the owner full membership context', async () => {
    const res = await request(app).get('/api/v1/me').set('x-test-auth', authHeader(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.member).toBe(true);
    expect(res.body.org.roleKey).toBe('owner');
    expect(res.body.org.permissions).toEqual(['*']);
    expect(res.body.company.displayName).toBe('Riverbend Services');
  });

  it('authenticated strangers are not members', async () => {
    const res = await request(app)
      .get('/api/v1/me')
      .set('x-test-auth', authHeader(identity('stranger@example.test')));
    expect(res.status).toBe(200);
    expect(res.body.member).toBe(false);

    const members = await request(app)
      .get('/api/v1/members')
      .set('x-test-auth', authHeader(identity('stranger@example.test')));
    expect(members.status).toBe(403);
  });
});

describe('invitations and RBAC', () => {
  const bookkeeper = identity('bk@example.test', 'Billie Books');

  it('owner invites a bookkeeper; matching email accepts once', async () => {
    const rolesRes = await request(app).get('/api/v1/roles').set('x-test-auth', authHeader(OWNER));
    expect(rolesRes.status).toBe(200);
    const bookkeeperRole = rolesRes.body.items.find((r: { key: string }) => r.key === 'bookkeeper');
    expect(bookkeeperRole).toBeTruthy();

    const inviteRes = await request(app)
      .post('/api/v1/invitations')
      .set('x-test-auth', authHeader(OWNER))
      .send({ email: bookkeeper.email, roleId: bookkeeperRole.id });
    expect(inviteRes.status).toBe(201);
    const token = new URL(inviteRes.body.inviteUrl).searchParams.get('token')!;
    expect(token.length).toBe(64);

    // Wrong email cannot use the token.
    const wrong = await request(app)
      .post('/api/v1/invitations/accept')
      .set('x-test-auth', authHeader(identity('other@example.test')))
      .send({ token });
    expect(wrong.status).toBe(403);

    const accept = await request(app)
      .post('/api/v1/invitations/accept')
      .set('x-test-auth', authHeader(bookkeeper))
      .send({ token });
    expect(accept.status).toBe(200);

    // Single use.
    const reuse = await request(app)
      .post('/api/v1/invitations/accept')
      .set('x-test-auth', authHeader(bookkeeper))
      .send({ token });
    expect(reuse.status).toBe(409);
  });

  it('enforces permissions server-side regardless of UI', async () => {
    const me = await request(app).get('/api/v1/me').set('x-test-auth', authHeader(bookkeeper));
    expect(me.body.org.roleKey).toBe('bookkeeper');

    const members = await request(app)
      .get('/api/v1/members')
      .set('x-test-auth', authHeader(bookkeeper));
    expect(members.status).toBe(403);

    const invite = await request(app)
      .post('/api/v1/invitations')
      .set('x-test-auth', authHeader(bookkeeper))
      .send({ email: 'x@example.test', roleId: '00000000-0000-0000-0000-000000000000' });
    expect(invite.status).toBe(403);
  });

  it('membership removal takes effect immediately', async () => {
    const membersRes = await request(app)
      .get('/api/v1/members')
      .set('x-test-auth', authHeader(OWNER));
    const bk = membersRes.body.items.find((m: { email: string }) => m.email === bookkeeper.email);
    const removed = await request(app)
      .patch(`/api/v1/members/${bk.membershipId}`)
      .set('x-test-auth', authHeader(OWNER))
      .send({ status: 'removed' });
    expect(removed.status).toBe(200);

    const me = await request(app).get('/api/v1/me').set('x-test-auth', authHeader(bookkeeper));
    expect(me.body.member).toBe(false);
  });

  it('never removes the last owner', async () => {
    const membersRes = await request(app)
      .get('/api/v1/members')
      .set('x-test-auth', authHeader(OWNER));
    const ownerRow = membersRes.body.items.find((m: { email: string }) => m.email === OWNER.email);
    const res = await request(app)
      .patch(`/api/v1/members/${ownerRow.membershipId}`)
      .set('x-test-auth', authHeader(OWNER))
      .send({ status: 'removed' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_OWNER');
  });
});

describe('tenant isolation skeleton', () => {
  it('members of a second organization get no access to the primary one', async () => {
    // Simulate a second tenant existing in the same database.
    const { getDb } = await import('@server/db/client');
    const { organizations, roles, memberships, users } = await import('@server/db/schema/index');
    const db = getDb();
    const [orgB] = await db.insert(organizations).values({ name: 'Tenant B' }).returning();
    const [roleB] = await db
      .insert(roles)
      .values({
        organizationId: orgB!.id,
        key: 'owner',
        name: 'Owner',
        permissions: ['*'],
        isSystem: true,
      })
      .returning();
    const [userB] = await db
      .insert(users)
      .values({ authProviderId: 'test|tenant-b@example.test', email: 'tenant-b@example.test' })
      .returning();
    await db.insert(memberships).values({
      organizationId: orgB!.id,
      userId: userB!.id,
      roleId: roleB!.id,
    });

    const me = await request(app)
      .get('/api/v1/me')
      .set('x-test-auth', authHeader(identity('tenant-b@example.test')));
    expect(me.status).toBe(200);
    // Tenant B's owner is NOT a member of the primary (deployed) organization.
    expect(me.body.member).toBe(false);

    const members = await request(app)
      .get('/api/v1/members')
      .set('x-test-auth', authHeader(identity('tenant-b@example.test')));
    expect(members.status).toBe(403);
  });
});
