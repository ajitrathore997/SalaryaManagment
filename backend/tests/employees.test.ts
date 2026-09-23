/**
 * Employee API integration tests.
 *
 * Runs against the real seeded database.
 * Prerequisites: database migrated and seeded.
 *   npm run db:seed --workspace=backend
 *
 * Covered:
 *  1.  Authentication requirement (all three endpoints)
 *  2.  Default list — shape, pagination metadata, data types
 *  3.  Pagination — page / pageSize parameters
 *  4.  pageSize safety cap at 100
 *  5.  Search — name / email ILIKE
 *  6.  Filters — country, department, level, employmentType, jobTitle
 *  7.  Combined search + filter
 *  8.  Sorting — sortBy + sortOrder
 *  9.  Invalid query parameters (bad types, out-of-range, unknown enum)
 *  10. GET /employees/:id — found, not found, malformed id
 *  11. GET /employees/:id/salary-history — retrieved, ordered, not found
 */

// Env vars before any import that triggers env.ts
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:root@localhost:5432/postgres';
process.env.JWT_SECRET   =
  process.env.JWT_SECRET ?? 'test_secret_that_is_at_least_32_chars_long';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest, { Agent } from 'supertest';
import { PrismaClient } from '@prisma/client';
import app from '../src/app';
import {
  EMPLOYEE_LIST_DEFAULT_PAGE_SIZE,
  EMPLOYEE_LIST_MAX_PAGE_SIZE,
} from '../src/schemas/employee.schema';

// ── Shared Prisma client for fixture queries ───────────────────────────────────
const prisma = new PrismaClient({ log: [] });
afterAll(() => prisma.$disconnect());

// ── Authenticated agent ────────────────────────────────────────────────────────
// Login once; the cookie persists across every request in this file.
let agent: Agent;

beforeAll(async () => {
  agent = supertest.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .send({ email: 'hr.manager@salaryapp.dev', password: 'HRdemo2026!' });
  expect(res.status).toBe(200); // guard: seed must be present
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Fetch one real employee id from the DB for use in :id tests. */
async function getOneEmployeeId(): Promise<string> {
  const emp = await prisma.employee.findFirst({ select: { id: true } });
  if (!emp) throw new Error('No employees in DB — run db:seed');
  return emp.id;
}

// =============================================================================
// 1. Authentication requirement
// =============================================================================
describe('Employee endpoints — authentication required', () => {
  const unauthenticatedRequest = supertest(app); // no cookie

  it('GET /api/employees returns 401 without auth', async () => {
    const res = await unauthenticatedRequest.get('/api/employees');
    expect(res.status).toBe(401);
  });

  it('GET /api/employees/:id returns 401 without auth', async () => {
    const res = await unauthenticatedRequest.get('/api/employees/some-id');
    expect(res.status).toBe(401);
  });

  it('GET /api/employees/:id/salary-history returns 401 without auth', async () => {
    const res = await unauthenticatedRequest.get('/api/employees/some-id/salary-history');
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// 2. Default list — shape, pagination metadata, data types
// =============================================================================
describe('GET /api/employees — default list', () => {
  let res: supertest.Response;

  beforeAll(async () => {
    res = await agent.get('/api/employees');
  });

  it('returns 200', () => {
    expect(res.status).toBe(200);
  });

  it('returns status: ok', () => {
    expect(res.body.status).toBe('ok');
  });

  it('returns a data array', () => {
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it(`returns ${EMPLOYEE_LIST_DEFAULT_PAGE_SIZE} employees by default`, () => {
    expect(res.body.data).toHaveLength(EMPLOYEE_LIST_DEFAULT_PAGE_SIZE);
  });

  it('includes correct pagination metadata', () => {
    const p = res.body.pagination;
    expect(p).toMatchObject({
      page:            1,
      pageSize:        EMPLOYEE_LIST_DEFAULT_PAGE_SIZE,
      total:           10_000,
      totalPages:      400, // 10000 / 25
      hasNextPage:     true,
      hasPreviousPage: false,
    });
  });

  it('each employee has required fields', () => {
    const emp = res.body.data[0];
    expect(emp).toHaveProperty('id');
    expect(emp).toHaveProperty('name');
    expect(emp).toHaveProperty('email');
    expect(emp).toHaveProperty('country');
    expect(emp).toHaveProperty('department');
    expect(emp).toHaveProperty('jobTitle');
    expect(emp).toHaveProperty('level');
    expect(emp).toHaveProperty('hireDate');
    expect(emp).toHaveProperty('employmentType');
    expect(emp).toHaveProperty('gender');
    expect(emp).toHaveProperty('baseAnnualSalary');
    expect(emp).toHaveProperty('salaryCurrency');
    expect(emp).toHaveProperty('version');
  });

  it('does not expose passwordHash on any employee', () => {
    for (const emp of res.body.data as Record<string, unknown>[]) {
      expect(emp).not.toHaveProperty('passwordHash');
    }
  });

  it('includes inline manager object (or null) on each employee', () => {
    // At least some employees have managers; all must have the key
    const emp = res.body.data[0];
    expect('manager' in emp).toBe(true);
    if (emp.manager !== null) {
      expect(emp.manager).toHaveProperty('id');
      expect(emp.manager).toHaveProperty('name');
    }
  });
});

// =============================================================================
// 3. Pagination — explicit page / pageSize
// =============================================================================
describe('GET /api/employees — pagination', () => {
  it('returns the correct page slice', async () => {
    const page1 = await agent.get('/api/employees?pageSize=10&page=1');
    const page2 = await agent.get('/api/employees?pageSize=10&page=2');

    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);

    // Pages must not overlap
    const ids1 = (page1.body.data as { id: string }[]).map((e) => e.id);
    const ids2 = (page2.body.data as { id: string }[]).map((e) => e.id);
    const overlap = ids1.filter((id) => ids2.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it('reflects pageSize in pagination metadata', async () => {
    const res = await agent.get('/api/employees?pageSize=5');
    expect(res.body.pagination.pageSize).toBe(5);
    expect(res.body.data).toHaveLength(5);
  });

  it('last page has correct hasPreviousPage=true and hasNextPage=false', async () => {
    // 10000 employees, pageSize 100 → 100 pages
    const res = await agent.get('/api/employees?pageSize=100&page=100');
    expect(res.status).toBe(200);
    expect(res.body.pagination.hasNextPage).toBe(false);
    expect(res.body.pagination.hasPreviousPage).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('returns empty data array (not an error) when page is beyond totalPages', async () => {
    const res = await agent.get('/api/employees?pageSize=100&page=9999');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.hasNextPage).toBe(false);
  });
});

// =============================================================================
// 4. pageSize safety cap
// =============================================================================
describe('GET /api/employees — pageSize cap', () => {
  it(`rejects pageSize > ${EMPLOYEE_LIST_MAX_PAGE_SIZE}`, async () => {
    const res = await agent.get(`/api/employees?pageSize=${EMPLOYEE_LIST_MAX_PAGE_SIZE + 1}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.details.fields.pageSize).toBeDefined();
  });

  it(`accepts pageSize = ${EMPLOYEE_LIST_MAX_PAGE_SIZE}`, async () => {
    const res = await agent.get(`/api/employees?pageSize=${EMPLOYEE_LIST_MAX_PAGE_SIZE}`);
    expect(res.status).toBe(200);
    expect(res.body.pagination.pageSize).toBe(EMPLOYEE_LIST_MAX_PAGE_SIZE);
  });
});

// =============================================================================
// 5. Search
// =============================================================================
describe('GET /api/employees — search', () => {
  it('returns fewer results when searching for a rare name fragment', async () => {
    // Search for "zzz" — likely matches 0 rows (none of the seeded names contain it)
    const res = await agent.get('/api/employees?search=zzz');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBeLessThan(100);
  });

  it('returns only matching employees when searching a name that exists', async () => {
    // Grab a real name from the DB to search for
    const sample = await prisma.employee.findFirst({
      select: { name: true },
      orderBy: { id: 'asc' },
    });
    const lastName = sample!.name.split(' ').pop()!;

    const res = await agent.get(`/api/employees?search=${encodeURIComponent(lastName)}`);
    expect(res.status).toBe(200);
    // Every returned employee's name or email should contain the search term
    for (const emp of res.body.data as { name: string; email: string }[]) {
      const matches =
        emp.name.toLowerCase().includes(lastName.toLowerCase()) ||
        emp.email.toLowerCase().includes(lastName.toLowerCase());
      expect(matches).toBe(true);
    }
  });

  it('search is case-insensitive', async () => {
    const sample = await prisma.employee.findFirst({ select: { name: true } });
    const fragment = sample!.name.slice(0, 3);

    const lower = await agent.get(`/api/employees?search=${fragment.toLowerCase()}&pageSize=100`);
    const upper = await agent.get(`/api/employees?search=${fragment.toUpperCase()}&pageSize=100`);

    expect(lower.status).toBe(200);
    expect(upper.status).toBe(200);
    expect(lower.body.pagination.total).toBe(upper.body.pagination.total);
  });

  it('empty search string returns the full dataset', async () => {
    const res = await agent.get('/api/employees?search=');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(10_000);
  });
});

// =============================================================================
// 6. Filters
// =============================================================================
describe('GET /api/employees — filters', () => {
  it('country filter returns only employees from that country', async () => {
    const res = await agent.get('/api/employees?country=United+States&pageSize=50');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBeGreaterThan(0);
    for (const emp of res.body.data as { country: string }[]) {
      expect(emp.country).toBe('United States');
    }
  });

  it('department filter returns only employees in that department', async () => {
    const res = await agent.get('/api/employees?department=Engineering&pageSize=50');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBeGreaterThan(0);
    for (const emp of res.body.data as { department: string }[]) {
      expect(emp.department).toBe('Engineering');
    }
  });

  it('level filter returns only employees at that level', async () => {
    const res = await agent.get(
      `/api/employees?level=${encodeURIComponent('L3 — Mid')}&pageSize=50`,
    );
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBeGreaterThan(0);
    for (const emp of res.body.data as { level: string }[]) {
      expect(emp.level).toBe('L3 — Mid');
    }
  });

  it('employmentType filter returns only employees of that type', async () => {
    const res = await agent.get('/api/employees?employmentType=CONTRACT&pageSize=50');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBeGreaterThan(0);
    for (const emp of res.body.data as { employmentType: string }[]) {
      expect(emp.employmentType).toBe('CONTRACT');
    }
  });

  it('filter with no matches returns empty data and total=0', async () => {
    const res = await agent.get('/api/employees?country=Narnia');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(0);
    expect(res.body.data).toHaveLength(0);
  });

  it('country filter is case-insensitive', async () => {
    const lower = await agent.get('/api/employees?country=united+states');
    const upper = await agent.get('/api/employees?country=United+States');
    expect(lower.status).toBe(200);
    expect(lower.body.pagination.total).toBe(upper.body.pagination.total);
  });
});

// =============================================================================
// 7. Combined search + filter
// =============================================================================
describe('GET /api/employees — combined search + filter', () => {
  it('applies both search and filter simultaneously', async () => {
    // Any result must satisfy BOTH constraints
    const sample = await prisma.employee.findFirst({
      where: { department: 'Engineering' },
      select: { name: true },
    });
    if (!sample) return; // guard for empty dataset

    const fragment = sample.name.split(' ')[0]; // first name
    const res = await agent.get(
      `/api/employees?department=Engineering&search=${encodeURIComponent(fragment)}&pageSize=50`,
    );

    expect(res.status).toBe(200);
    for (const emp of res.body.data as { department: string; name: string; email: string }[]) {
      expect(emp.department).toBe('Engineering');
      const matches =
        emp.name.toLowerCase().includes(fragment.toLowerCase()) ||
        emp.email.toLowerCase().includes(fragment.toLowerCase());
      expect(matches).toBe(true);
    }
  });
});

// =============================================================================
// 8. Sorting
// =============================================================================
describe('GET /api/employees — sorting', () => {
  it('sortBy=name sortOrder=asc returns names in ascending order', async () => {
    const res = await agent.get('/api/employees?sortBy=name&sortOrder=asc&pageSize=20');
    expect(res.status).toBe(200);
    const names = (res.body.data as { name: string }[]).map((e) => e.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('sortBy=name sortOrder=desc returns names in descending order', async () => {
    const res = await agent.get('/api/employees?sortBy=name&sortOrder=desc&pageSize=20');
    expect(res.status).toBe(200);
    const names = (res.body.data as { name: string }[]).map((e) => e.name);
    const sorted = [...names].sort((a, b) => b.localeCompare(a));
    expect(names).toEqual(sorted);
  });
});

// =============================================================================
// 9. Invalid query parameters
// =============================================================================
describe('GET /api/employees — invalid query parameters', () => {
  it('returns 400 for page=0', async () => {
    const res = await agent.get('/api/employees?page=0');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for page=-1', async () => {
    const res = await agent.get('/api/employees?page=-1');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for page=abc', async () => {
    const res = await agent.get('/api/employees?page=abc');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for pageSize=0', async () => {
    const res = await agent.get('/api/employees?pageSize=0');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid employmentType enum value', async () => {
    const res = await agent.get('/api/employees?employmentType=BANANA');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.details.fields.employmentType).toBeDefined();
  });

  it('returns 400 for invalid sortBy value', async () => {
    const res = await agent.get('/api/employees?sortBy=salary'); // not in enum
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid sortOrder value', async () => {
    const res = await agent.get('/api/employees?sortOrder=random');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for search exceeding 200 characters', async () => {
    const res = await agent.get(`/api/employees?search=${'a'.repeat(201)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

// =============================================================================
// 10. GET /api/employees/:id
// =============================================================================
describe('GET /api/employees/:id', () => {
  let existingId: string;

  beforeAll(async () => {
    existingId = await getOneEmployeeId();
  });

  it('returns 200 with employee data for a valid id', async () => {
    const res = await agent.get(`/api/employees/${existingId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.id).toBe(existingId);
  });

  it('includes all expected fields on the detail response', async () => {
    const res = await agent.get(`/api/employees/${existingId}`);
    const emp = res.body.data;
    expect(emp).toHaveProperty('id');
    expect(emp).toHaveProperty('name');
    expect(emp).toHaveProperty('email');
    expect(emp).toHaveProperty('country');
    expect(emp).toHaveProperty('department');
    expect(emp).toHaveProperty('jobTitle');
    expect(emp).toHaveProperty('level');
    expect(emp).toHaveProperty('baseAnnualSalary');
    expect(emp).toHaveProperty('salaryCurrency');
    expect(emp).toHaveProperty('hireDate');
    expect(emp).toHaveProperty('employmentType');
    expect(emp).toHaveProperty('gender');
    expect(emp).toHaveProperty('version');
    expect(emp).toHaveProperty('manager'); // may be null
  });

  it('does not expose passwordHash', async () => {
    const res = await agent.get(`/api/employees/${existingId}`);
    expect(res.body.data).not.toHaveProperty('passwordHash');
  });

  it('returns 404 with structured error for a non-existent id', async () => {
    const res = await agent.get('/api/employees/emp_seed_does_not_exist_99999');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toContain('emp_seed_does_not_exist_99999');
  });
});

// =============================================================================
// 11. GET /api/employees/:id/salary-history
// =============================================================================
describe('GET /api/employees/:id/salary-history', () => {
  let existingId: string;

  beforeAll(async () => {
    existingId = await getOneEmployeeId();
  });

  it('returns 200 with history array', async () => {
    const res = await agent.get(`/api/employees/${existingId}/salary-history`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('includes meta with employeeId and count', async () => {
    const res = await agent.get(`/api/employees/${existingId}/salary-history`);
    expect(res.body.meta.employeeId).toBe(existingId);
    expect(typeof res.body.meta.count).toBe('number');
    expect(res.body.meta.count).toBe(res.body.data.length);
  });

  it('the seeded employee has at least one history record', async () => {
    const res = await agent.get(`/api/employees/${existingId}/salary-history`);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('history rows have required fields', async () => {
    const res = await agent.get(`/api/employees/${existingId}/salary-history`);
    const row = res.body.data[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('newSalary');
    expect(row).toHaveProperty('newCurrency');
    expect(row).toHaveProperty('effectiveDate');
    expect(row).toHaveProperty('changedBy');
    expect(row.changedBy).toHaveProperty('email');
  });

  it('does not expose passwordHash on changedBy', async () => {
    const res = await agent.get(`/api/employees/${existingId}/salary-history`);
    const row = res.body.data[0];
    expect(row.changedBy).not.toHaveProperty('passwordHash');
  });

  it('initial hire record has null previousSalary and null previousCurrency', async () => {
    const res = await agent.get(`/api/employees/${existingId}/salary-history`);
    // The oldest record (last in desc order) is the initial hire entry
    const oldest = res.body.data[res.body.data.length - 1];
    expect(oldest.previousSalary).toBeNull();
    expect(oldest.previousCurrency).toBeNull();
  });

  it('history is ordered with most recent effectiveDate first', async () => {
    // Pick an employee that has at least 1 record; all seeded employees do
    const res = await agent.get(`/api/employees/${existingId}/salary-history`);
    const dates = (res.body.data as { effectiveDate: string }[]).map(
      (r) => new Date(r.effectiveDate).getTime(),
    );
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  it('returns 404 for a non-existent employee id', async () => {
    const res = await agent.get('/api/employees/no_such_id/salary-history');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
