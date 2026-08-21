/**
 * Operator password reset for the local auth provider
 * (`npm run auth:reset-password -- --email owner@example.com`).
 *
 * Runs on the server with database access — this is the deliberate,
 * console-level recovery path for a forgotten password (local auth has no
 * self-service reset because the deployment may have no email provider).
 * The new password is read from stdin, never from argv (argv leaks into
 * shell history and process lists). All existing sessions for the account
 * are revoked.
 */
import fs from 'node:fs';
import readline from 'node:readline';

try {
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
} catch {
  /* no .env */
}

function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const emailArg = process.argv.find((a) => a.startsWith('--email='));
  const emailFlagIdx = process.argv.indexOf('--email');
  const email = (
    emailArg?.split('=')[1] ?? (emailFlagIdx >= 0 ? process.argv[emailFlagIdx + 1] : undefined)
  )
    ?.trim()
    .toLowerCase();
  if (!email) throw new Error('Usage: npm run auth:reset-password -- --email <address>');

  const { getDb, closeDb } = await import('../server/db/client');
  const schema = await import('../server/db/schema/index');
  const { eq, sql, and, isNull } = await import('drizzle-orm');
  const { hashPassword, validatePasswordPolicy } = await import('../server/auth/passwords');

  const db = getDb();
  const rows = await db
    .select({ userId: schema.users.id, credentialId: schema.userCredentials.id })
    .from(schema.userCredentials)
    .innerJoin(schema.users, eq(schema.userCredentials.userId, schema.users.id))
    .where(sql`lower(${schema.users.email}) = ${email}`)
    .limit(2);
  if (rows.length !== 1) {
    throw new Error(
      rows.length === 0
        ? `No local-auth account exists for ${email}`
        : `Multiple accounts match ${email}; resolve manually`,
    );
  }

  const password = await readPassword(`New password for ${email} (input is visible): `);
  const policyError = validatePasswordPolicy(password, email);
  if (policyError) throw new Error(policyError);

  await db.transaction(async (tx) => {
    await tx
      .update(schema.userCredentials)
      .set({
        passwordHash: await hashPassword(password),
        passwordChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.userCredentials.id, rows[0]!.credentialId));
    await tx
      .update(schema.authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(schema.authSessions.userId, rows[0]!.userId), isNull(schema.authSessions.revokedAt)),
      );
  });
  await closeDb();
  console.log(`Password reset for ${email}; every existing session was signed out.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
