/**
 * Employee read routes — mounted at /api/employees.
 *
 *   GET /api/employees                    — paginated, filtered, searchable list
 *   GET /api/employees/:id                — single employee detail
 *   GET /api/employees/:id/salary-history — complete salary history for one employee
 *
 * All routes require HR_MANAGER authentication.
 * Query validation is handled by Zod schemas; errors surface through the
 * central ApiError handler as { error: { code, message, details } }.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/requireAuth';
import { ApiError } from '../middleware/errorHandler';
import {
  employeeListQuerySchema,
  employeeIdParamSchema,
  salaryUpdateSchema,
} from '../schemas/employee.schema';
import {
  listEmployees,
  findEmployeeById,
  getEmployeeSalaryHistory,
  updateSalary,
} from '../services/employee.service';

const router = Router();

// All employee routes require authentication
router.use(requireAuth, requireRole('HR_MANAGER'));

// ── GET /api/employees ────────────────────────────────────────────────────────

router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Validate query parameters — Zod returns a clean typed object or throws
      const queryResult = employeeListQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
        return void next(
          ApiError.badRequest('Invalid query parameters', {
            fields: queryResult.error.flatten().fieldErrors,
          }),
        );
      }

      const result = await listEmployees(queryResult.data);

      res.status(200).json({
        status: 'ok',
        ...result, // spreads { data, pagination }
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/employees/:id ────────────────────────────────────────────────────

router.get(
  '/:id',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const paramResult = employeeIdParamSchema.safeParse(req.params);
      if (!paramResult.success) {
        return void next(ApiError.badRequest('Invalid employee id'));
      }

      const employee = await findEmployeeById(paramResult.data.id);
      if (!employee) {
        return void next(ApiError.notFound('Employee', paramResult.data.id));
      }

      res.status(200).json({ status: 'ok', data: employee });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/employees/:id/salary-history ─────────────────────────────────────

router.get(
  '/:id/salary-history',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const paramResult = employeeIdParamSchema.safeParse(req.params);
      if (!paramResult.success) {
        return void next(ApiError.badRequest('Invalid employee id'));
      }

      // Confirm the employee exists before querying history so the error is
      // "not found" rather than an empty history array for a missing employee
      const employee = await findEmployeeById(paramResult.data.id);
      if (!employee) {
        return void next(ApiError.notFound('Employee', paramResult.data.id));
      }

      const history = await getEmployeeSalaryHistory(paramResult.data.id);

      res.status(200).json({
        status: 'ok',
        data: history,
        meta: { employeeId: paramResult.data.id, count: history.length },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /api/employees/:id/salary ──────────────────────────────────────────

router.patch(
  '/:id/salary',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const paramResult = employeeIdParamSchema.safeParse(req.params);
      if (!paramResult.success) {
        return void next(ApiError.badRequest('Invalid employee id'));
      }

      const bodyResult = salaryUpdateSchema.safeParse(req.body);
      if (!bodyResult.success) {
        return void next(
          ApiError.badRequest('Invalid salary update input', {
            fields: bodyResult.error.flatten().fieldErrors,
          }),
        );
      }

      // req.user is guaranteed by the router-level requireAuth middleware
      const changedById = req.user!.sub;

      const { updatedEmployee, historyEntry } = await updateSalary(
        paramResult.data.id,
        bodyResult.data,
        changedById,
      );

      res.status(200).json({
        status: 'ok',
        data:   updatedEmployee,
        history: historyEntry,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
