# Design Notes — Salary Management

**Version:** 1.0 · **Status:** Draft · **Date:** September 2026

---

## Proposed architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser                                             │
│  React SPA (Vite)  ──  MUI components                │
│  React Router · Fetch API                            │
└───────────────────────┬─────────────────────────────┘
                        │ HTTPS / httpOnly cookie (JWT)
                        ▼
┌─────────────────────────────────────────────────────┐
│  Express API  (Node.js + TypeScript)                 │
│  ├── Authentication middleware (JWT verify)          │
│  ├── Route handlers                                  │
│  ├── Zod validation layer                            │
│  └── Prisma ORM                                      │
└───────────────────────┬─────────────────────────────┘
                        │ TCP
                        ▼
┌─────────────────────────────────────────────────────┐
│  PostgreSQL                                          │
│  Tables: users, employees, salary_history            │
└─────────────────────────────────────────────────────┘
```

The architecture is a standard three-tier web application. There are no microservices, queues, or caches — complexity is added only when justified by real constraints.

---

## Technology choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| **Backend runtime** | Node.js 18 LTS + TypeScript | Mature LTS release; TypeScript eliminates a class of runtime errors and makes API contracts explicit. |
| **Web framework** | Express 4 | Lightweight, well-understood, huge ecosystem, no magic. Sufficient for a CRUD-heavy internal tool. |
| **Database** | PostgreSQL 14+ | Best-in-class relational DB. Handles 10,000-employee scale with ease. Strong JSON support for flexible metadata. |
| **ORM** | Prisma | Type-safe queries, excellent migration tooling, auto-generated client from schema. Reduces raw SQL surface area. |
| **Validation** | Zod | Schema-first; can share schemas between Express request validation and TypeScript types. Works at both runtime and compile time. |
| **Frontend framework** | React 18 + Vite | React is the team-standard; Vite offers near-instant HMR. |
| **UI library** | Material UI v5 | Comprehensive component library; theming system keeps styling consistent without bespoke CSS. |
| **Routing** | React Router v6 | De facto standard React router; declarative nested routes map cleanly to the layout structure. |
| **Auth mechanism** | JWT in httpOnly cookie | Prevents XSS access to the token. CSRF risk is mitigated by checking the `Content-Type` header and using `SameSite=Strict`. |
| **Password hashing** | bcrypt | Industry standard; built-in work factor for future-proofing. |
| **Testing** | Vitest + Supertest | Vitest is Vite-native and fast; Supertest allows integration-level HTTP testing against the real Express app without starting a server. |
| **Linting/formatting** | ESLint + Prettier | Consistent code style enforced at CI time. |

---

## Major trade-offs

### Monolith vs microservices
A monolith was chosen deliberately. 10,000 employees and a single primary user type do not justify the operational overhead of service decomposition. A well-structured monolith with clear module boundaries is easier to evolve.

### No caching layer
Redis is excluded. PostgreSQL query performance at 10,000 rows is well within acceptable limits with proper indexing. Caching can be introduced if profiling reveals a real bottleneck.

### JWT in cookie vs `Authorization` header
Storing the JWT in an httpOnly cookie removes it from `localStorage`/`sessionStorage`, which are XSS-accessible. The trade-off is CSRF exposure, which is addressed by `SameSite=Strict` cookie policy and origin validation on the server.

### Soft deletes vs hard deletes
All employee and salary records use soft deletes (`deletedAt` timestamp). This preserves audit integrity and allows recovery without a separate audit table for the common case.

### Shared Zod schemas
Zod schemas are defined in the backend and are not published to the frontend package. The frontend relies on TypeScript types inferred from API response shapes. A future improvement would be to extract shared schemas into a `packages/shared` workspace package.

---

## Performance considerations

- **Indexing strategy** — composite indexes on `(employeeId, effectiveDate)` for salary history, and on `(departmentId, countryId, gradeId)` for filtered listing queries.
- **Pagination** — all list endpoints return cursor- or offset-based pages (max 100 rows per request). No unbounded queries.
- **Aggregation** — pay insight queries use PostgreSQL window functions and `GROUP BY` rather than loading all rows into Node.js memory.
- **Bulk import** — CSV uploads are streamed and inserted in batches of 500 using Prisma's `createMany`. A single 10,000-row import should complete in under 10 seconds on modest hardware.
- **Frontend bundle** — MUI, React, and React Router are split into separate Rollup chunks for better browser caching. The initial JS bundle (excluding chunks) targets under 50 KB gzipped.
- **Connection pooling** — the Prisma singleton pattern avoids creating a new connection pool on every hot reload in development. In production, PgBouncer is recommended if connection counts become a concern.

---

## Database schema

### Entity overview

```
users
─────────────────────────────────────────
id             TEXT  (cuid)   PK
email          TEXT           UNIQUE
passwordHash   TEXT
role           Role enum      DEFAULT HR_MANAGER
createdAt      TIMESTAMPTZ
updatedAt      TIMESTAMPTZ


employees
─────────────────────────────────────────
id               TEXT  (cuid)   PK
name             TEXT
email            TEXT           UNIQUE  ← indexed
country          TEXT                   ← indexed
department       TEXT                   ← indexed
jobTitle         TEXT                   ← indexed
level            TEXT
hireDate         DATE
employmentType   EmploymentType enum
gender           Gender enum
baseAnnualSalary DECIMAL(15,4)  CHECK ≥ 0
salaryCurrency   CHAR(3)        ISO 4217
managerId        TEXT           FK → employees.id  ← indexed
version          INTEGER        DEFAULT 1
createdAt        TIMESTAMPTZ
updatedAt        TIMESTAMPTZ


salary_history
─────────────────────────────────────────
id               TEXT  (cuid)   PK
employeeId       TEXT           FK → employees.id   ┐
effectiveDate    DATE                                ├─ composite index
previousSalary   DECIMAL(15,4)  nullable  CHECK ≥ 0
previousCurrency CHAR(3)        nullable
newSalary        DECIMAL(15,4)  CHECK ≥ 0
newCurrency      CHAR(3)
reason           TEXT           nullable
changedById      TEXT           FK → users.id
createdAt        TIMESTAMPTZ
```

Enums: `Role { HR_MANAGER }` · `EmploymentType { FULL_TIME, PART_TIME, CONTRACT, INTERN }` · `Gender { MALE, FEMALE, NON_BINARY, PREFER_NOT_TO_SAY }`

---

### Why current salary is stored on Employee

Salary at any point in time can be reconstructed by replaying `salary_history` rows, but doing so for every read would be expensive and complex. Keeping `baseAnnualSalary` and `salaryCurrency` directly on `Employee` allows the common case — "what is this employee paid right now?" — to be answered with a single indexed lookup. The write path (salary update) is a transaction that writes a `SalaryHistory` row *and* updates the `Employee` columns atomically, so the two are always consistent.

---

### Why SalaryHistory is the audit trail

`SalaryHistory` captures the full before/after state of every salary change in a single, typed row:

- `previousSalary` / `previousCurrency` — what the employee was paid immediately before this change (null only for the initial hire entry).
- `newSalary` / `newCurrency` — what the employee is paid after this change.
- `effectiveDate` — the calendar date the change takes effect (may differ from `createdAt` for backdated corrections).
- `reason` — a human-readable explanation (e.g. "Annual review", "Promotion", "Market adjustment").
- `changedById` — the `User` who made the change, providing a clear accountability chain.

Because each row is self-contained (no dependency on adjacent rows), any historical snapshot is trivially derived without gap-filling logic. The `(employeeId, effectiveDate)` composite index makes both "full history for an employee" and "history since date X" queries efficient.

---

### Why a generic AuditLog table is intentionally omitted

A generic audit log (e.g. a single table with `tableName`, `rowId`, `oldValue JSON`, `newValue JSON`) would capture all changes in one place but at significant cost:

- **No type safety** — JSON blobs require application-level parsing and are not validated at the database level.
- **No queryability** — finding all salary changes above a threshold, or changes in a given currency, requires JSON extraction operators and is slow without specialised indexing.
- **Unclear schema evolution** — adding a column to `employees` silently changes what gets logged with no schema migration.
- **Operational noise** — non-salary changes (name correction, department transfer) would pollute the same table as compensation changes, which have distinct compliance and confidentiality requirements.

`SalaryHistory` solves all of these: typed columns, proper constraints and indexes, clear semantics, and separation from non-compensation changes.

---

### Optimistic concurrency via the version field

`Employee.version` is an integer that starts at `1` and is incremented on every update. The API layer enforces the following pattern:

1. Client reads an employee record — receives `{ id, version: 3, baseAnnualSalary: ... }`.
2. Client submits a salary update — sends `{ id, expectedVersion: 3, newSalary: ... }`.
3. Server executes: `UPDATE employees SET ... version = version + 1 WHERE id = ? AND version = ?` with the expected version.
4. If `0` rows are updated, the record was modified by another request in the meantime → return `409 Conflict`.
5. Client refreshes and retries with the new version.

This avoids the need for pessimistic row-level locking (`SELECT FOR UPDATE`) while still preventing concurrent overwrites — important when multiple HR Managers may edit the same record simultaneously. The overhead is a single extra column compared and incremented in the same `UPDATE` statement.

---

### Monetary representation

All salary values use `DECIMAL(15, 4)` (PostgreSQL `NUMERIC`):

- **15 significant digits** — sufficient for any realistic annual salary in any currency (e.g. JPY ¥999,999,999,999.9999).
- **4 decimal places** — covers currencies with 3 minor-unit digits (e.g. Kuwaiti Dinar, KWD) plus one extra guard digit.
- **Exact arithmetic** — `NUMERIC` is an exact type; no floating-point rounding errors accumulate across aggregations.
- **CHECK constraints** — `CHECK (base_annual_salary >= 0)` on `employees` and equivalent checks on both salary columns in `salary_history` are enforced at the database level, added directly in the migration SQL (Prisma SDL does not expose `CHECK` constraints).
- **Currency** stored as `CHAR(3)` ISO 4217 code alongside each salary value so currency is never ambiguous.

---

## Seed strategy

### Overview

The seed (`backend/prisma/seed.ts`) populates the database with exactly 10,000 employees, one HR Manager user, and one `SalaryHistory` row per employee. It is designed to be both deterministic and idempotent — running it multiple times produces the same logical dataset without leaving orphaned rows.

---

### Deterministic generation

All randomness is driven by **mulberry32**, a lightweight 32-bit pseudo-random number generator seeded with the fixed constant `0xDEADBEEF`. Mulberry32 was chosen over `Math.random()` because:

- It is fully portable — same seed produces identical output on every platform and Node.js version.
- It requires zero external dependencies — implemented in ~8 lines of pure TypeScript.
- It passes statistical quality tests (BigCrush), so distributions are visually realistic rather than obviously patterned.

The seed constant is intentionally never changed. Any change to it would alter every generated value, breaking the reproducibility guarantee. All PRNG calls are made in a fixed order determined by the loop structure, so inserting a new field or data pool at the end does not affect earlier values.

---

### Idempotency

The seed achieves idempotency through a **truncate-then-insert** strategy:

1. `salaryHistory.deleteMany({})` — deletes all history rows first (FK child).
2. `employee.deleteMany({})` — then deletes all employee rows (FK parent).
3. Full re-insert of all 10,000 employees and 10,000 history rows.

The HR Manager is handled separately with `user.upsert()`, which updates the password hash on re-runs without creating a duplicate. This means the user ID is stable across runs, which matters because history rows reference it via `changedById`.

Alternative considered: checking row count and skipping if already seeded. Rejected because partial seeds (e.g. from a previous failed run) would leave inconsistent data. A full wipe-and-reload is simpler and safer.

---

### Why realistic distributions matter for dashboard testing

The dashboard and pay insights features are only meaningful if the underlying data has realistic shape. Uniform random distributions (all countries equally represented, all salaries identical) would cause insights pages to show flat, unhelpful charts. The seed deliberately reproduces real-world skew:

| Dimension | Approach |
|-----------|----------|
| **Country** | Weighted — US 28%, UK 12%, India 12%, Germany 10%; reflects a typical tech-company global footprint |
| **Department** | Weighted — Engineering 22%, Product 10%, Sales 10%; mirrors industry headcount ratios |
| **Level** | Weighted pyramid — L3 Mid is the most common (28%), L6 Principal the rarest (6%) |
| **Employment type** | Full-time dominant (78%), with a realistic mix of contractors and part-timers |
| **Gender** | Near-parity (48/46/4/2) to allow meaningful equity analysis in the insights view |
| **Salary** | Per-country bands with ±15% noise and a level multiplier, producing a realistic bell curve within each band |
| **Hire dates** | Uniform across 2015–2026, producing a natural tenure distribution |

Dashboard filter dropdowns, pay distribution histograms, and country/department breakdowns all become immediately testable with this dataset.

---

### Manager relationship generation

Manager assignment uses a two-phase approach to satisfy the self-referential FK constraint:

**Phase 1 — Insert all employees with `managerId = null`.**
Prisma's `createMany` batches 500 rows per call. Because all rows have a null FK at this stage, there are no FK violations regardless of insert order.

**Phase 2 — Update manager FK in a second pass.**
After all 10,000 employee rows exist in the database, the seed iterates through them and assigns managers according to these rules:

- Only employees at **L4 — Senior or above** are eligible to be managers (`canManage: true`). This ensures a realistic org hierarchy where junior employees are never managers.
- Each employee has a **70% probability** of being assigned a manager (30% are top-level ICs or executives without a named manager in the dataset).
- The candidate manager is drawn from the eligible pool and checked to ensure `candidateId !== employeeId`, preventing self-reference. Up to 8 retries are attempted before skipping assignment.
- Updates are applied in batches of 500 using `prisma.$transaction([...updates])`.

This produces approximately 7,000 manager relationships with zero self-references and a plausible org tree spanning ~40 manager candidates per 500 employees.

**Result from the live seed run:**

```
Employees       10,000
With manager     7,000  (70.0%)
Self-reference       0
Negative salaries    0
Countries           12
Departments         12
```

---

### Bulk insert performance

| Operation | Rows | Batches | Approach |
|-----------|------|---------|----------|
| Employee insert | 10,000 | 20 × 500 | `createMany` |
| Manager update  |  7,000 | 14 × 500 | `$transaction([update × 500])` |
| History insert  | 10,000 | 20 × 500 | `createMany` |

`createMany` maps to a single multi-row `INSERT` per batch, avoiding the N+1 overhead of individual `create` calls. The manager update pass uses transactional batches to stay within PostgreSQL's prepared-statement parameter limit while maintaining atomicity per batch.

Total seed runtime on a local PostgreSQL instance is approximately 60–90 seconds, dominated by the bcrypt hash (12 rounds) and the manager update transactions.

---

## Testing strategy

### Philosophy

Tests exist to catch regressions, document intent, and give the team confidence when changing the codebase. The guiding principles for this project are:

- **Test through application abstractions** — tests use the same `PrismaClient` instance and the same seed script that the application itself uses, never reimplementing logic inline. If the schema changes, the test fails; if the seed changes, the test catches it.
- **Prefer integration over unit for data concerns** — the database schema, constraints, and seed are a single cohesive system. Mocking the database would test the mock, not the system.
- **Keep tests deterministic** — all tests query a seeded dataset produced by a fixed-seed PRNG. The same database state always produces the same pass/fail result.
- **Clean up after constraint tests** — tests that insert rows to verify constraints immediately delete them so they do not pollute counts checked by other tests. Test IDs use a recognisable `test_*` prefix for easy identification.

---

### Test layers

| Layer | File | Tool | Touches DB |
|-------|------|------|------------|
| HTTP integration | `tests/health.test.ts` | Vitest + Supertest | No |
| Database integration | `tests/database.test.ts` | Vitest + Prisma | Yes (real) |

The two layers run in the same `vitest run` invocation but are completely independent — the HTTP tests use a dummy `DATABASE_URL` and never open a connection; the database tests use the real connection string from `backend/.env`.

---

### Test environment setup

`tests/setup.ts` is loaded by Vitest as a `setupFiles` entry before any test file runs. It calls `dotenv.config()` pointing at `backend/.env`, making `DATABASE_URL` and other variables available to the database tests. The health tests override `DATABASE_URL` with a placeholder at the top of their own file, which is safe because `dotenv.config()` does not overwrite already-set environment variables.

---

### Database test coverage

| # | Describe block | What is verified |
|---|---------------|------------------|
| 1 | **HR Manager account** | User exists, role is `HR_MANAGER`, password is a valid bcrypt hash (`$2b$`), plaintext password is not stored |
| 2 | **Employee count** | Exactly 10,000 employees are present |
| 3 | **Email uniqueness** | No duplicate emails (`GROUP BY … HAVING COUNT > 1`); every email contains `@` |
| 4 | **Salary validity** | No employee has a salary ≤ 0; all currency codes are exactly 3 characters; all codes are from the known ISO 4217 set used by the seed; minimum salary is > 0 |
| 5 | **SalaryHistory — initial hire entries** | `salary_history` row count equals employee count; every employee has ≥ 1 history row; all initial rows have `previousSalary = null` and `previousCurrency = null`; `newSalary` and `newCurrency` match the employee's current values; `effectiveDate` matches `hireDate` |
| 6 | **SalaryHistory FK integrity** | No orphaned history rows (left-join check against `employees`); no orphaned `changedById` (left-join check against `users`); every history row was authored by the seeded HR Manager |
| 7 | **Manager relationships** | No employee is their own manager (raw SQL `WHERE managerId = id`); every non-null `managerId` references a real employee row; all managers are at L4 — Senior or above; manager assignment rate is between 60% and 80% |
| 8 | **Seed idempotency** | Running the seed a second time (via `execSync`) produces the same employee count; the HR Manager `id` is unchanged (upsert, not re-create); no duplicate user rows; `salary_history` count re-equals employee count |
| 9 | **Negative salary constraint** | ORM `create` with `baseAnnualSalary: -1` throws; raw `INSERT` with `newSalary = -500` throws (DB-level `CHECK`); zero salary is accepted (boundary); positive salary is accepted (positive control) |

---

### What is deliberately not tested here

| Concern | Reason |
|---------|--------|
| Authentication / JWT | Not implemented yet — will be covered in the auth test suite |
| API endpoints | Not implemented yet |
| Frontend components | Covered by frontend Vitest suite when added |
| Prisma migration correctness | Verified by `prisma validate` and `prisma migrate dev` at schema time; the resulting DB structure is implicitly tested by every query in the database suite |
| PRNG output distribution | Statistical tests are out of scope; visual inspection of seeded data and weighted-pick logic is sufficient at this scale |

---

### Running the tests

```bash
# Prerequisites: database must be migrated and seeded first
npm run db:migrate --workspace=backend
npm run db:seed   --workspace=backend

# Run the full test suite (single pass)
npm run test

# Run with coverage report
npm run test:coverage --workspace=backend
```

The database test suite takes approximately 15–20 seconds — the bulk of the time is the idempotency test, which re-runs the seed script (bcrypt hashing + 30 batched inserts).

---

### Timeout configuration

`vitest.config.ts` sets `testTimeout` and `hookTimeout` to 120 seconds. This accommodates the idempotency test's seed re-run (which includes bcrypt at 12 rounds and ~30 `createMany` + transaction batches) while still failing loudly if something genuinely hangs.

---

## Authentication and security design

### Overview

Authentication is implemented as three stateless HTTP endpoints mounted at `/api/auth`. A JWT is issued on successful login and stored exclusively in an `httpOnly` cookie — it is never returned in the response body or accessible to frontend JavaScript.

---

### Endpoints

| Method | Path | Auth required | Description |
|--------|------|--------------|-------------|
| `POST` | `/api/auth/login` | No | Validates credentials, issues JWT cookie |
| `GET` | `/api/auth/me` | Yes | Returns the authenticated user's profile |
| `POST` | `/api/auth/logout` | No | Clears the auth cookie |

---

### Request flow

```
Client                          Express                        PostgreSQL
  │                                │                               │
  │  POST /api/auth/login          │                               │
  │  { email, password }  ────────>│                               │
  │                                │  Zod validate input           │
  │                                │  findUnique(email)  ─────────>│
  │                                │<─────────────────────────────  │
  │                                │  bcrypt.compare(pw, hash)     │
  │                                │  jwt.sign(payload)            │
  │<───────────────────────────────│  Set-Cookie: auth_token=JWT   │
  │  200 { user: {id,email,role} } │  (httpOnly, SameSite=Strict)  │
  │                                │                               │
  │  GET /api/auth/me              │                               │
  │  Cookie: auth_token=JWT ──────>│                               │
  │                                │  requireAuth middleware        │
  │                                │  jwt.verify(token, secret)    │
  │                                │  findUnique(userId)  ────────>│
  │                                │<─────────────────────────────  │
  │<───────────────────────────────│                               │
  │  200 { user: {id,email,role} } │                               │
```

---

### Cookie security

| Attribute | Value | Reason |
|-----------|-------|--------|
| `HttpOnly` | `true` | Prevents JavaScript from reading the token — mitigates XSS token theft |
| `SameSite` | `Strict` | Blocks the cookie from being sent on cross-site requests — mitigates CSRF |
| `Secure` | `true` in production, `false` in development | Requires HTTPS in production; allows plain HTTP in local dev |
| `Path` | `/` | Cookie applies to all routes |
| `MaxAge` | Derived from `JWT_EXPIRES_IN` (default `7d`) | Cookie and token expire together |

The JWT is **never** included in the response body. Frontend JavaScript can call `/api/auth/me` to determine session state; it has no direct access to the token string.

---

### JWT design

- **Algorithm**: HS256 (HMAC-SHA256) — symmetric, appropriate for a single-server deployment.
- **Secret**: read from `JWT_SECRET` env var, validated at startup to be ≥ 32 characters by Zod.
- **Payload**: `{ sub: userId, email, role }` — minimal, no sensitive data.
- **Expiry**: `JWT_EXPIRES_IN` (default `7d`), stored in cookie `MaxAge` so both expire simultaneously.
- Secrets are **never hard-coded**. `env.ts` calls `process.exit(1)` at startup if `JWT_SECRET` is absent or too short.

---

### Password security

- Passwords are hashed with **bcrypt** (12 rounds) — never stored or logged in plaintext.
- Login compares the submitted password against the stored hash using `bcrypt.compare()`.
- When an email does not exist, a **dummy bcrypt compare is still executed** against a fixed invalid hash. This maintains near-constant response time and prevents timing-based email enumeration — a timing attack could otherwise identify valid emails by measuring the response latency difference between "user not found" (fast) and "wrong password" (bcrypt-delayed).

---

### Email enumeration protection

Both "wrong password" and "unknown email" scenarios return **identical** HTTP status (`401`) and message (`"Invalid email or password"`). There is no way for a caller to distinguish the two cases from the API response.

---

### Input validation

Login input is validated with a **Zod schema** before any database query:

- `email`: required, valid email format, normalised to lowercase and trimmed.
- `password`: required, non-empty string.

Validation errors return `400` with the project's standard `{ status: 'error', message: 'Validation failed', errors: {...} }` shape.

---

### Authentication middleware

`requireAuth` (`src/middleware/requireAuth.ts`):

1. Reads `req.cookies.auth_token`.
2. Returns `401` immediately if the cookie is absent.
3. Calls `verifyToken()` — returns `null` on expired or malformed JWTs.
4. If invalid, **clears the stale cookie** and returns `401`. This prevents the browser from holding an expired token indefinitely.
5. On success, attaches the decoded payload to `req.user` and calls `next()`.

`requireRole(role)` composes after `requireAuth` to enforce a specific role. Currently only `HR_MANAGER` exists; the pattern is extensible without structural changes.

---

### Rate limiting

Login attempts are rate-limited with **`express-rate-limit`** (in-memory store):

| Setting | Value | Reasoning |
|---------|-------|-----------|
| Window | 15 minutes | Standard brute-force window |
| Max requests | 10 per IP | Allows a few genuine retries; tightly bounds automated attacks |
| `skipSuccessfulRequests` | `false` | All attempts count, not just failures — prevents "try until success" bypass |
| Standard headers | `true` | Returns `RateLimit-*` headers so clients can implement backoff |
| Test environment | Skipped | Rate limiter is bypassed when `NODE_ENV=test` so test suites don't collide |

Redis is deliberately excluded. An in-memory store is accurate enough for a single-process deployment and adds no infrastructure dependency. If the application is ever deployed behind multiple processes, the limiter can be backed by Redis by swapping the store option.

---

### Logout

`POST /api/auth/logout` calls `res.clearCookie(AUTH_COOKIE)` unconditionally. Because JWTs are stateless, there is no server-side session to invalidate. The cookie is cleared whether or not the caller is currently logged in (idempotent). Short token expiry (`7d`) limits the window during which a stolen token remains valid after logout — token revocation lists are out of scope at this stage.

---

### Error response shape

All auth errors follow the project-wide format:

```json
{ "status": "error", "message": "..." }
```

Validation errors additionally include an `errors` field with per-field details (from Zod). `500` errors suppress the original message to prevent internal detail leakage.

---

## Employee read API design

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/employees` | Paginated, filtered, searchable employee list |
| `GET` | `/api/employees/:id` | Single employee detail with current salary |
| `GET` | `/api/employees/:id/salary-history` | Complete salary audit trail for one employee |

All three endpoints require `HR_MANAGER` authentication (httpOnly JWT cookie).

---

### Error response shape

Employee routes use the structured `ApiError` shape, distinct from the simpler `AppError` shape used by auth routes. Both are handled by the central `errorHandler`.

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Employee with id 'xyz' not found",
    "details": {}
  }
}
```

Error codes in use: `NOT_FOUND` (404), `BAD_REQUEST` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403).

The two-shape approach preserves backward compatibility with existing auth routes while providing richer, machine-readable error codes on data endpoints.

---

### Pagination

Offset-based pagination was chosen over cursor-based for this use case:

- HR Managers need to jump to arbitrary pages ("show me page 5 of 400") — cursors make this impossible without replaying the full result set.
- At 10,000 employees with proper indexes, offset performance is entirely acceptable. Cursor pagination is warranted when tables grow into the millions and deep offsets become slow.

| Parameter | Type | Default | Constraint | Notes |
|-----------|------|---------|------------|-------|
| `page` | integer | `1` | ≥ 1 | 1-indexed |
| `pageSize` | integer | `25` | 1 – 100 | Hard cap prevents runaway memory usage |

The hard cap of 100 rows is enforced by Zod before any DB query executes. Requests with `pageSize > 100` receive a `400 BAD_REQUEST` immediately. This eliminates the possibility of an authenticated user accidentally or deliberately fetching all 10,000 rows in one HTTP call.

**Pagination metadata** is always returned alongside data:

```json
{
  "pagination": {
    "total": 10000,
    "page": 2,
    "pageSize": 25,
    "totalPages": 400,
    "hasNextPage": true,
    "hasPreviousPage": true
  }
}
```

`total` and `data` are fetched in **parallel** (`Promise.all`) using the same `WHERE` clause, avoiding a sequential double-query penalty.

---

### Search

`?search=<term>` performs a case-insensitive `ILIKE` match (Prisma `mode: 'insensitive'`, maps to PostgreSQL `ILIKE`) across two fields:

- `employees.name`
- `employees.email`

An employee matches if *either* field contains the search term. This uses Prisma's `OR` compound. An empty or absent `search` parameter is treated as no search — the full dataset is returned subject to other active filters.

`search` is limited to 200 characters by Zod to prevent oversized ILIKE patterns from being passed to the database.

---

### Filters

All filters are **AND-composed**: every supplied filter must match for a row to be returned. Filters use case-insensitive equality (`mode: 'insensitive'`) so `?country=united+states` and `?country=United+States` return the same results.

| Parameter | DB column | Match type |
|-----------|-----------|------------|
| `country` | `employees.country` | Case-insensitive equals |
| `department` | `employees.department` | Case-insensitive equals |
| `jobTitle` | `employees.jobTitle` | Case-insensitive equals |
| `level` | `employees.level` | Case-insensitive equals |
| `employmentType` | `employees.employmentType` | Exact enum match (validated by Zod) |

All filter columns except `employmentType` are indexed in the schema, so filtered queries skip full-table scans at 10,000 rows.

---

### Sorting

| Parameter | Allowed values | Default |
|-----------|---------------|---------|
| `sortBy` | `name`, `email`, `country`, `department`, `level`, `baseAnnualSalary`, `hireDate`, `createdAt` | `name` |
| `sortOrder` | `asc`, `desc` | `asc` |

Both parameters are validated by Zod enums. Unrecognised values return `400 BAD_REQUEST` immediately rather than falling through to a Prisma error.

---

### Query efficiency — no N+1

The list endpoint uses a shared `EMPLOYEE_SELECT` constant that includes the manager relation as a nested `select`:

```typescript
manager: { select: { id: true, name: true, jobTitle: true } }
```

This resolves manager names in a **single query with a JOIN** rather than issuing a separate lookup per employee. Prisma generates one `LEFT JOIN` against the `employees` table for the self-referential relation.

The `count()` and `findMany()` calls for the list share the same `WHERE` clause and run in `Promise.all` — two parallel round-trips rather than two sequential ones.

---

### Salary history ordering

`GET /api/employees/:id/salary-history` returns rows ordered by:

1. `effectiveDate DESC` — most recent salary change first, matching how HR Managers read history ("what changed most recently?")
2. `createdAt DESC` — tie-breaker for multiple changes on the same effective date (e.g. a correction applied the same day)

`previousSalary` and `previousCurrency` are `null` on the first-ever history row (the initial hire entry), which is always the last row in the descending list. This is the canonical signal that no prior compensation existed.

---

### `GET /api/employees/:id` — detail vs list

The detail endpoint reuses the same `EMPLOYEE_SELECT` shape as the list, ensuring the field set is identical between the two views. This consistency means the frontend never needs separate serialisers for list cards and detail panels. The only difference is that the detail endpoint returns a single object rather than an array.

---

### What is deliberately not implemented here

| Feature | Status |
|---------|--------|
| Salary editing / update | Next phase |
| Bulk import via CSV | Future phase |
| Export to CSV/Excel | Future phase |
| Employee creation / deletion | Future phase |
| Aggregated pay insights | Future phase |
