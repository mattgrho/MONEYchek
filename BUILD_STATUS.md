# BUILD STATUS

Working name: LedgerOS (never shown after company onboarding).
Controlling spec: master build prompt (white-label accounting OS).

## Resume instruction

Read CLAUDE.md, BUILD_STATUS.md, and the master build prompt; inspect git
status/diff; resume from the first incomplete gate without replanning
completed work.

## Phase state

- [x] Phase 0 — Repository safety and blueprint (stack: Node 22, TS strict,
      React+Vite, Express, Drizzle+PostgreSQL, decimal.js, Vitest/Playwright).
- [x] Phase 1 — Runtime foundation: app factory, error envelope, health
      routes with schema-version check, Clerk/test auth adapters (fail closed),
      secure bootstrap, memberships/roles/invitations, PG-backed rate limiting,
      audit hash chain, responsive shell. Gate: auth/RBAC/isolation tests green.
- [x] Phase 2 — White-label onboarding: resumable wizard (company, brand
      with contrast warnings, accounting, COA templates, review), runtime
      theming, logo upload, brand-bootstrap endpoint. Gate: E2E completes
      onboarding and rebrands without code edits.
- [x] Phase 3 — Accounting kernel: posting engine, idempotent commands,
      sequences, periods soft/hard close + reopen, opening balances, reversals,
      DB-level balance/append-only enforcement, TB/GL/Journal/P&L/BS. Gate:
      kernel invariant suite green.
- [x] Phase 4 — Sales & AR: full quote-to-cash incl. partial conversion,
      allocations (append-only, race-safe), credits, refunds, write-offs, voids,
      UF/deposits, sales receipts, statements, branded PDFs. Gate: AR tie-out +
      E2E green.
- [x] Phase 5 — Purchasing & AP: bills with approval threshold + separation
      of duties, expenses/card, vendor credits, bill payments. Gate: AP tie-out,
      SoD, permission tests green.
- [x] Phase 6 — Banking: CSV import (dry-run, idempotent, duplicate
      staging), match/categorize/split/transfer, rules (suggested-only default),
      bank + credit-card reconciliation (exact zero, immutable snapshot, §15
      card fixture). Gate: banking suite green.
- [x] Phase 7 (core) — Reports catalog for P0, CSV (injection-safe) + PDF
      outputs, owner full export with manifest, attachments with validation,
      demo seed with guards, verify/verify:release pipelines, docs. Golden
      dataset (§30) passes end to end.
- [x] Post-core hardening — keyset cursor pagination on every transactional
      list (server + Load more UI), audit-log beforeSeq fix, close checklist
      endpoint surfaced in the Periods page, 10k-entry performance seed with
      EXPLAIN review and the resulting 0004_perf_indexes migration
      (docs/PERFORMANCE.md).
- [ ] Phases 8–10 — Gated extensions: NOT started (inventory UI, tax center,
      projects/time, POs, budgets/recurring, OFX/QFX, XLSX, cash-basis, SoCF,
      retainers, NSF flows, payroll import). Navigation for these does not exist.

Label claimed: **Prototype Core source-complete** (fresh clone → npm ci →
migrate TEST_DATABASE_URL → verify:release passes with test-only adapters).
NOT claimed: `Replit deployment verified` (no managed services were available
in this build environment; see External prerequisites).

## Last verification (2026-08-20, this container)

- `npm run verify:release`: **PASS** — format, lint, strict typecheck,
  88 unit/integration tests, production build, anti-placeholder sweep,
  no .only/.skip, fresh-DB migration smoke, npm audit (no high/critical
  production vulns; moderates documented in README), license inventory
  (all permissive), 6/6 Playwright E2E incl. axe scans and zero console
  errors.
- Golden dataset §30: all authoritative values exact (bank 10,020.00,
  AR 62.38, inventory 5 @ $35, AP 50.00, tax 12.38, NI 55.00, BS
  10,117.38 = 10,117.38, aging tie-outs, FIFO COGS 95.00, idempotent
  replay, entry-hash rebuild, void-with-restore fixture).
- Demo seed executed against the dev database (Cedar Creek Restoration
  (Demo)): 13 balanced journal entries, ledger ties.

## Environment facts (this container)

- Local PostgreSQL 16 at 127.0.0.1:5432 (cluster /var/lib/pgrun, user
  postgres); databases ledgeros_dev, ledgeros_test. `.env` (gitignored)
  holds local URLs. Restart command in CLAUDE.md.
- Playwright uses the preinstalled Chromium at /opt/pw-browsers/chromium
  (config handles it; never run `playwright install`).

## External prerequisites (human, before production)

- Replit PostgreSQL (dev + prod) with DATABASE_URL / MIGRATION_DATABASE_URL.
- Clerk via Replit (CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY).
- App Storage bucket (APP_STORAGE_BUCKET_ID) — attachments fail closed
  until set.
- Production secrets per .env.example; custom domain + APP_BASE_URL.
- Verify Replit PITR/backup retention before claiming backups exist.

## Next actions (in order)

1. Two-step approvals, purchase orders with conversion, customer retainers,
   NSF/returned-payment workflows (gated extensions A).
2. Inventory UI gate (subledger already complete + tested).
3. Manual sales-tax center (agencies/components/liability report) on the
   existing tax_rates schema.
4. Email outbox worker behind a real provider config; recurring templates
   via Scheduled Deployment.
