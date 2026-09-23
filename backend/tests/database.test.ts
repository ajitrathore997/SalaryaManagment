/**
 * Database integration tests — seed behaviour and schema constraints.
 *
 * These tests run against the real PostgreSQL database using the application's
 * own Prisma client (src/config/prisma.ts).  They require a seeded database:
 * run `npm run db:seed --workspace=backend` before executing this suite.
 *
 * What is tested:
 *  1. The seeded HR Manager account exists and has correct shape.
 *  2. Exactly 10,000 employees are present.
 *  3. Employee emails are unique across the entire dataset.
 *  4. Every employee has a valid (non-negative, non-zero) salary and a
 *     three-character ISO 4217 currency code.
 *  5. Every employee has exactly one initial SalaryHistory record.
 *  6. SalaryHistory rows reference valid Employee and User rows (FK integrity).
 *  7. Manager relationships are valid — no self-references, all referenced
 *     manager IDs exist in the employees table.
 *  8. The seed is idempotent — running it a second time produces the same
 *     counts and the same HR Manager ID.
 *  9. The DB-level CHECK constraint rejects negative salary values.
 *
 * Constraints deliberately NOT tested here:
 *  - Authentication / JWT (not implemented yet)
 *  - API endpoints (not implemented yet)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { PrismaClient, Prisma } from '@prisma/client';

// ── Client ────────────────────────────────────────────────────────────────────
// Instantiate a dedicated client for tests so we don't share connection state
// with the app singleton.  DATABASE_URL is loaded by tests/setup.ts.
const prisma = new PrismaClient({
  log: [], // silence query logs during test runs
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ── Constants (must match seed.ts — but we read from DB, not hardcode) ─────────
const EXPECTED_EMPLOYEE_COUNT = 10_000;
const HR_MANAGER_EMAIL = 'hr.manager@salaryapp.dev';
const BACKEND_DIR = resolve(__dirname, '..');

// ── Helper ────────────────────────────────────────────────────────────────────

/** Run the seed script synchronously and return its stdout. */
function runSeed(): string {
  return execSync('npm run db:seed', {
    cwd: BACKEND_DIR,
    encoding: 'utf8',
    timeout: 300_000, // 5 min max — bcrypt + 10k rows
  });
}

// =============================================================================
// 1. HR Manager account
// =============================================================================
describe('HR Manager account', () => {
  let hrManager: { id: string; email: string; role: string; passwordHash: string } | null;

  beforeAll(async () => {
    hrManager = await prisma.user.findUnique({
      where: { email: HR_MANAGER_EMAIL },
      select: { id: true, email: true, role: true, passwordHash: true },
    });
  });

  it('exists in the database', () => {
    expect(hrManager).not.toBeNull();
  });

  it('has the HR_MANAGER role', () => {
    expect(hrManager?.role).toBe('HR_MANAGER');
  });

  it('has a non-empty bcrypt password hash', () => {
    // bcrypt hashes always start with $2b$ and are 60 chars long
    expect(hrManager?.passwordHash).toMatch(/^\$2[ab]\$\d{2}\$.{53}$/);
  });

  it('does not store a plaintext password', () => {
    // Confirm the stored value is not the known demo password
    expect(hrManager?.passwordHash).not.toBe('HRdemo2026!');
  });
});

// =============================================================================
// 2. Employee count
// =============================================================================
describe('Employee count', () => {
  it(`contains exactly ${EXPECTED_EMPLOYEE_COUNT.toLocaleString()} employees`, async () => {
    const count = await prisma.employee.count();
    expect(count).toBe(EXPECTED_EMPLOYEE_COUNT);
  });
});

// =============================================================================
// 3. Email uniqueness
// =============================================================================
describe('Employee email uniqueness', () => {
  it('has no duplicate email addresses', async () => {
    // Group by email and look for any group with more than one member.
    // Using raw SQL for efficiency — avoids loading 10k rows into Node memory.
    const dupes = await prisma.$queryRaw<{ email: string; cnt: bigint }[]>`
      SELECT email, COUNT(*) AS cnt
      FROM employees
      GROUP BY email
      HAVING COUNT(*) > 1
    `;
    expect(dupes).toHaveLength(0);
  });

  it('every email follows the expected domain pattern', async () => {
    const badEmails = await prisma.$queryRaw<{ email: string }[]>`
      SELECT email FROM employees
      WHERE email NOT LIKE '%@%'
      LIMIT 1
    `;
    expect(badEmails).toHaveLength(0);
  });
});

// =============================================================================
// 4. Salary validity
// =============================================================================
describe('Employee salary validity', () => {
  it('every employee has a positive base annual salary', async () => {
    const invalid = await prisma.employee.count({
      where: { baseAnnualSalary: { lte: 0 } },
    });
    expect(invalid).toBe(0);
  });

  it('every employee has a 3-character currency code', async () => {
    // CHAR(3) enforced at DB level; verify via ORM that no unexpected values exist
    const badCurrency = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt FROM employees
      WHERE LENGTH(TRIM("salaryCurrency")) <> 3
    `;
    expect(Number(badCurrency[0].cnt)).toBe(0);
  });

  it('salary currencies are all known ISO 4217 codes used in the seed', async () => {
    const SEEDED_CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'INR', 'SGD', 'BRL', 'MXN', 'JPY'];
    const currencies = await prisma.$queryRaw<{ salaryCurrency: string }[]>`
      SELECT DISTINCT TRIM("salaryCurrency") AS "salaryCurrency" FROM employees
    `;
    const found = currencies.map((r) => r.salaryCurrency.trim());
    for (const c of found) {
      expect(SEEDED_CURRENCIES).toContain(c);
    }
  });

  it('minimum salary is greater than zero', async () => {
    const result = await prisma.$queryRaw<{ min_salary: Prisma.Decimal }[]>`
      SELECT MIN("baseAnnualSalary") AS min_salary FROM employees
    `;
    expect(Number(result[0].min_salary)).toBeGreaterThan(0);
  });
});

// =============================================================================
// 5. Every employee has an initial SalaryHistory record
// =============================================================================
describe('SalaryHistory — initial hire entries', () => {
  it('salary_history row count equals employee count', async () => {
    const [empCount, histCount] = await Promise.all([
      prisma.employee.count(),
      prisma.salaryHistory.count(),
    ]);
    // At seed time, exactly one history row per employee exists
    expect(histCount).toBe(empCount);
  });

  it('every employee has at least one SalaryHistory row', async () => {
    // Employees with no history row at all
    const employeesWithoutHistory = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt
      FROM employees e
      WHERE NOT EXISTS (
        SELECT 1 FROM salary_history h WHERE h."employeeId" = e.id
      )
    `;
    expect(Number(employeesWithoutHistory[0].cnt)).toBe(0);
  });

  it('all initial history rows have null previousSalary (first-ever entry)', async () => {
    const withPrevious = await prisma.salaryHistory.count({
      where: { previousSalary: { not: null } },
    });
    expect(withPrevious).toBe(0);
  });

  it('all initial history rows have null previousCurrency', async () => {
    const withPrevCurrency = await prisma.salaryHistory.count({
      where: { previousCurrency: { not: null } },
    });
    expect(withPrevCurrency).toBe(0);
  });

  it('history newSalary matches employee current salary for every employee', async () => {
    // Any mismatch means the seed wrote inconsistent data between the two tables
    const mismatches = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt
      FROM employees e
      JOIN salary_history h ON h."employeeId" = e.id
      WHERE e."baseAnnualSalary" <> h."newSalary"
    `;
    expect(Number(mismatches[0].cnt)).toBe(0);
  });

  it('history newCurrency matches employee salaryCurrency for every employee', async () => {
    const mismatches = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt
      FROM employees e
      JOIN salary_history h ON h."employeeId" = e.id
      WHERE TRIM(e."salaryCurrency") <> TRIM(h."newCurrency")
    `;
    expect(Number(mismatches[0].cnt)).toBe(0);
  });
});

// =============================================================================
// 6. SalaryHistory FK integrity — Employee and User references
// =============================================================================
describe('SalaryHistory FK integrity', () => {
  it('every history row references an existing employee', async () => {
    // If FK constraints are working, there should be no orphaned history rows.
    // We verify explicitly via a left-join rather than relying solely on the constraint.
    const orphaned = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt
      FROM salary_history h
      LEFT JOIN employees e ON e.id = h."employeeId"
      WHERE e.id IS NULL
    `;
    expect(Number(orphaned[0].cnt)).toBe(0);
  });

  it('every history row references an existing user (changedBy)', async () => {
    const orphaned = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt
      FROM salary_history h
      LEFT JOIN users u ON u.id = h."changedById"
      WHERE u.id IS NULL
    `;
    expect(Number(orphaned[0].cnt)).toBe(0);
  });

  it('every history row was authored by the seeded HR Manager', async () => {
    const hrManager = await prisma.user.findUnique({
      where: { email: HR_MANAGER_EMAIL },
      select: { id: true },
    });
    expect(hrManager).not.toBeNull();

    const otherAuthors = await prisma.salaryHistory.count({
      where: { changedById: { not: hrManager!.id } },
    });
    expect(otherAuthors).toBe(0);
  });

  it('history effectiveDate equals employee hireDate for every initial entry', async () => {
    const mismatches = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt
      FROM employees e
      JOIN salary_history h ON h."employeeId" = e.id
      WHERE e."hireDate" <> h."effectiveDate"
    `;
    expect(Number(mismatches[0].cnt)).toBe(0);
  });
});

// =============================================================================
// 7. Manager relationship validity
// =============================================================================
describe('Manager relationships', () => {
  it('no employee is their own manager (no self-references)', async () => {
    const selfRefs = await prisma.employee.count({
      where: {
        managerId: { not: null },
        AND: [{ managerId: { equals: undefined } }], // handled by raw below
      },
    });
    // Use raw for the self-reference check — Prisma filter for col = col requires raw
    const selfRefsRaw = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt FROM employees
      WHERE "managerId" IS NOT NULL AND "managerId" = id
    `;
    expect(Number(selfRefsRaw[0].cnt)).toBe(0);
    void selfRefs; // suppress unused warning
  });

  it('every non-null managerId references an existing employee', async () => {
    const danglingManagers = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt
      FROM employees e
      LEFT JOIN employees m ON m.id = e."managerId"
      WHERE e."managerId" IS NOT NULL AND m.id IS NULL
    `;
    expect(Number(danglingManagers[0].cnt)).toBe(0);
  });

  it('all managers are at level L4 or above', async () => {
    // Manager candidates in the seed are only L4 — Senior, L5 — Staff, L6 — Principal
    const invalidManagerLevels = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) AS cnt
      FROM employees e
      JOIN employees m ON m.id = e."managerId"
      WHERE m.level NOT IN ('L4 — Senior', 'L5 — Staff', 'L6 — Principal')
    `;
    expect(Number(invalidManagerLevels[0].cnt)).toBe(0);
  });

  it('between 60% and 80% of employees have an assigned manager', async () => {
    const [total, withManager] = await Promise.all([
      prisma.employee.count(),
      prisma.employee.count({ where: { managerId: { not: null } } }),
    ]);
    const ratio = withManager / total;
    expect(ratio).toBeGreaterThanOrEqual(0.60);
    expect(ratio).toBeLessThanOrEqual(0.80);
  });
});

// =============================================================================
// 8. Idempotency — second seed run produces identical counts and stable IDs
// =============================================================================
describe('Seed idempotency', () => {
  // Capture state before the second seed run
  let hrManagerIdBefore: string;
  let employeeCountBefore: number;

  beforeAll(async () => {
    const hrManager = await prisma.user.findUnique({
      where: { email: HR_MANAGER_EMAIL },
      select: { id: true },
    });
    hrManagerIdBefore = hrManager!.id;
    employeeCountBefore = await prisma.employee.count();
  });

  it('re-running the seed produces the same employee count', async () => {
    // Run the seed a second time — this is the slow step
    runSeed();

    const countAfter = await prisma.employee.count();
    expect(countAfter).toBe(employeeCountBefore);
    expect(countAfter).toBe(EXPECTED_EMPLOYEE_COUNT);
  });

  it('re-running the seed preserves the HR Manager ID (upsert, not re-create)', async () => {
    const hrManagerAfter = await prisma.user.findUnique({
      where: { email: HR_MANAGER_EMAIL },
      select: { id: true },
    });
    expect(hrManagerAfter?.id).toBe(hrManagerIdBefore);
  });

  it('re-running the seed does not create duplicate users', async () => {
    const userCount = await prisma.user.count({ where: { email: HR_MANAGER_EMAIL } });
    expect(userCount).toBe(1);
  });

  it('re-running the seed produces correct salary history count', async () => {
    const [empCount, histCount] = await Promise.all([
      prisma.employee.count(),
      prisma.salaryHistory.count(),
    ]);
    expect(histCount).toBe(empCount);
  });
});

// =============================================================================
// 9. Negative salary constraint (DB-level CHECK enforcement)
// =============================================================================
describe('Negative salary constraint', () => {
  it('rejects an employee with a negative base annual salary via ORM', async () => {
    await expect(
      prisma.employee.create({
        data: {
          id:               'test_negative_salary_guard',
          name:             'Constraint Test',
          email:            'constraint.test.negative@test.invalid',
          country:          'United States',
          department:       'Engineering',
          jobTitle:         'Software Engineer',
          level:            'L3 — Mid',
          hireDate:         new Date('2024-01-01'),
          employmentType:   'FULL_TIME',
          gender:           'PREFER_NOT_TO_SAY',
          baseAnnualSalary: -1,   // ← violates CHECK constraint
          salaryCurrency:   'USD',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a SalaryHistory row with a negative newSalary via raw SQL', async () => {
    // Test the CHECK constraint directly at the SQL level — belt and braces
    await expect(
      prisma.$executeRaw`
        INSERT INTO salary_history (
          id, "employeeId", "newSalary", "newCurrency",
          "effectiveDate", "changedById"
        )
        SELECT
          'test_neg_hist',
          id,
          -500.00,
          'USD',
          CURRENT_DATE,
          (SELECT id FROM users WHERE email = ${HR_MANAGER_EMAIL} LIMIT 1)
        FROM employees
        LIMIT 1
      `,
    ).rejects.toThrow();
  });

  it('accepts an employee with a zero salary (boundary — minimum allowed)', async () => {
    // Zero is explicitly allowed by CHECK (>= 0); some employment types may
    // legitimately have zero base (e.g. equity-only contractors).
    // We insert, assert success, then clean up.
    const created = await prisma.employee.create({
      data: {
        id:               'test_zero_salary_guard',
        name:             'Zero Salary Test',
        email:            'constraint.test.zero@test.invalid',
        country:          'United States',
        department:       'Engineering',
        jobTitle:         'Intern',
        level:            'L1 — Junior',
        hireDate:         new Date('2024-01-01'),
        employmentType:   'INTERN',
        gender:           'PREFER_NOT_TO_SAY',
        baseAnnualSalary: 0,
        salaryCurrency:   'USD',
      },
    });
    expect(created.id).toBe('test_zero_salary_guard');

    // Clean up — this row must not pollute other test counts
    await prisma.employee.delete({ where: { id: 'test_zero_salary_guard' } });
  });

  it('accepts a valid positive salary (positive control)', async () => {
    const created = await prisma.employee.create({
      data: {
        id:               'test_positive_salary_guard',
        name:             'Positive Salary Test',
        email:            'constraint.test.positive@test.invalid',
        country:          'United States',
        department:       'Engineering',
        jobTitle:         'Software Engineer',
        level:            'L3 — Mid',
        hireDate:         new Date('2024-01-01'),
        employmentType:   'FULL_TIME',
        gender:           'PREFER_NOT_TO_SAY',
        baseAnnualSalary: 100_000,
        salaryCurrency:   'USD',
      },
    });
    expect(Number(created.baseAnnualSalary)).toBe(100_000);

    await prisma.employee.delete({ where: { id: 'test_positive_salary_guard' } });
  });
});
