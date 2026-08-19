# BUILD STATUS

Working name: LedgerOS (never shown after company onboarding).
Controlling spec: master build prompt (white-label accounting OS).

## Resume instruction

Read CLAUDE.md, BUILD_STATUS.md, and the master build prompt; inspect git
status/diff; resume from the first incomplete gate without replanning
completed work.

## Phase state

- [x] Phase 0 — Repository safety and blueprint: stack adopted (Node 22,
      TypeScript strict, React+Vite, Express, Drizzle+PostgreSQL, decimal.js,
      Vitest/Playwright). Tooling, schema, migrations 0000+0001 applied to local
      dev/test databases.
- [ ] Phase 1 — Runtime foundation (in progress)
- [ ] Phase 2 — White-label onboarding
- [ ] Phase 3 — Accounting kernel
- [ ] Phase 4 — Sales and AR
- [ ] Phase 5 — Purchasing and AP
- [ ] Phase 6 — Banking and reconciliation
- [ ] Phase 7 — Prototype Core reports, portability, hardening
- [ ] Phases 8-10 — Gated extensions (not started; navigation hidden)

## Environment facts (this container)

- Local PostgreSQL 16 at 127.0.0.1:5432 (cluster /var/lib/pgrun, user
  postgres); databases ledgeros_dev, ledgeros_test. `.env` (gitignored) holds
  local URLs.
- No Replit-managed DATABASE_URL/Clerk/App Storage credentials exist here.
  Provider adapters are real; provisioning steps are documented in README.
  Test-only adapters (NODE_ENV=test) power automated tests.

## External prerequisites (human)

- Replit PostgreSQL (dev + prod), Clerk via Replit, App Storage bucket,
  production secrets per .env.example.

## Last verification

- `npm run db:migrate` + `--test`: both databases migrate cleanly (0000, 0001).

## Next actions

1. Server runtime: app factory, error envelope, request IDs, health routes,
   pino logging, Vite middleware.
2. Auth adapters (Clerk + test-only), secure owner bootstrap, memberships,
   roles seeding, RBAC middleware.
3. Two-tenant isolation test skeleton.
4. App shell + protected routes on the client.
5. Phase 2 onboarding/branding.
