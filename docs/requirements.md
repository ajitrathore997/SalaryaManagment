# Product Requirements — Salary Management

**Version:** 1.0 · **Status:** Approved · **Date:** September 2026

---

## Goal

Provide HR Managers with a single, reliable platform to manage salary data and derive pay insights across a global organisation of up to 10,000 employees.

---

## Primary user

**HR Manager** — responsible for maintaining accurate compensation records, benchmarking pay across roles and geographies, and producing insights that inform salary review decisions.

---

## In-scope features

| # | Feature area | Description |
|---|-------------|-------------|
| 1 | **Employee salary records** | View, create, update, and soft-delete employee compensation data (base salary, currency, effective date, pay grade, job level). |
| 2 | **Multi-country support** | Store and display salaries in local currencies; convert to a reporting currency for comparison. |
| 3 | **Pay grades & bands** | Define and manage organisation-wide grade structures and salary bands per country/region. |
| 4 | **Pay insights & reporting** | Aggregated views — salary distribution by department, country, grade, and gender equity indicators. |
| 5 | **Salary history** | Immutable audit trail of all changes to an employee's compensation. |
| 6 | **Bulk import** | CSV/Excel upload for initial data load and periodic batch updates. |
| 7 | **Role-based access** | HR Manager (full access) and read-only Viewer roles. |
| 8 | **Authentication** | Secure email/password login with JWT stored in httpOnly cookies; password hashing with bcrypt. |
| 9 | **Search & filter** | Filter employee records by department, country, grade, and name. |
| 10 | **Export** | Export filtered data to CSV or Excel for offline reporting. |

---

## Deliberately out-of-scope features

The following are **explicitly excluded** from this product and must not be built:

- Payroll processing or salary payment disbursement
- Attendance or leave management
- Overtime calculation
- Tax calculation or statutory deduction management
- Performance management (appraisals, OKRs)
- Recruitment or applicant tracking
- Benefits administration
- AI chatbots or natural-language analytics
- Real-time messaging or notifications
- Mobile native apps (responsive web is sufficient)

---

## Key reasoning and constraints

**Scale constraint** — 10,000 employees is the upper bound. The system must remain performant at this scale without requiring distributed infrastructure. A single PostgreSQL instance with proper indexing is sufficient.

**Data sensitivity** — salary data is highly sensitive. All API routes must be authenticated. Passwords must be hashed (bcrypt). JWTs must be short-lived and stored in httpOnly cookies to mitigate XSS. HTTPS is mandatory in production.

**Multi-currency** — salaries must be stored in their original currency. A configurable exchange-rate table (not a live API) is sufficient for reporting conversion; live FX feeds are out of scope.

**Audit requirements** — salary changes must be append-only in the history table. Records are soft-deleted, never hard-deleted.

**Technology lock-in** — the stack (Node.js/TypeScript/Express, React/Vite, MUI, PostgreSQL, Prisma, Zod, Vitest) is fixed. No runtime substitutions.

**Simplicity over premature optimisation** — no caching layer (Redis), no message queues, no microservices. A well-structured monolith is the target architecture.
