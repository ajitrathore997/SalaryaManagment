-- =============================================================================
-- Migration: init_schema
-- Creates the initial schema for the Salary Management application.
-- Tables: users, employees, salary_history
-- Includes CHECK constraints for non-negative salary values (not expressible
-- in Prisma SDL) and all required indexes.
-- =============================================================================

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('HR_MANAGER');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY');

-- CreateTable
CREATE TABLE "users" (
    "id"           TEXT        NOT NULL,
    "email"        TEXT        NOT NULL,
    "passwordHash" TEXT        NOT NULL,
    "role"         "Role"      NOT NULL DEFAULT 'HR_MANAGER',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id"              TEXT             NOT NULL,
    "name"            TEXT             NOT NULL,
    "email"           TEXT             NOT NULL,
    "country"         TEXT             NOT NULL,
    "department"      TEXT             NOT NULL,
    "jobTitle"        TEXT             NOT NULL,
    "level"           TEXT             NOT NULL,
    "hireDate"        DATE             NOT NULL,
    "employmentType"  "EmploymentType" NOT NULL,
    "gender"          "Gender"         NOT NULL,
    "baseAnnualSalary" DECIMAL(15,4)   NOT NULL,
    "salaryCurrency"  CHAR(3)          NOT NULL,
    "managerId"       TEXT,
    "version"         INTEGER          NOT NULL DEFAULT 1,
    "createdAt"       TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3)     NOT NULL,
    CONSTRAINT "employees_pkey"                PRIMARY KEY ("id"),
    CONSTRAINT "employees_salary_non_negative" CHECK ("baseAnnualSalary" >= 0)
);

-- CreateTable
CREATE TABLE "salary_history" (
    "id"               TEXT          NOT NULL,
    "employeeId"       TEXT          NOT NULL,
    "previousSalary"   DECIMAL(15,4),
    "previousCurrency" CHAR(3),
    "newSalary"        DECIMAL(15,4) NOT NULL,
    "newCurrency"      CHAR(3)       NOT NULL,
    "effectiveDate"    DATE          NOT NULL,
    "reason"           TEXT,
    "changedById"      TEXT          NOT NULL,
    "createdAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "salary_history_pkey"                   PRIMARY KEY ("id"),
    CONSTRAINT "salary_history_new_salary_non_negative" CHECK ("newSalary" >= 0),
    CONSTRAINT "salary_history_prev_salary_non_negative" CHECK ("previousSalary" IS NULL OR "previousSalary" >= 0)
);

-- CreateIndex (unique)
CREATE UNIQUE INDEX "users_email_key"     ON "users"("email");
CREATE UNIQUE INDEX "employees_email_key" ON "employees"("email");

-- CreateIndex (query performance)
CREATE INDEX "employees_country_idx"    ON "employees"("country");
CREATE INDEX "employees_department_idx" ON "employees"("department");
CREATE INDEX "employees_jobTitle_idx"   ON "employees"("jobTitle");
CREATE INDEX "employees_managerId_idx"  ON "employees"("managerId");

-- Composite index — most frequent history query: all changes for an employee ordered by date
CREATE INDEX "salary_history_employeeId_effectiveDate_idx"
    ON "salary_history"("employeeId", "effectiveDate");

-- AddForeignKey
ALTER TABLE "employees"
    ADD CONSTRAINT "employees_managerId_fkey"
    FOREIGN KEY ("managerId") REFERENCES "employees"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "salary_history"
    ADD CONSTRAINT "salary_history_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "employees"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "salary_history"
    ADD CONSTRAINT "salary_history_changedById_fkey"
    FOREIGN KEY ("changedById") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
