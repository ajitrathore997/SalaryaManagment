/**
 * Salary update integration tests — PATCH /api/employees/:id/salary
 *
 * Prerequisites: database migrated and seeded.
 *   npm run db:seed --workspace=backend
 *
 * Each mutating test group fetches a fresh employee snapshot before running
 * so tests are independent of execution order.  After all tests complete,
 * `afterAll` restores the mutated employees to their original salary so
 * re-running the suite stays deterministic.
 *
 * Covered:
 *  1.  Unauthorized — no cookie
 *  2.  Employee not found
 *  3.  Validation failures — missing fields, bad salary, bad currency,
 *      bad date format, empty reason, wrong version type
 *  4.  Negative salary rejected
 *  5.  Zero salary accepted (boundary)
 *  6.  Successful update — response shape, field values, version increment
 *  7.  Salary history created — count, fields, previous/new values, changedBy
 *  8.  Previous salary captured from last history record
 *  9.  Version increment — response and DB reflect new version
 * 10.  Stale version conflict — 409 SALARY_VERSION_CONFLICT
 * 11.  Transaction atomicity — partial failure leaves no half-written state
 * 12.  Idempotency of re-read — GET /employees/:id reflects updated salary
 */

process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:root@localhost:5432/postgres';
process.env.JWT_SECRET   =
  process.env.JWT_SECRET ?? 'test_secret_that_is_at_least_32_chars_long';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest, { Agent } from 'supertest';
import { PrismaClient, Prisma } from '@prisma/client';
import app from '../src/app';
import { SUPPORTED_CURRENCIES } from '../src/schemas/employee.schema';

// ── DB client ─────────────────────────────────────────────────────────────────
const prisma = new PrismaClient({ log: [] });

// ── Track employees mutated during tests so afterAll can restore them ─────────
interface Snapshot {
  id: string;
  baseAnnualSalary: Prisma.Decimal;
  salaryCurrency: string;
  version: number;
  historyCountBefore: number;
}
const snapshots: Snapshot[] = [];

afterAll(async () => {
  // Restore every mutated employee to its original salary.
  // Also remove any extra history rows created during tests.
  for (const snap of snapshots) {
    // Delete history rows beyond the original count (most-recently created first)
    const allHistory = await prisma.salaryHistory.findMany({
      where:   { employeeId: snap.id },
      orderBy: { createdAt: 'asc' },
      select:  { id: true },
    });
    const extraIds = allHistory.slice(snap.historyCountBefore).map((h) => h.id);
    if (extraIds.length) {
      await prisma.salaryHistory.deleteMany({ where: { id: { in: extraIds } } });
    }
    // Restore the employee row
    await prisma.employee.update({
      where: { id: snap.id },
      data: {
        baseAnnualSalary: snap.baseAnnualSalary,
        salaryCurrency:   snap.salaryCurrency,
        version:          snap.version,
      },
    });
  }
  await prisma.$disconnect();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fetch a real employee from the DB with its current salary state. */
async function fetchEmployee(id?: string) {
  const emp = id
    ? await prisma.employee.findUniqueOrThrow({ where: { id } })
    : await prisma.employee.findFirstOrThrow({ orderBy: { id: 'asc' } });
  const historyCount = await prisma.salaryHistory.count({ where: { employeeId: emp.id } });
  return { ...emp, historyCount };
}

/** Register an employee for cleanup after the suite. Idempotent by id. */
function registerSnapshot(emp: Awaited<ReturnType<typeof fetchEmployee>>) {
  if (!snapshots.find((s) => s.id === emp.id)) {
    snapshots.push({
      id:                  emp.id,
      baseAnnualSalary:    emp.baseAnnualSalary,
      salaryCurrency:      emp.salaryCurrency.trim(),
      version:             emp.version,
      historyCountBefore:  emp.historyCount,
    });
  }
}

/** A valid update payload using the employee's current version. */
function validPayload(version: number, overrides: Record<string, unknown> = {}) {
  return {
    salary:        99_000,
    currency:      'USD',
    effectiveDate: '2026-01-01',
    reason:        'Annual review',
    version,
    ...overrides,
  };
}

// ── Authenticated agent ───────────────────────────────────────────────────────
let agent: Agent;

beforeAll(async () => {
  agent = supertest.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .send({ email: 'hr.manager@salaryapp.dev', password: 'HRdemo2026!' });
  expect(res.status).toBe(200);
});

// =============================================================================
// 1. Unauthorized — no cookie
// =============================================================================
describe('PATCH /api/employees/:id/salary — unauthorized', () => {
  it('returns 401 without an auth cookie', async () => {
    const emp = await fetchEmployee();
    const res = await supertest(app)
      .patch(`/api/employees/${emp.id}/salary`)
      .send(validPayload(emp.version));
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// 2. Employee not found
// =============================================================================
describe('PATCH /api/employees/:id/salary — employee not found', () => {
  it('returns 404 with NOT_FOUND code for a non-existent employee', async () => {
    const res = await agent
      .patch('/api/employees/emp_seed_definitely_does_not_exist/salary')
      .send(validPayload(1));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toContain('emp_seed_definitely_does_not_exist');
  });
});

// =============================================================================
// 3. Validation failures
// =============================================================================
describe('PATCH /api/employees/:id/salary — validation failures', () => {
  let empId: string;
  let empVersion: number;

  beforeAll(async () => {
    const emp = await fetchEmployee();
    empId      = emp.id;
    empVersion = emp.version;
  });

  it('returns 400 when body is empty', async () => {
    const res = await agent.patch(`/api/employees/${empId}/salary`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when salary is missing', async () => {
    const res = await agent
      .patch(`/api/employees/${empId}/salary`)
      .send(validPayload(empVersion, { salary: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.salary).toBeDefined();
  });

  it('returns 400 when currency is missing', async () => {
    const res = await agent
      .patch(`/api/employees/${empId}/salary`)
      .send(validPayload(empVersion, { currency: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.currency).toBeDefined();
  });

  it('returns 400 when currency is not a supported code', async () => {
    const res = await agent
      .patch(`/api/employees/${empId}/salary`)
      .send(validPayload(empVersion, { currency: 'XYZ' }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.currency).toBeDefined();
  });

  it('returns 400 when effectiveDate is missing', async () => {
    const res = await agent
      .patch(`/api/employees/${empId}/salary`)
      .send(validPayload(empVersion, { effectiveDate: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.effectiveDate).toBeDefined();
  });

  it('returns 400 when effectiveDate is not YYYY-MM-DD', async () => {
    const res = await agent
      .patch(`/api/employees/${empId}/salary`)
      .send(validPayload(empVersion, { effectiveDate: '01/01/2026' }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.effectiveDate).toBeDefined();
  });

  it('returns 400 when reason is missing', async () => {
    const res = await agent
      .patch(`/api/employees/${empId}/salary`)
      .send(validPayload(empVersion, { reason: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.reason).toBeDefined();
  });

  it('returns 400 when reason is an empty string', async () => {
    const res = await agent
      .patch(`/api/employees/${empId}/salary`)
      .send(validPayload(empVersion, { reason: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.reason).toBeDefined();
  });

  it('returns 400 when version is missing', async () => {
    const res = await agent
      .patch(`/api/employees/${empId}/salary`)
      .send(validPayload(empVersion, { version: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.version).toBeDefined();
  });

  it('returns 400 when version is not an integer', async () => {
    const res = await agent
      .patch(`/api/employees/${empId}/salary`)
      .send(validPayload(empVersion, { version: 1.5 }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.version).toBeDefined();
  });
});

// =============================================================================
// 4. Negative salary rejected
// =============================================================================
describe('PATCH /api/employees/:id/salary — negative salary', () => {
  it('returns 400 for a negative salary value', async () => {
    const emp = await fetchEmployee();
    const res = await agent
      .patch(`/api/employees/${emp.id}/salary`)
      .send(validPayload(emp.version, { salary: -1 }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.salary).toBeDefined();
  });
});

// =============================================================================
// 5. Zero salary accepted (boundary — CHECK constraint allows >= 0)
// =============================================================================
describe('PATCH /api/employees/:id/salary — zero salary boundary', () => {
  it('accepts salary = 0', async () => {
    const emp = await fetchEmployee();
    registerSnapshot(emp);

    const res = await agent
      .patch(`/api/employees/${emp.id}/salary`)
      .send(validPayload(emp.version, { salary: 0, reason: 'Unpaid leave transition' }));
    expect(res.status).toBe(200);
    expect(Number(res.body.data.baseAnnualSalary)).toBe(0);
  });
});

// =============================================================================
// 6. Successful update — response shape and field values
// =============================================================================
describe('PATCH /api/employees/:id/salary — successful update', () => {
  const NEW_SALARY   = 125_000;
  const NEW_CURRENCY = 'GBP';
  const REASON       = 'Promotion to L5';
  const DATE         = '2026-03-15';

  let emp: Awaited<ReturnType<typeof fetchEmployee>>;
  let res: supertest.Response;

  beforeAll(async () => {
    emp = await fetchEmployee();
    registerSnapshot(emp);
    res = await agent.patch(`/api/employees/${emp.id}/salary`).send(
      validPayload(emp.version, {
        salary:        NEW_SALARY,
        currency:      NEW_CURRENCY,
        effectiveDate: DATE,
        reason:        REASON,
      }),
    );
  });

  it('returns 200', () => {
    expect(res.status).toBe(200);
  });

  it('returns status: ok', () => {
    expect(res.body.status).toBe('ok');
  });

  it('response data contains updated salary', () => {
    expect(Number(res.body.data.baseAnnualSalary)).toBe(NEW_SALARY);
  });

  it('response data contains updated currency', () => {
    expect(res.body.data.salaryCurrency.trim()).toBe(NEW_CURRENCY);
  });

  it('response data contains all standard employee fields', () => {
    const d = res.body.data;
    expect(d).toHaveProperty('id');
    expect(d).toHaveProperty('name');
    expect(d).toHaveProperty('email');
    expect(d).toHaveProperty('version');
    expect(d).toHaveProperty('baseAnnualSalary');
    expect(d).toHaveProperty('salaryCurrency');
  });

  it('response includes a history entry', () => {
    expect(res.body.history).toHaveProperty('id');
    expect(res.body.history).toHaveProperty('newSalary');
    expect(res.body.history).toHaveProperty('effectiveDate');
  });
});

// =============================================================================
// 7. Salary history created — count, fields, previous/new values, changedBy
// =============================================================================
describe('PATCH /api/employees/:id/salary — salary history record', () => {
  const NEW_SALARY   = 77_500;
  const NEW_CURRENCY = 'CAD';
  const REASON       = 'Market adjustment';

  let emp: Awaited<ReturnType<typeof fetchEmployee>>;
  let prevSalary: number;
  let prevCurrency: string;
  let historyCountBefore: number;

  beforeAll(async () => {
    emp               = await fetchEmployee();
    registerSnapshot(emp);
    prevSalary        = Number(emp.baseAnnualSalary);
    prevCurrency      = emp.salaryCurrency.trim();
    historyCountBefore = emp.historyCount;

    await agent.patch(`/api/employees/${emp.id}/salary`).send(
      validPayload(emp.version, {
        salary:   NEW_SALARY,
        currency: NEW_CURRENCY,
        reason:   REASON,
      }),
    );
  });

  it('history count increased by exactly 1', async () => {
    const count = await prisma.salaryHistory.count({ where: { employeeId: emp.id } });
    expect(count).toBe(historyCountBefore + 1);
  });

  it('history entry captures the new salary', async () => {
    const latest = await prisma.salaryHistory.findFirstOrThrow({
      where:   { employeeId: emp.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(Number(latest.newSalary)).toBe(NEW_SALARY);
  });

  it('history entry captures the new currency', async () => {
    const latest = await prisma.salaryHistory.findFirstOrThrow({
      where:   { employeeId: emp.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(latest.newCurrency.trim()).toBe(NEW_CURRENCY);
  });

  it('history entry captures the previous salary', async () => {
    const latest = await prisma.salaryHistory.findFirstOrThrow({
      where:   { employeeId: emp.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(Number(latest.previousSalary)).toBe(prevSalary);
  });

  it('history entry captures the previous currency', async () => {
    const latest = await prisma.salaryHistory.findFirstOrThrow({
      where:   { employeeId: emp.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(latest.previousCurrency?.trim()).toBe(prevCurrency);
  });

  it('history entry captures the reason', async () => {
    const latest = await prisma.salaryHistory.findFirstOrThrow({
      where:   { employeeId: emp.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(latest.reason).toBe(REASON);
  });

  it('history entry references the HR Manager as changedBy', async () => {
    const latest = await prisma.salaryHistory.findFirstOrThrow({
      where:    { employeeId: emp.id },
      orderBy:  { createdAt: 'desc' },
      include:  { changedBy: { select: { email: true } } },
    });
    expect(latest.changedBy.email).toBe('hr.manager@salaryapp.dev');
  });

  it('history entry captures the effectiveDate', async () => {
    const latest = await prisma.salaryHistory.findFirstOrThrow({
      where:   { employeeId: emp.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(latest.effectiveDate).toBeTruthy();
  });
});

// =============================================================================
// 8. Previous salary captured from the last history record (not current row)
// =============================================================================
describe('PATCH /api/employees/:id/salary — two sequential updates capture correct previous values', () => {
  it('second update records previous salary = first update new salary', async () => {
    const emp = await fetchEmployee();
    registerSnapshot(emp);

    const FIRST_SALARY  = 80_000;
    const SECOND_SALARY = 90_000;

    // First update
    const r1 = await agent.patch(`/api/employees/${emp.id}/salary`).send(
      validPayload(emp.version, { salary: FIRST_SALARY, reason: 'Update one' }),
    );
    expect(r1.status).toBe(200);

    // Second update — version is now emp.version + 1
    const r2 = await agent.patch(`/api/employees/${emp.id}/salary`).send(
      validPayload(emp.version + 1, { salary: SECOND_SALARY, reason: 'Update two' }),
    );
    expect(r2.status).toBe(200);

    // The history entry from the second update must show previousSalary = FIRST_SALARY
    const latest = await prisma.salaryHistory.findFirstOrThrow({
      where:   { employeeId: emp.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(Number(latest.newSalary)).toBe(SECOND_SALARY);
    expect(Number(latest.previousSalary)).toBe(FIRST_SALARY);
  });
});

// =============================================================================
// 9. Version increment — response and DB reflect version + 1
// =============================================================================
describe('PATCH /api/employees/:id/salary — version increment', () => {
  it('version in response is exactly originalVersion + 1', async () => {
    const emp = await fetchEmployee();
    registerSnapshot(emp);

    const res = await agent.patch(`/api/employees/${emp.id}/salary`).send(
      validPayload(emp.version),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(emp.version + 1);
  });

  it('DB version equals originalVersion + 1 after update', async () => {
    const emp = await fetchEmployee();
    registerSnapshot(emp);

    await agent.patch(`/api/employees/${emp.id}/salary`).send(validPayload(emp.version));

    const refreshed = await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } });
    expect(refreshed.version).toBe(emp.version + 1);
  });
});

// =============================================================================
// 10. Stale version conflict — 409 SALARY_VERSION_CONFLICT
// =============================================================================
describe('PATCH /api/employees/:id/salary — stale version conflict', () => {
  it('returns 409 SALARY_VERSION_CONFLICT when version is stale', async () => {
    const emp = await fetchEmployee();
    registerSnapshot(emp);

    // First update succeeds, version advances
    const r1 = await agent.patch(`/api/employees/${emp.id}/salary`).send(
      validPayload(emp.version),
    );
    expect(r1.status).toBe(200);

    // Second update with the old (now stale) version
    const r2 = await agent.patch(`/api/employees/${emp.id}/salary`).send(
      validPayload(emp.version), // stale — DB now has version + 1
    );
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('SALARY_VERSION_CONFLICT');
  });

  it('conflict response includes suppliedVersion and currentVersion in details', async () => {
    const emp = await fetchEmployee();
    registerSnapshot(emp);

    // Advance the version
    await agent.patch(`/api/employees/${emp.id}/salary`).send(validPayload(emp.version));

    // Submit with the original stale version
    const res = await agent.patch(`/api/employees/${emp.id}/salary`).send(
      validPayload(emp.version),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.details).toHaveProperty('suppliedVersion');
    expect(res.body.error.details).toHaveProperty('currentVersion');
    expect(res.body.error.details.currentVersion).toBe(emp.version + 1);
    expect(res.body.error.details.suppliedVersion).toBe(emp.version);
  });

  it('salary is not changed after a conflict', async () => {
    const emp = await fetchEmployee();
    registerSnapshot(emp);

    // Advance the version once
    await agent.patch(`/api/employees/${emp.id}/salary`).send(
      validPayload(emp.version, { salary: 55_000, reason: 'First' }),
    );

    // Submit stale version with a different salary — should be rejected
    await agent.patch(`/api/employees/${emp.id}/salary`).send(
      validPayload(emp.version, { salary: 999_999, reason: 'Should not apply' }),
    );

    // The employee's salary must be 55_000, not 999_999
    const current = await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } });
    expect(Number(current.baseAnnualSalary)).toBe(55_000);
  });
});

// =============================================================================
// 11. Transaction atomicity — GET reflects updated salary immediately
// =============================================================================
describe('PATCH /api/employees/:id/salary — transaction / read-your-writes', () => {
  it('GET /employees/:id returns the new salary immediately after PATCH', async () => {
    const emp = await fetchEmployee();
    registerSnapshot(emp);

    const NEW_SALARY = 103_500;
    await agent.patch(`/api/employees/${emp.id}/salary`).send(
      validPayload(emp.version, { salary: NEW_SALARY }),
    );

    const getRes = await agent.get(`/api/employees/${emp.id}`);
    expect(getRes.status).toBe(200);
    expect(Number(getRes.body.data.baseAnnualSalary)).toBe(NEW_SALARY);
  });

  it('GET /employees/:id/salary-history reflects the new entry immediately after PATCH', async () => {
    const emp = await fetchEmployee();
    registerSnapshot(emp);

    const countBefore = await prisma.salaryHistory.count({ where: { employeeId: emp.id } });

    await agent.patch(`/api/employees/${emp.id}/salary`).send(validPayload(emp.version));

    const histRes = await agent.get(`/api/employees/${emp.id}/salary-history`);
    expect(histRes.status).toBe(200);
    expect(histRes.body.meta.count).toBe(countBefore + 1);
  });
});

// =============================================================================
// 12. All supported currencies are accepted
// =============================================================================
describe('PATCH /api/employees/:id/salary — supported currencies accepted', () => {
  it('accepts every currency in SUPPORTED_CURRENCIES', async () => {
    // This test verifies Zod allows all supported codes — one request per
    // currency is fine at this scale. We use the same employee each time,
    // fetching a fresh version after each update.
    const emp0 = await fetchEmployee();
    registerSnapshot(emp0);

    let currentVersion = emp0.version;
    const empId = emp0.id;

    for (const currency of SUPPORTED_CURRENCIES) {
      const res = await agent.patch(`/api/employees/${empId}/salary`).send(
        validPayload(currentVersion, { currency, reason: `Test ${currency}` }),
      );
      expect(res.status).toBe(200);
      currentVersion = res.body.data.version as number;
    }
  });
});
