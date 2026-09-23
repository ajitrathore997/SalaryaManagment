/**
 * Employee service — all Prisma queries for employee read operations.
 *
 * Design notes:
 *  - findMany uses a single query with include for the manager relation to
 *    avoid N+1 (manager name resolved in the same round-trip).
 *  - search is a case-insensitive ILIKE against name OR email, using the
 *    Prisma `mode: 'insensitive'` option (PostgreSQL only).
 *  - Filters are AND-composed: every supplied filter must match.
 *  - count() runs with the same where clause so pagination totals are accurate.
 *  - Decimal fields (baseAnnualSalary) are serialised to strings by Prisma;
 *    callers should be aware that JSON consumers receive them as strings.
 *  - Salary history is ordered descending by effectiveDate then createdAt so
 *    the most recent change appears first.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { EmployeeListQuery, SalaryUpdateInput } from '../schemas/employee.schema';
import { ApiError } from '../middleware/errorHandler';

// ── Shared select shape — used by list and detail to keep responses consistent ─

const EMPLOYEE_SELECT = {
  id: true,
  name: true,
  email: true,
  country: true,
  department: true,
  jobTitle: true,
  level: true,
  hireDate: true,
  employmentType: true,
  gender: true,
  baseAnnualSalary: true,
  salaryCurrency: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  // Inline manager — avoid a separate query, returns id + name only
  manager: {
    select: { id: true, name: true, jobTitle: true },
  },
} satisfies Prisma.EmployeeSelect;

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmployeeRow = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SELECT }>;

export interface PaginatedEmployees {
  data: EmployeeRow[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

// ── List ──────────────────────────────────────────────────────────────────────

export async function listEmployees(query: EmployeeListQuery): Promise<PaginatedEmployees> {
  const { page, pageSize, search, country, department, jobTitle, level, employmentType, sortBy, sortOrder } = query;

  // Build the WHERE clause — all filters are AND-composed
  const where: Prisma.EmployeeWhereInput = {};

  // search: case-insensitive match on name OR email
  if (search && search.length > 0) {
    where.OR = [
      { name:  { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  // Exact-match string filters — indexed columns
  if (country)        where.country        = { equals: country,        mode: 'insensitive' };
  if (department)     where.department     = { equals: department,     mode: 'insensitive' };
  if (jobTitle)       where.jobTitle       = { equals: jobTitle,       mode: 'insensitive' };
  if (level)          where.level          = { equals: level,          mode: 'insensitive' };
  if (employmentType) where.employmentType = employmentType;

  // Run count and data fetch in parallel — same WHERE clause, one round-trip each
  const [total, data] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.findMany({
      where,
      select: EMPLOYEE_SELECT,
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    data,
    pagination: {
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage:      page < totalPages,
      hasPreviousPage:  page > 1,
    },
  };
}

// ── Detail ────────────────────────────────────────────────────────────────────

export async function findEmployeeById(id: string): Promise<EmployeeRow | null> {
  return prisma.employee.findUnique({
    where: { id },
    select: EMPLOYEE_SELECT,
  });
}

// ── Salary history ────────────────────────────────────────────────────────────

const HISTORY_SELECT = {
  id: true,
  previousSalary: true,
  previousCurrency: true,
  newSalary: true,
  newCurrency: true,
  effectiveDate: true,
  reason: true,
  createdAt: true,
  changedBy: {
    select: { id: true, email: true },
  },
} satisfies Prisma.SalaryHistorySelect;

export type SalaryHistoryRow = Prisma.SalaryHistoryGetPayload<{ select: typeof HISTORY_SELECT }>;

export async function getEmployeeSalaryHistory(employeeId: string): Promise<SalaryHistoryRow[]> {
  return prisma.salaryHistory.findMany({
    where: { employeeId },
    select: HISTORY_SELECT,
    // Most recent change first; createdAt breaks ties within the same date
    orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
  });
}

// ── Salary update ─────────────────────────────────────────────────────────────

export interface SalaryUpdateResult {
  updatedEmployee: EmployeeRow;
  historyEntry: SalaryHistoryRow;
}

/**
 * Update an employee's salary atomically.
 *
 * Optimistic concurrency is enforced via the `version` field:
 *   UPDATE employees SET ... version = version + 1
 *   WHERE id = ? AND version = ?
 *
 * If the WHERE clause matches 0 rows the version was stale (or the employee
 * was deleted). We disambiguate with a follow-up findUnique:
 *   - employee not found → throw NOT_FOUND
 *   - employee found but version differs → throw SALARY_VERSION_CONFLICT (409)
 *
 * Both the employee UPDATE and SalaryHistory INSERT run inside a single
 * Prisma interactive transaction so they are committed or rolled back together.
 */
export async function updateSalary(
  employeeId: string,
  input: SalaryUpdateInput,
  changedById: string,
): Promise<SalaryUpdateResult> {
  return prisma.$transaction(async (tx) => {
    // ── Step 1: version-checked UPDATE ────────────────────────────────────────
    // updateMany returns a count — 0 means either not found or version mismatch
    const updated = await tx.employee.updateMany({
      where: { id: employeeId, version: input.version },
      data: {
        baseAnnualSalary: input.salary,
        salaryCurrency:   input.currency,
        version:          { increment: 1 },
      },
    });

    if (updated.count === 0) {
      // Disambiguate: does the employee exist at all?
      const existing = await tx.employee.findUnique({
        where:  { id: employeeId },
        select: { id: true, version: true },
      });

      if (!existing) {
        throw ApiError.notFound('Employee', employeeId);
      }

      // Employee exists but version doesn't match → optimistic concurrency conflict
      throw new ApiError(
        409,
        'SALARY_VERSION_CONFLICT',
        'The salary was updated by another request. Refresh the employee record and try again.',
        {
          suppliedVersion: input.version,
          currentVersion:  existing.version,
        },
      );
    }

    // ── Step 2: fetch previous salary from the most recent history record ──────
    // We need the previous values to populate SalaryHistory correctly.
    // After the UPDATE the employee row has the new salary, so we look at the
    // most recent history entry (the one before this change).
    const previousHistory = await tx.salaryHistory.findFirst({
      where:   { employeeId },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
      select:  { newSalary: true, newCurrency: true },
    });

    // ── Step 3: insert SalaryHistory row ──────────────────────────────────────
    const historyEntry = await tx.salaryHistory.create({
      data: {
        employeeId,
        previousSalary:   previousHistory?.newSalary   ?? null,
        previousCurrency: previousHistory?.newCurrency ?? null,
        newSalary:        input.salary,
        newCurrency:      input.currency,
        effectiveDate:    input.effectiveDate,
        reason:           input.reason,
        changedById,
      },
      select: HISTORY_SELECT,
    });

    // ── Step 4: return the refreshed employee record ───────────────────────────
    const updatedEmployee = await tx.employee.findUniqueOrThrow({
      where:  { id: employeeId },
      select: EMPLOYEE_SELECT,
    });

    return { updatedEmployee, historyEntry };
  });
}
