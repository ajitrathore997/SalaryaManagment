/**
 * Zod schemas for employee API query parameters.
 *
 * All query parameters arrive as strings from the URL; coerce handles
 * numeric conversion.  Enum values are validated against the Prisma-generated
 * enums so the schema stays in sync with the DB automatically.
 */

import { z } from 'zod';
import { EmploymentType } from '@prisma/client';

// ── Constants ─────────────────────────────────────────────────────────────────

export const EMPLOYEE_LIST_MAX_PAGE_SIZE = 100;
export const EMPLOYEE_LIST_DEFAULT_PAGE_SIZE = 25;

// ── Employee list query ───────────────────────────────────────────────────────

export const employeeListQuerySchema = z.object({
  // ── Pagination ──────────────────────────────────────────────────────────────
  page: z.coerce
    .number({ invalid_type_error: 'page must be a number' })
    .int('page must be an integer')
    .min(1, 'page must be ≥ 1')
    .default(1),

  pageSize: z.coerce
    .number({ invalid_type_error: 'pageSize must be a number' })
    .int('pageSize must be an integer')
    .min(1, 'pageSize must be ≥ 1')
    .max(
      EMPLOYEE_LIST_MAX_PAGE_SIZE,
      `pageSize must be ≤ ${EMPLOYEE_LIST_MAX_PAGE_SIZE}`,
    )
    .default(EMPLOYEE_LIST_DEFAULT_PAGE_SIZE),

  // ── Full-text search ────────────────────────────────────────────────────────
  // Searches name and email with a case-insensitive contains match.
  // Empty string is treated as no search (same as omitting the param).
  search: z.string().trim().max(200, 'search must be ≤ 200 characters').optional(),

  // ── Exact-match filters — values must match the stored string exactly ───────
  country: z.string().trim().max(100).optional(),
  department: z.string().trim().max(100).optional(),
  jobTitle: z.string().trim().max(150).optional(),
  level: z.string().trim().max(50).optional(),

  // ── Enum filter — validated against the DB enum ──────────────────────────────
  employmentType: z
    .nativeEnum(EmploymentType, {
      errorMap: () => ({
        message: `employmentType must be one of: ${Object.values(EmploymentType).join(', ')}`,
      }),
    })
    .optional(),

  // ── Sort ────────────────────────────────────────────────────────────────────
  sortBy: z
    .enum(['name', 'email', 'country', 'department', 'level', 'baseAnnualSalary', 'hireDate', 'createdAt'], {
      errorMap: () => ({
        message: 'sortBy must be one of: name, email, country, department, level, baseAnnualSalary, hireDate, createdAt',
      }),
    })
    .default('name'),

  sortOrder: z
    .enum(['asc', 'desc'], {
      errorMap: () => ({ message: 'sortOrder must be "asc" or "desc"' }),
    })
    .default('asc'),
});

export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

// ── Single-employee params ────────────────────────────────────────────────────

export const employeeIdParamSchema = z.object({
  id: z.string().min(1, 'id is required').max(100, 'id is too long'),
});

export type EmployeeIdParam = z.infer<typeof employeeIdParamSchema>;
