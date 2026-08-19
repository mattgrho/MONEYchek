# Replit configuration notes

- One public process: Express binds 0.0.0.0:$PORT (default 5000) and serves
  the API plus the built client. `.replit` maps port 5000 -> 80 and uses
  Autoscale for deployment.
- Run button: `npm run dev` (Vite middleware inside Express; no second public
  port).
- Production: `npm ci && npm run build` then `npm run start`.
- Databases: use Replit PostgreSQL. Development and production databases are
  separate; the app never auto-migrates on startup. Apply migrations as an
  explicit release step: `npm run db:migrate` with MIGRATION_DATABASE_URL set.
- Auth: Replit-managed Clerk. Set CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY
  in Secrets. Without them the app serves a setup notice and all
  authenticated APIs fail closed.
- Storage: Replit App Storage bucket id in APP_STORAGE_BUCKET_ID. Attachments
  stay hidden until configured (development uses a local directory).
- Secrets: enter production secrets in the Publishing/Secrets UI; nothing is
  copied from development automatically. See .env.example for the contract.
- Scheduled jobs: use a Scheduled Deployment running
  `npm run jobs:run -- --once` (never in-process cron on Autoscale).
- Custom domain: configure after production verification; set APP_BASE_URL to
  the final origin so auth callbacks and generated links are correct.
