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
