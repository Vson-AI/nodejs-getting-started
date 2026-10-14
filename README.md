# IP-PMS

Multi-tenant IP portfolio management for consultancy agencies, built to SRS v3.0.
Agencies manage patents, utility models, trademarks, copyrights and industrial
designs for their clients, run a docket of deadlines, and give each client a
read-only portal onto its own records. Bulk CSV import and export cover every
module.

## Running it

```
npm install
npm run db:migrate     # creates the schema, RLS policies, triggers, reference data
npm run db:seed        # demonstration tenants, only when the database is empty
npm start
npm test
```

`DATABASE_URL`, `APP_ENCRYPTION_KEY` and `SESSION_SECRET` must be set. See
`.env.example`. The app runs `db:migrate` and `db:seed` itself on boot, so a
fresh deployment comes up ready.

## Demo accounts

Password `demo1234` for all of them.

| Agency code | Username | What they see |
|---|---|---|
| ABC | `admin` | Everything in agency ABC, including users, clients and settings |
| ABC | `examiner` | Create and edit records and docket entries, run imports, no deletes |
| ABC | `viewer` | Read-only across agency ABC |
| ABC | `kopje.user` | Client portal: only Kopje Holdings records |
| ZIMIPO | `admin` | A second agency, proving isolation |
| *(blank)* | `platform` | Platform console: tenants, suspension, audit archive |

## How the pieces fit

| Area | Where |
|---|---|
| Schema, RLS policies, audit triggers, reference generator, archive job | `src/db/schema.sql` |
| Per-request database session carrying the RLS context | `src/db/pool.js`, `src/middleware/context.js` |
| Module registry driving grids, forms, CSV templates and validation | `src/lib/modules.js` |
| Field rules shared by forms and the importer | `src/lib/validate.js` |
| Import engine: dry run, commit, batching, cancellation, idempotency | `src/lib/importer.js` |
| Role to permission matrix | `src/lib/permissions.js` |
| Reports and dashboard queries | `src/lib/reports.js` |
| Secret encryption | `src/lib/crypto.js` |

Adding a column to a module in `src/lib/modules.js` updates the grid, the form,
the CSV template, the validator and the export together, which is what BR-31
asks for.

## Reference numbers

`<INITIALS>/<TYPE>/<YEAR>/<SEQUENCE>`, for example `ABC/M/2025/000001`.

- Type codes: P patent, U utility model, M trademark, C copyright, D design.
- The sequence is per tenant and per type, never resets at year end, and is
  never reused after a delete.
- Minimum width is six digits and grows on its own: `999999` is followed by
  `1000000`.
- Generation takes a row lock on `ref_counters` inside the creating
  transaction, so two concurrent creates cannot collide.
- Once assigned, a reference cannot be changed. A database trigger rejects it.

## Data isolation

Every IP table, the docket and both audit tables carry `tenant_id` and
`client_id`, have row-level security enabled and forced, and share one policy:

```
tenant_id = current tenant
AND (staff or platform session OR client_id = current client)
```

The session variables are set on the connection at the start of each request
from the signed-in user, never from anything the browser sends. Queries also
filter by tenant in SQL, so a mistake in either layer is caught by the other.
A client user sees nothing that is not assigned to their own client, including
records with no client set.

## Audit trail

Database triggers log every insert, update and delete on the IP tables, the
docket, clients, users, tenants and settings, with the old and new row as
JSON and the username from the session. Logins, exports, template downloads
and import runs are logged by the application. Password hashes and encrypted
secrets are stripped before the entry is written.

Audit rows are append-only: a trigger rejects any update or delete from the
application. Entries older than five years move to `audit_logs_archive`, where
they stay readable and searchable. The job checks daily, runs when the last run
is more than 28 days old, and records its own run. Platform administrators can
also run it on demand.

## Bulk CSV

Every module has a template in three variants: blank with a description row,
with a sample row, and existing data for round-trip editing. Uploads run in two
modes:

- **Dry run** validates and writes nothing.
- **Commit** either runs as a single transaction that aborts on the first
  invalid row, or, with "skip invalid rows", commits valid rows in batches of
  500 and reports the rest.

Failures are recorded per row with the row number, the column and the original
line, and can be downloaded as an error report from the job page or from the
import history later. Re-uploading a file that was already committed does not
duplicate its rows: each committed row is recorded by content hash against the
file hash. Imported rows go through the same insert path as typed ones, so
reference generation and audit entries are identical.

## Differences from the SRS

The SRS targets SQL Server 2019 and a desktop client for phase 1. This build
runs on Node and PostgreSQL and is delivered as a web application, so a few
constructs are translated. Behaviour is unchanged unless noted.

| SRS | Here | Note |
|---|---|---|
| SQL Server, T-SQL | PostgreSQL | `SESSION_CONTEXT` becomes `current_setting`, `UPDLOCK, HOLDLOCK` becomes `SELECT ... FOR UPDATE`, `FORMAT(n,'D6')` becomes `lpad` with a minimum width |
| `CREATE SECURITY POLICY` | `CREATE POLICY` with `FORCE ROW LEVEL SECURITY` | Same predicate, applied to the same eight tables |
| Desktop client (phase 1) | Web application | The client portal is the same application with a restricted menu, not a separate build |
| Always Encrypted with a customer-managed key | AES-256-GCM in the application, key in `APP_ENCRYPTION_KEY` | The key never reaches the database, so a dump or backup holds no usable SMTP password |
| SQL Agent monthly job | In-process daily scheduler, plus a manual run | Same five-year retention and self-audit |
| Stored procedures `sp_*` | Parameterised queries in `src/lib/records.js` | One code path for forms and imports |
| RLS predicate in section 9.2 also shows unassigned rows to client users | Client users never see unassigned rows | Section 9.2 contradicts FR-CP-005 and acceptance criterion 10; the stricter reading was taken |
| Open a local attachment with the OS handler | Local paths are shown as references, URLs are links | A browser cannot open a path on the agency file server |
| Report export to PDF (Could) | Print view on report pages | Print to PDF from the browser |
| Email notifications for expiring IP | Not built | Phase 2 in the SRS. The SMTP configuration screen and the test send are here |
| Cross-tenant consultants, subscription tier enforcement | Not built | Phase 2 and phase 3. The schema keeps `plan_id` and a `plans` table for them |

## Tests

`npm test` covers the CSV reader and writer, template columns, every field
validation rule, the permission matrix, and, when `DATABASE_URL` is set,
reference generation including the roll past six digits, reference
immutability, sequence retirement on delete, client and tenant isolation
through RLS, audit writing and immutability, and the whole import engine from
dry run to idempotent re-upload. Database tests build their own throwaway
tenant and remove it afterwards.
