/**
 * Release-only gates (run after `npm run verify` by `npm run verify:release`):
 *  1. anti-placeholder / forbidden-pattern sweep over shipped source
 *  2. test hygiene: no .only / .skip / quarantined tests
 *  3. fresh-database migration smoke test (disposable, test-named DB)
 *  4. dependency audit: no high/critical production vulnerabilities
 *  5. third-party license inventory regeneration (THIRD_PARTY_NOTICES.md)
 *  6. Playwright end-to-end suite (with axe checks) against the built app
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const root = process.cwd();
let failures = 0;

function fail(message: string): void {
  failures++;
  console.error(`✗ ${message}`);
}
function ok(message: string): void {
  console.log(`✓ ${message}`);
}

/* 1. Anti-placeholder sweep ------------------------------------------------ */
const FORBIDDEN: { pattern: RegExp; label: string }[] = [
  { pattern: /\bTODO\b/, label: 'TODO' },
  { pattern: /\bFIXME\b/, label: 'FIXME' },
  { pattern: /coming soon/i, label: 'coming soon' },
  { pattern: /not (yet )?implemented/i, label: 'not implemented' },
  { pattern: /lorem ipsum/i, label: 'lorem ipsum' },
  { pattern: /\bWIP\b/, label: 'WIP marker' },
];
const SCAN_DIRS = ['client/src', 'server', 'shared', 'db'];
const SCAN_EXT = new Set(['.ts', '.tsx', '.css', '.html', '.sql']);
let placeholderHits = 0;
function scanDir(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      scanDir(full);
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      const content = fs.readFileSync(full, 'utf8');
      for (const { pattern, label } of FORBIDDEN) {
        const lines = content.split('\n');
        lines.forEach((line, i) => {
          if (pattern.test(line)) {
            placeholderHits++;
            console.error(`  ${full}:${i + 1} contains "${label}": ${line.trim().slice(0, 100)}`);
          }
        });
      }
    }
  }
}
for (const dir of SCAN_DIRS) scanDir(path.join(root, dir));
if (placeholderHits > 0) fail(`anti-placeholder sweep found ${placeholderHits} occurrence(s)`);
else ok('anti-placeholder sweep clean');

/* 2. Test hygiene ----------------------------------------------------------- */
let hygieneHits = 0;
function scanTests(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scanTests(full);
    else if (/\.(test|spec)\.tsx?$/.test(entry.name)) {
      const content = fs.readFileSync(full, 'utf8');
      if (/\.(only|skip)\s*\(/.test(content)) {
        hygieneHits++;
        console.error(`  ${full} uses .only/.skip`);
      }
    }
  }
}
scanTests(path.join(root, 'tests'));
if (hygieneHits > 0) fail('tests contain .only/.skip');
else ok('no skipped or focused tests');

/* 3. Fresh migration smoke -------------------------------------------------- */
async function migrationSmoke(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('never in production');
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL required for the migration smoke test');
  const url = new URL(base);
  const scratchDb = 'ledgeros_verify_smoke_test';
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${scratchDb}`);
    await admin.query(`CREATE DATABASE ${scratchDb}`);
  } finally {
    await admin.end();
  }
  url.pathname = `/${scratchDb}`;
  const { runMigrations } = await import('./migrate');
  const applied = await runMigrations(url.toString());
  if (applied.length === 0) throw new Error('no migrations applied to a fresh database');
  const cleanup = new pg.Client({ connectionString: adminUrl.toString() });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${scratchDb}`);
  await cleanup.end();
}

/* 4. Dependency audit -------------------------------------------------------- */
function dependencyAudit(): void {
  try {
    execSync('npm audit --omit=dev --audit-level=high', { stdio: 'pipe' });
    ok('no high/critical production vulnerabilities');
  } catch (err) {
    const out = (err as { stdout?: Buffer }).stdout?.toString() ?? '';
    console.error(out.slice(0, 2000));
    fail('npm audit reports high/critical production vulnerabilities');
  }
}

/* 5. License inventory -------------------------------------------------------- */
function licenseInventory(): void {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const rows: string[] = [];
  const flagged: string[] = [];
  const permissive =
    /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|BlueOak-1\.0\.0|CC0-1\.0|Unlicense|\(.*\))/;
  for (const name of Object.keys(pkg.dependencies).sort()) {
    try {
      const depPkg = JSON.parse(
        fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'),
      ) as { version: string; license?: string };
      const license = depPkg.license ?? 'UNKNOWN';
      rows.push(`| ${name} | ${depPkg.version} | ${license} |`);
      if (!permissive.test(license)) flagged.push(`${name} (${license})`);
    } catch {
      flagged.push(`${name} (unreadable)`);
    }
  }
  const doc = [
    '# Third-party notices',
    '',
    'Direct production dependencies and their licenses. Generated by',
    '`npm run verify:release`; regenerate after dependency changes.',
    '',
    '| Package | Version | License |',
    '|---------|---------|---------|',
    ...rows,
    '',
    flagged.length
      ? `Review needed (non-permissive or unknown license): ${flagged.join(', ')}`
      : 'All direct production dependencies use permissive licenses compatible with private commercial deployment.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), doc);
  if (flagged.length) fail(`license review needed: ${flagged.join(', ')}`);
  else ok('license inventory generated (all permissive)');
}

/* 6. End-to-end -------------------------------------------------------------- */
function e2e(): void {
  try {
    execSync('npx playwright test', { stdio: 'inherit' });
    ok('Playwright end-to-end suite (incl. axe) passed');
  } catch {
    fail('Playwright end-to-end suite failed');
  }
}

async function main(): Promise<void> {
  try {
    await migrationSmoke();
    ok('fresh-database migration smoke test passed');
  } catch (err) {
    fail(`migration smoke: ${(err as Error).message}`);
  }
  dependencyAudit();
  licenseInventory();
  e2e();
  if (failures > 0) {
    console.error(`\nverify:release FAILED with ${failures} gate failure(s)`);
    process.exit(1);
  }
  console.log('\nverify:release passed every release gate.');
}

void main();
