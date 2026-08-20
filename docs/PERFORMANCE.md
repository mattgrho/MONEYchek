# Performance verification (§26)

How to reproduce:

```bash
npm run perf:seed -- --confirm-perf            # ~10,000 journal entries
npm run perf:seed -- --confirm-perf --entries=500   # quick smoke
```

The script refuses `NODE_ENV=production`, only ever targets
`TEST_DATABASE_URL` (which must be test-named and distinct from the runtime
and migration URLs), and TRUNCATEs the test database before seeding, so the
fixture never mixes with real books. All documents are created through the
real domain services — posting engine, idempotent commands, audit hash
chain, and every DB invariant run exactly as in production.

## Fixture

3,000 posted invoices, 2,400 customer payments with allocations, 1,200
posted bills, 900 bill payments, 2,500 card expenses — 10,000 journal
entries / 23,000 journal lines across 40 customers and 15 vendors, spread
over 18 months. Seeding throughput in this container: ~82 entries/second
(122 s wall clock), audit chain and idempotency records included.

## Measured results (2026-08-20, this dev container, PostgreSQL 16)

Median of 3 runs against the 10k-entry fixture, after `ANALYZE`:

| Query                               | Median  |
| ----------------------------------- | ------- |
| Trial balance (as of date)          | 17.7 ms |
| Profit & Loss (18-month range)      | 12.0 ms |
| Balance sheet (as of date)          | 34.7 ms |
| AR aging (as of date)               | 38.8 ms |
| AR control-account balance          | 9.9 ms  |
| AP aging (as of date)               | 10.9 ms |
| AP control-account balance          | 3.9 ms  |
| Journal report (1 month)            | 11.8 ms |
| Account register (bank, full range) | 13.8 ms |
| Paginated invoice list (first page) | ~1 ms   |

Numbers are from this build container; managed PostgreSQL adds network
latency but the plans below are what matter for scaling.

## EXPLAIN review and the index it forced

The first 10k run put **AR aging at 769 ms**: the open-balance subqueries
correlate on the bare document id (`WHERE pa.invoice_id = i.id`), and every
allocation index led with `organization_id`, so PostgreSQL sequential-scanned
`customer_payment_allocations` once per invoice.

Fix: migration `0004_perf_indexes.sql` adds plain btree indexes on the
correlated keys — `customer_payment_allocations(invoice_id, payment_id)`,
`credit_allocations(invoice_id, credit_memo_id)`,
`invoice_write_offs(invoice_id)`, `customer_refunds(source_type, source_id)`,
`bill_payment_allocations(bill_id, bill_payment_id)`,
`vendor_credit_allocations(bill_id, vendor_credit_id)` (each column its own
index). AR aging dropped to 38.8 ms; the plan shows
`Index Scan using cpa_invoice_idx` at ~0.001 ms per lookup.

Remaining sequential scans in the plans are deliberate whole-ledger
aggregates (trial balance reads every journal line by definition: 23,000
rows in ~19 ms) and empty-table scans; nothing else degrades quadratically
with document count.

## API-level bounds

Every transactional list endpoint (invoices, payments, credit memos, sales
receipts, deposits, estimates, bills, expenses, vendor credits, bill
payments, bank feed items, attachments) uses keyset cursor pagination
(`?limit=` 1-200, `?cursor=` opaque; response carries `nextCursor`), so no
request reads more than 201 rows from these tables. The audit log paginates
by its monotonic `seq` (`?beforeSeq=`). Master-record lists (customers,
vendors, products, tax rates) are alphabetical with a hard safety bound.
