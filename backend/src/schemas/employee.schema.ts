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

// ── Supported currencies ──────────────────────────────────────────────────────
// Matches the ISO 4217 codes used in the seed data.
// Adding a new currency here automatically enables it for validation.

export const SUPPORTED_CURRENCIES = [
  'USD', 'GBP', 'EUR', 'CAD', 'AUD',
  'INR', 'SGD', 'BRL', 'MXN', 'JPY',
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

// ── Salary update body ────────────────────────────────────────────────────────

export const salaryUpdateSchema = z.object({
  // Salary: non-negative decimal accepted as number or numeric string
  salary: z
    .union([z.number(), z.string()])
    .transform((v) => (typeof v === 'string' ? parseFloat(v) : v))
    .pipe(
      z
        .number({ invalid_type_error: 'salary must be a number' })
        .nonnegative('salary must not be negative')
        .finite('salary must be a finite number'),
    ),

  // Currency: must be one of the application's supported ISO 4217 codes
  currency: z.enum(SUPPORTED_CURRENCIES, {
    errorMap: () => ({
      message: `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
    }),
  }),

  // effectiveDate: ISO 8601 date string (YYYY-MM-DD); coerced to Date
  effectiveDate: z
    .string({ required_error: 'effectiveDate is required' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'effectiveDate must be a date in YYYY-MM-DD format')
    .transform((s) => new Date(s))
    .pipe(
      z.date().refine((d) => !isNaN(d.getTime()), {
        message: 'effectiveDate is not a valid date',
      }),
    ),

  // reason: mandatory human-readable description of the change
  reason: z
    .string({ required_error: 'reason is required' })
    .trim()
    .min(1, 'reason must not be empty')
    .max(500, 'reason must be ≤ 500 characters'),

  // version: optimistic concurrency token — must match the current DB version
  version: z
    .number({ required_error: 'version is required', invalid_type_error: 'version must be a number' })
    .int('version must be an integer')
    .min(1, 'version must be ≥ 1'),
});

export type SalaryUpdateInput = z.infer<typeof salaryUpdateSchema>;
