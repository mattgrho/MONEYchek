-- Shared PostgreSQL-backed rate limiting (works across Autoscale instances).
CREATE TABLE rate_limit_buckets (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL
);
