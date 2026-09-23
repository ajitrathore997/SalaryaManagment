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
│  Tables: employees, salaries, salary_history,        │
│          pay_grades, countries, users                │
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
