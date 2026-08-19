# LedgerOS — engineering guide for future sessions

White-label small-business accounting platform. The controlling specification
is the master build prompt (see BUILD_STATUS.md for the current phase). Read
BUILD_STATUS.md first, then `git status`/`git log`, and resume from the first
incomplete gate without replanning completed work.

## Architecture

- One root npm package, one public Express process serving `/api/v1`, health
  routes, and the Vite-built client. Dev mode runs Vite in middleware mode
  inside Express (`server/vite-dev.ts`).
- TypeScript strict everywhere. ESM (`"type": "module"`).
- PostgreSQL via Drizzle ORM (`server/db/schema/*`), committed SQL migrations
  in `db/migrations` applied by `scripts/migrate.ts` (advisory lock + ledger
  table). Never use `drizzle-kit push`. New schema work: edit schema, run
  `npm run db:generate`, review the generated SQL, keep invariants in
  hand-written migrations.
- Money is ALWAYS a canonical decimal string end to end (`shared/money`),
  computed with decimal.js (ROUND_HALF_UP), stored in NUMERIC columns. Never
  `Number()`/`parseFloat` money. JSON money fields are strings.
- Single-company deployment binding lives in `deployment_settings` (one row,
  id=1) created by the atomic bootstrap. Every table still carries
  `organization_id` and every query is organization-scoped.

## Accounting rules (non-negotiable)

- Only the posting engine (`server/accounting/posting.ts`) writes
  `journal_entries`/`journal_lines`. Everything financial goes through it in a
  DB transaction with an idempotency key (`posting_commands`).
- Posted entries are append-only (DB triggers enforce this). Corrections are
  linked reversals + replacements. Voids post reversals and keep the source.
- Debits must equal credits per entry (deferred DB trigger), one positive side
  per line, no negatives.
- AR/AP are control accounts: no manual journal lines may touch them; only
  invoice/payment/credit/write-off workflows.
- Allocation history (payments->invoices, bill payments->bills) is append-only;
  unapply = reversing allocation row.
- Fiscal periods gate posting dates: open / soft_closed (privileged override)
  / hard_closed (rejected).
- Every financial action writes an `audit_events` row in an org-scoped
  hash chain (see `server/accounting/audit.ts`).

## Commands

- `npm run dev` — start dev server (needs `.env`, see `.env.example`)
- `npm run db:migrate` — apply migrations (uses MIGRATION_DATABASE_URL or
  DATABASE_URL); `-- --test` targets TEST_DATABASE_URL with guards
- `npm run db:generate` — drizzle-kit generate from schema
- `npm test` — unit + integration (integration needs TEST_DATABASE_URL)
- `npm run verify` — format:check, lint, typecheck, tests, build
- `npm run verify:release` — verify + release-only gates
- Local Postgres in this container: cluster under /var/lib/pgrun (user
  postgres, port 5432); start with
  `su -s /bin/bash postgres -c "nohup setsid /usr/lib/postgresql/16/bin/postgres -D /var/lib/pgrun/data >> /var/lib/pgrun/pg.log 2>&1 < /dev/null &"`

## Conventions

- API: `/api/v1`, zod-validated at every boundary, stable error envelope
  (`server/middleware/errors.ts`), money as strings, cursor/bounded pagination.
- Auth: adapter interface in `server/auth/`; Clerk in production, test-only
  header adapter that refuses to load unless NODE_ENV=test. No dev bypass.
- Permissions: `resource.action` keys in `shared/permissions`; enforced
  server-side on every route; role presets seeded per organization.
- Client: React + TanStack Query in `client/src`; pages under `pages/`,
  shadcn-style primitives under `components/ui/`.
- Tests: `tests/unit` (no DB), `tests/integration` (real Postgres, fresh
  schema per run via `tests/global-setup.ts`), `tests/e2e` (Playwright).
