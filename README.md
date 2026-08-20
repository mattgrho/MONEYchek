# MONEYchek — white-label accounting OS (working name: LedgerOS)

A business-owned, white-label, double-entry accounting platform for small
service businesses, built to run on Replit with a company-owned custom domain.
The deploying business controls its code, brand, users, configuration,
exports, and data. There is no vendor branding, no call-home service, and no
undeclared external dependency.

**Status: Prototype Core (source-complete for the covered workflows).** The
gates that have passed, the ones that have not, and every external
prerequisite are listed truthfully in [BUILD_STATUS.md](BUILD_STATUS.md).

## What genuinely works today

- **Secure single-company deployment**: authenticated owner bootstrap bound to
  `BOOTSTRAP_OWNER_EMAIL`, invitations (single-use hashed tokens, email-bound),
  preset least-privilege roles, and server-enforced permissions on every route.
- **White-label at runtime**: resumable onboarding wizard (company → brand →
  accounting → chart of accounts → review); brand colors/theme/application
  name restyle the login page, shell, browser title, and generated PDFs with
  zero code edits. Logo upload supported (PNG/JPEG/WebP brand assets).
- **A true double-entry general ledger**: one posting engine writes every
  journal entry; debits must equal credits (enforced again by database
  triggers); posted entries and audit events are append-only at the database
  level; corrections are linked reversals; every financial command is
  idempotent; every action lands in an org-scoped, hash-chained audit log.
- **Quote to cash**: customers, service/non-inventory products, manual tax
  rates, estimates with partial conversion (overbilling blocked), invoices
  (draft → post freezes the document), payments with append-only allocations
  and oldest-first auto-apply, credit memos, refunds of unapplied credit,
  bad-debt write-offs, voids with exact reversal, Undeposited Funds and
  grouped deposits, sales receipts, branded invoice/estimate/credit-memo PDFs
  and open-item customer statements (JSON + PDF).
- **Purchase to pay**: vendors, bills with one-step approval (threshold +
  separation of duties), expenses/check/card purchases, vendor credits with
  application, bill payments with validated allocations.
- **Banking**: CSV statement import (mapping, dry run, idempotent execution,
  duplicate staging for human review), match/categorize/split/transfer/
  exclude, bank rules (suggested-only by default), bank and credit-card
  reconciliation with exact-zero completion and immutable snapshots.
- **Reports** (accrual): Profit & Loss, Balance Sheet (retained earnings
  presented without an auto-journal), Trial Balance, General Ledger, Journal,
  AR/AP aging with control-account tie-outs asserted, account registers,
  audit log with chain verification. CSV export with formula-injection
  protection; PDF documents render server-side deterministically.
- **Data ownership**: audited owner full-data export (every table + manifest
  with row counts and checksums), private attachments with type/magic-byte
  validation behind a storage adapter.
- **The mandatory golden dataset (spec §30) passes end to end**, including
  FIFO COGS ($95), the 12.375 → 12.38 tax rounding, $10,117.38 balance-sheet
  equation, aging tie-outs, idempotent replay, and ledger hash rebuild.

## Architecture

- One root npm package, one public Express process (`0.0.0.0:$PORT`) serving
  `/api/v1`, health routes, and the Vite-built React client. Development runs
  Vite in middleware mode inside Express — one port, no second server.
- TypeScript strict everywhere; ESM; React 18 + TanStack Query/Table +
  Tailwind + Radix; Express 4; Drizzle ORM on PostgreSQL; decimal.js.
- **Money is a canonical decimal string end to end** (JSON, forms, domain,
  NUMERIC columns). Binary floats are never used for money; a lint rule bans
  `parseFloat`, and contract tests reject numeric financial payloads.
- Layout: `client/` (React app), `server/` (Express, domain services,
  posting engine, reports, PDFs), `shared/` (money, document math,
  permissions), `db/migrations` (committed SQL), `db/seeds`, `tests/`
  (unit, integration, e2e), `scripts/`.
- Business rules live in `server/services` and `server/accounting`; route
  handlers validate with Zod and delegate. Only
  `server/accounting/posting.ts` writes journal rows.

### Accounting invariants (enforced, not aspirational)

- Journal lines: exactly one positive side, no negatives (DB CHECK); entries
  balance (deferred DB trigger) and have ≥ 2 lines; posted journals, lines,
  audit events, and allocation history are append-only (DB triggers).
- AR and AP are protected control accounts: manual journals cannot touch
  them; only invoice/payment/credit/write-off/bill workflows can.
- Fiscal periods gate posting dates: open / soft-closed (privileged override
  with reason) / hard-closed (rejected), including months whose period rows
  were never materialized.
- Idempotency records (`posting_commands`) make every financial command
  safely retryable; same key + same payload replays, different payload gets
  `409 IDEMPOTENCY_CONFLICT`.
- Documents freeze on posting (quantities, prices, tax snapshot, totals,
  template version); posted invoices render their PDF from the frozen data.
- Inventory (engine-level, UI gated): perpetual FIFO; Inventory Asset GL ==
  sum of remaining layer value at all times; negative stock rejected.
- The audit chain is an org-scoped monotonic sequence with SHA-256 links.
  `GET /api/v1/audit-log/verify` recomputes it. A chain stored in the same
  database is a tamper _indicator_, not proof against a DB administrator.

## Getting started (development)

Prereqs: Node 22, PostgreSQL 16.

```bash
npm ci
cp .env.example .env        # fill DATABASE_URL and TEST_DATABASE_URL
npm run db:migrate          # applies committed SQL migrations
npm run dev                 # http://localhost:5000
```

Without Clerk keys the app runs in "authentication not configured" mode and
says so; there is no fallback login. Automated tests use a test-only header
adapter that refuses to load outside `NODE_ENV=test`.

### Commands

| Command                                  | What it does                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                            | Dev server (Express + Vite middleware, one port)                                                                  |
| `npm run build` / `npm run start`        | Production build / run                                                                                            |
| `npm run db:migrate`                     | Apply migrations (advisory lock, migration ledger). `-- --test` targets TEST_DATABASE_URL with guards             |
| `npm run db:generate`                    | Generate a migration from the Drizzle schema (review before committing)                                           |
| `npm run db:seed:demo -- --confirm-demo` | Deterministic fictional demo company (guards below)                                                               |
| `npm run perf:seed -- --confirm-perf`    | 10k-entry performance fixture + report timings + EXPLAIN review, TEST database only (docs/PERFORMANCE.md)         |
| `npm test`                               | Unit + integration tests (needs TEST_DATABASE_URL)                                                                |
| `npm run test:e2e`                       | Playwright + axe against the real production build                                                                |
| `npm run verify`                         | format check, lint, strict typecheck, tests, build                                                                |
| `npm run verify:release`                 | verify + anti-placeholder sweep, test hygiene, fresh-DB migration smoke, dependency audit, license inventory, E2E |
| `npm run jobs:run -- --once`             | Outbox/scheduled job runner (for Replit Scheduled Deployments)                                                    |

### Demo company

The demo seed only loads into an already-bootstrapped deployment whose
company name contains "Demo", refuses `NODE_ENV=production`, refuses the
migration connection, requires `--confirm-demo`, and is idempotent. Flow:
sign in as the owner, claim the deployment as e.g. "Cedar Creek Restoration
(Demo)", finish onboarding (or let the seed apply the contractor chart), then:

```bash
npm run db:seed:demo -- --confirm-demo
```

Every seeded record is fictional and labeled "(Demo)".

## Replit production setup (human steps)

This repository was built in a repo-only session; no managed Replit services
were provisioned or faked. To go live:

1. **PostgreSQL**: create the production database; set `DATABASE_URL`
   (runtime, least-privileged role where supported) and
   `MIGRATION_DATABASE_URL` (admin) in Publishing → Secrets. Run
   `npm run db:migrate` as an explicit release step — the app never
   auto-migrates on boot, and `/health/ready` fails closed with
   `SCHEMA_VERSION_MISMATCH` when code and schema disagree.
2. **Clerk (via Replit)**: connect the integration; set
   `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. Only verified emails
   authenticate. Check whether your Clerk plan exposes end-user MFA before
   documenting it to staff.
3. **App Storage**: create a bucket; set `APP_STORAGE_BUCKET_ID`. Until then
   attachments stay hidden/fail closed (production never uses the ephemeral
   filesystem for documents).
4. **Secrets**: `APP_BASE_URL` (the final origin — invitation and document
   links derive from it, never from Host headers), `BOOTSTRAP_OWNER_EMAIL`
   (the one account allowed to claim the deployment), optionally
   `PRIMARY_ORGANIZATION_ID` after bootstrap as a cross-check.
5. **Deploy**: Autoscale, `npm ci && npm run build`, run `npm run start`.
   For recurring work use a Scheduled Deployment running
   `npm run jobs:run -- --once` (never in-process cron on Autoscale).
6. **Custom domain**: attach it, then update `APP_BASE_URL` and Clerk's
   allowed origins/callbacks.
7. **Email**: unset by default — the app never claims to send mail; documents
   are always downloadable. To enable, configure a provider (`EMAIL_PROVIDER`,
   `RESEND_API_KEY`, verified sender domain with SPF/DKIM).

## Backup, restore, and recovery

- A Git revert never reverts data; database recovery and code rollback are
  separate. Verify your Replit plan's PostgreSQL backup/PITR capability and
  retention before telling anyone backups exist.
- The owner full export (Settings → Data export) is portable data with a
  manifest — it is **not a tested one-click restore**. Restore runbook (test
  it in a disposable environment first): provision a fresh database → run
  `npm run db:migrate` → re-import master records and re-post source
  transactions through the API in document order (the export preserves every
  source document, allocation, and journal). Attachment bytes must be
  downloaded separately; the export carries their metadata and checksums.
- Pilot planning defaults (unverified until you test them): RPO ≤ 24h,
  RTO ≤ 8h. Schedule quarterly restore drills during a pilot.

## Security posture

Targets OWASP ASVS L2 practices (no third-party certification claimed):
fail-closed auth/storage adapters; Zod validation at every boundary;
parameterized queries only; org-scoped authorization re-checked on every
object; PostgreSQL-backed rate limiting; strict upload validation
(extension + MIME + magic bytes, no HTML/SVG/office files, download-only
until a scanner exists); helmet CSP in production; pino redaction; no
analytics or telemetry. Invitation tokens are 256-bit, single-use, stored
hashed. Audit events cover auth, roles, settings, posting, approvals,
reversals, close/reopen, reconciliation, exports, and uploads.

## Known limitations (honest list)

- **Gated features (hidden, not half-built)**: inventory UI (subledger and
  posting are complete and tested; navigation stays hidden until the full
  module gate passes), sales-tax center UI beyond manual rates on documents,
  projects/time, purchase orders, budgets/recurring/cash outlook, OFX/QFX,
  XLSX, cash-basis reports, Statement of Cash Flows, customer retainers,
  NSF/returned-payment workflows, payroll-journal import, custom fields,
  saved views, global search, command palette, PWA.
- Sales tax is one combined manual rate per document (agency/components
  model is schema-ready); tax liability reporting beyond the Trial Balance
  row is pending the gated tax module.
- Terminology aliases, navigation reordering, and per-user dashboards are
  not yet configurable.
- Master-record lists (customers, vendors, products) are alphabetical with a
  hard safety bound rather than paginated; transactional lists use keyset
  cursor pagination with Load more (see docs/PERFORMANCE.md for the measured
  10k-transaction results).
- Email sending is not implemented (no provider assumed); "sent" states are
  never faked.
- Moderate (not high/critical) advisory findings exist in production
  dependencies with no non-breaking fix: react-router 6 (two moderates;
  fix requires v7 migration) and a transitive `uuid` under
  `@replit/object-storage`. Documented here deliberately.
- Database-enforced append-only protections run as triggers under the
  application role; a separate runtime role with revoked UPDATE/DELETE is
  recommended when the managed database supports it (see replit.md).

## Accounting review before real books

Have a CPA/bookkeeper validate: the chart template mapping for your entity,
opening balances (Opening Balance Equity must be reviewed and cleared), the
single-rate manual tax configuration against your jurisdiction, the rounding
policy (round-half-up per line), and the first month of AR/AP aging against
source documents before migrating a real company.
