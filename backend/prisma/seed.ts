/**
 * Deterministic, idempotent seed for the Salary Management application.
 *
 * Produces:
 *   - 1 HR Manager user account
 *   - 10,000 employees with realistic distributions
 *   - 10,000 SalaryHistory rows (one initial-hire entry per employee)
 *
 * Idempotency: truncates employees + salary_history (FK-safe order), then
 * upserts the HR Manager, bulk-inserts all employees (managerId = null),
 * bulk-updates managers in a second pass, then bulk-inserts history.
 *
 * PRNG: mulberry32 — a fast, high-quality 32-bit PRNG seeded with a fixed
 * integer.  No external dependency; produces identical sequences on every run.
 */

import { PrismaClient, EmploymentType, Gender } from '@prisma/client';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

// ─── PRNG ────────────────────────────────────────────────────────────────────

/**
 * mulberry32 — deterministic pseudo-random number generator.
 * Returns a callable that yields floats in [0, 1).
 * Seed is a fixed uint32 — never change it or the dataset changes.
 */
function createPrng(seed: number): () => number {
  let s = seed >>> 0;
  return function rand(): number {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0xdeadbeef; // fixed — never change; determines the entire dataset
const rand = createPrng(SEED);

function randInt(n: number): number {
  return Math.floor(rand() * n);
}

function weightedPick<T>(choices: { value: T; weight: number }[]): T {
  const total = choices.reduce((s, c) => s + c.weight, 0);
  let r = rand() * total;
  for (const choice of choices) {
    r -= choice.weight;
    if (r <= 0) return choice.value;
  }
  return choices[choices.length - 1].value;
}

function pick<T>(arr: T[]): T {
  return arr[randInt(arr.length)];
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const TOTAL_EMPLOYEES = 10_000;
const BATCH_SIZE = 500;

const HR_MANAGER_EMAIL = 'hr.manager@salaryapp.dev';
const HR_MANAGER_PASSWORD = 'HRdemo2026!';
const HR_MANAGER_BCRYPT_ROUNDS = 12;

// ── Countries, currencies, salary bands ──────────────────────────────────────

interface CountryConfig {
  name: string;
  currency: string;
  salaryBand: [number, number];
  levelMultiplier: number;
  weight: number;
}

const COUNTRIES: CountryConfig[] = [
  { name: 'United States',  currency: 'USD', salaryBand: [65_000,  180_000],     levelMultiplier: 0.22, weight: 28 },
  { name: 'United Kingdom', currency: 'GBP', salaryBand: [40_000,  110_000],     levelMultiplier: 0.20, weight: 12 },
  { name: 'Germany',        currency: 'EUR', salaryBand: [45_000,  110_000],     levelMultiplier: 0.18, weight: 10 },
  { name: 'France',         currency: 'EUR', salaryBand: [38_000,   95_000],     levelMultiplier: 0.17, weight:  7 },
  { name: 'Canada',         currency: 'CAD', salaryBand: [60_000,  150_000],     levelMultiplier: 0.20, weight:  7 },
  { name: 'Australia',      currency: 'AUD', salaryBand: [65_000,  155_000],     levelMultiplier: 0.19, weight:  6 },
  { name: 'India',          currency: 'INR', salaryBand: [800_000, 3_500_000],   levelMultiplier: 0.25, weight: 12 },
  { name: 'Singapore',      currency: 'SGD', salaryBand: [55_000,  160_000],     levelMultiplier: 0.22, weight:  4 },
  { name: 'Netherlands',    currency: 'EUR', salaryBand: [42_000,  105_000],     levelMultiplier: 0.18, weight:  4 },
  { name: 'Brazil',         currency: 'BRL', salaryBand: [60_000,  280_000],     levelMultiplier: 0.22, weight:  4 },
  { name: 'Mexico',         currency: 'MXN', salaryBand: [180_000, 900_000],     levelMultiplier: 0.22, weight:  3 },
  { name: 'Japan',          currency: 'JPY', salaryBand: [4_000_000, 12_000_000],levelMultiplier: 0.20, weight:  3 },
];

// ── Departments ───────────────────────────────────────────────────────────────

interface DepartmentConfig {
  name: string;
  weight: number;
  roles: string[];
}

const DEPARTMENTS: DepartmentConfig[] = [
  { name: 'Engineering',       weight: 22, roles: ['Software Engineer','Backend Engineer','Frontend Engineer','Platform Engineer','Data Engineer','Site Reliability Engineer','QA Engineer','Security Engineer'] },
  { name: 'Product',           weight: 10, roles: ['Product Manager','Senior Product Manager','Principal Product Manager','Product Analyst'] },
  { name: 'Design',            weight:  6, roles: ['UX Designer','Product Designer','Visual Designer','Design Lead'] },
  { name: 'Data & Analytics',  weight:  9, roles: ['Data Analyst','Data Scientist','Analytics Engineer','BI Developer','ML Engineer'] },
  { name: 'Finance',           weight:  8, roles: ['Financial Analyst','FP&A Analyst','Controller','Accountant','Treasury Analyst'] },
  { name: 'Human Resources',   weight:  6, roles: ['HR Business Partner','Talent Acquisition Specialist','Compensation Analyst','L&D Specialist','HR Operations Analyst'] },
  { name: 'Sales',             weight: 10, roles: ['Account Executive','Sales Development Rep','Enterprise Account Manager','Solutions Engineer','Sales Operations Analyst'] },
  { name: 'Marketing',         weight:  7, roles: ['Marketing Manager','Content Strategist','Growth Marketing Manager','Brand Designer','Demand Generation Manager'] },
  { name: 'Operations',        weight:  8, roles: ['Operations Manager','Business Operations Analyst','Program Manager','Supply Chain Analyst','Process Improvement Lead'] },
  { name: 'Customer Success',  weight:  7, roles: ['Customer Success Manager','Implementation Specialist','Support Engineer','Onboarding Specialist','Technical Account Manager'] },
  { name: 'Legal & Compliance',weight:  4, roles: ['Legal Counsel','Compliance Analyst','Privacy Manager','Contract Manager'] },
  { name: 'IT & Infrastructure',weight: 3, roles: ['IT Manager','Systems Administrator','Network Engineer','Help Desk Analyst'] },
];

// ── Levels ────────────────────────────────────────────────────────────────────

interface LevelConfig {
  name: string;
  levelIndex: number;
  weight: number;
  canManage: boolean;
}

const LEVELS: LevelConfig[] = [
  { name: 'L1 — Junior',    levelIndex: 0, weight: 12, canManage: false },
  { name: 'L2 — Associate', levelIndex: 1, weight: 20, canManage: false },
  { name: 'L3 — Mid',       levelIndex: 2, weight: 28, canManage: false },
  { name: 'L4 — Senior',    levelIndex: 3, weight: 22, canManage: true  },
  { name: 'L5 — Staff',     levelIndex: 4, weight: 12, canManage: true  },
  { name: 'L6 — Principal', levelIndex: 5, weight:  6, canManage: true  },
];

const EMPLOYMENT_TYPES: { value: EmploymentType; weight: number }[] = [
  { value: EmploymentType.FULL_TIME, weight: 78 },
  { value: EmploymentType.PART_TIME, weight:  8 },
  { value: EmploymentType.CONTRACT,  weight: 10 },
  { value: EmploymentType.INTERN,    weight:  4 },
];

const GENDERS: { value: Gender; weight: number }[] = [
  { value: Gender.MALE,              weight: 48 },
  { value: Gender.FEMALE,            weight: 46 },
  { value: Gender.NON_BINARY,        weight:  4 },
  { value: Gender.PREFER_NOT_TO_SAY, weight:  2 },
];

const FIRST_NAMES = [
  'James','Maria','Wei','Priya','Carlos','Emma','Yuki','Fatima','Noah','Amara',
  'Liam','Sofia','Ahmed','Mei','Oliver','Zara','Ethan','Ana','Hiroshi','Aisha',
  'Lucas','Chloe','Raj','Sara','Mohammed','Ella','Daniel','Rin','David','Nina',
  'Michael','Isabella','John','Sakura','Robert','Ava','William','Mia','Thomas',
  'Charlotte','Alex','Laura','Chris','Natalie','Jordan','Hannah','Taylor','Elena',
  'Morgan','Grace','Casey','Leila','Quinn','Nadia','Blake','Riya','Cameron',
  'Ananya','Sven','Ingrid','Matteo','Giulia','Luca','Valentina','Hugo','Camille',
  'Kieran','Siobhan','Tariq','Yasmin','Kofi','Abena','Seun','Adaeze','Emre','Elif',
  'Andrei','Ioana','Marek','Zuzanna','Pavel','Katerina','Leon','Miriam','Niko',
  'Freya','Eitan','Dina','Ravi','Pooja','Arjun','Deepa','Vikram','Sunita',
];

const LAST_NAMES = [
  'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson',
  'Anderson','Taylor','Thomas','Jackson','White','Harris','Martin','Thompson',
  'Young','Lee','Walker','Hall','Allen','Wright','Scott','King','Chen','Wang',
  'Li','Zhang','Kumar','Singh','Sharma','Patel','Gupta','Kim','Park','Choi',
  'Tanaka','Suzuki','Sato','Nakamura','Yamamoto','Santos','Silva','Costa','Alves',
  'Müller','Schmidt','Fischer','Weber','Wagner','Dubois','Laurent','Dupont',
  'Bernard','Ali','Khan','Hassan','Nguyen','Tran','Pham','Okafor','Eze','Obi',
  'Mensah','Owusu','Asante','Kowalski','Nowak','Kovacs','Nagy','Popescu','Ionescu',
  'Petrov','Ivanov','Sokolov','Volkov','Murphy','Walsh','Sullivan','McCarthy',
  'Reyes','Flores','Hernandez','Morales','Johansson','Lindqvist','Eriksson',
  'Andersen','Nielsen','Hansen','OBrien','Nakagawa','Kobayashi','Watanabe',
];

const INITIAL_HIRE_REASONS = [
  'Initial hire',
  'New hire compensation',
  'Joining salary',
  'Offer acceptance',
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function randomHireDate(): Date {
  const start = new Date('2015-01-01').getTime();
  const end   = new Date('2026-06-30').getTime();
  return new Date(start + Math.floor(rand() * (end - start)));
}

function computeSalary(country: CountryConfig, levelIndex: number): number {
  const [min, max] = country.salaryBand;
  const mid        = (min + max) / 2;
  const levelDelta = levelIndex - 2; // L3 = baseline
  const scaled     = mid * (1 + levelDelta * country.levelMultiplier);
  const clamped    = Math.max(min * 0.8, Math.min(max * 1.5, scaled));
  const noise      = 0.85 + rand() * 0.30; // ±15%
  return Math.max(0, Math.round((clamped * noise) / 100) * 100);
}

function employeeEmail(firstName: string, lastName: string, index: number): string {
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName.toLowerCase().replace(/[^a-z]/g, '');
  return `${f}.${l}.${index + 1}@corp.salaryapp.dev`;
}

// ─── SEED ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.info('🌱 Starting seed...');

  // ── 1. Upsert HR Manager ──────────────────────────────────────────────────
  console.info('  Hashing HR Manager password (bcrypt rounds=12)...');
  const passwordHash = await bcrypt.hash(HR_MANAGER_PASSWORD, HR_MANAGER_BCRYPT_ROUNDS);

  const hrManager = await prisma.user.upsert({
    where:  { email: HR_MANAGER_EMAIL },
    update: { passwordHash, role: 'HR_MANAGER' },
    create: { email: HR_MANAGER_EMAIL, passwordHash, role: 'HR_MANAGER' },
  });
  console.info(`  ✔ HR Manager upserted — id: ${hrManager.id}`);

  // ── 2. Wipe existing employee data (idempotency) ──────────────────────────
  console.info('  Clearing existing data (history → employees)...');
  await prisma.salaryHistory.deleteMany({});
  await prisma.employee.deleteMany({});
  console.info('  ✔ Cleared');

  // ── 3. Generate employee records ──────────────────────────────────────────
  console.info(`  Generating ${TOTAL_EMPLOYEES.toLocaleString()} employee records...`);

  // Deterministic IDs allow us to pre-compute FK references offline
  const employeeIds = Array.from(
    { length: TOTAL_EMPLOYEES },
    (_, i) => `emp_seed_${String(i + 1).padStart(6, '0')}`,
  );

  // Track L4+ employee IDs for manager assignment
  const managerCandidateIds: string[] = [];

  interface EmployeeRow {
    id: string;
    name: string;
    email: string;
    country: string;
    department: string;
    jobTitle: string;
    level: string;
    hireDate: Date;
    employmentType: EmploymentType;
    gender: Gender;
    baseAnnualSalary: number;
    salaryCurrency: string;
    version: number;
    // managerId deliberately omitted for phase-1 insert
  }

  const employeeRows: EmployeeRow[] = [];

  for (let i = 0; i < TOTAL_EMPLOYEES; i++) {
    const country   = weightedPick(COUNTRIES.map((c) => ({ value: c, weight: c.weight })));
    const dept      = weightedPick(DEPARTMENTS.map((d) => ({ value: d, weight: d.weight })));
    const levelConf = weightedPick(LEVELS.map((l) => ({ value: l, weight: l.weight })));
    const empType   = weightedPick(EMPLOYMENT_TYPES);
    const gender    = weightedPick(GENDERS);
    const firstName = pick(FIRST_NAMES);
    const lastName  = pick(LAST_NAMES);

    if (levelConf.canManage) managerCandidateIds.push(employeeIds[i]);

    employeeRows.push({
      id:               employeeIds[i],
      name:             `${firstName} ${lastName}`,
      email:            employeeEmail(firstName, lastName, i),
      country:          country.name,
      department:       dept.name,
      jobTitle:         pick(dept.roles),
      level:            levelConf.name,
      hireDate:         randomHireDate(),
      employmentType:   empType,
      gender:           gender,
      baseAnnualSalary: computeSalary(country, levelConf.levelIndex),
      salaryCurrency:   country.currency,
      version:          1,
    });
  }

  // ── 4. Phase 1 — insert all employees WITHOUT managerId ───────────────────
  // managerId is a self-referential FK; inserting it in the same batch as the
  // referenced rows would cause FK violations. We insert with managerId = null
  // first, then update in a second pass once all rows exist.
  console.info('  [Phase 1] Inserting employees (managerId deferred)...');
  for (let offset = 0; offset < TOTAL_EMPLOYEES; offset += BATCH_SIZE) {
    const batch = employeeRows.slice(offset, offset + BATCH_SIZE);
    await prisma.employee.createMany({ data: batch });
    process.stdout.write(
      `\r    ${String(Math.min(offset + BATCH_SIZE, TOTAL_EMPLOYEES)).padStart(5)} / ${TOTAL_EMPLOYEES}`,
    );
  }
  console.info('\n  ✔ Phase 1 complete');

  // ── 5. Phase 2 — assign managers via SQL UPDATE batches ───────────────────
  // Build the manager assignment map deterministically (same PRNG state).
  // ~70% of employees get a manager drawn from the L4+ candidate pool.
  // Self-reference is prevented by checking candidateId !== employeeId.
  console.info('  [Phase 2] Assigning manager relationships...');

  const MANAGER_RATE = 0.70;

  // Collect (employeeId, managerId) pairs
  const managerUpdates: { id: string; managerId: string }[] = [];

  for (let i = 0; i < TOTAL_EMPLOYEES; i++) {
    if (managerCandidateIds.length === 0) break;
    if (rand() > MANAGER_RATE) continue;

    // Try up to 8 times to find a candidate that is not the employee itself
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidateId = pick(managerCandidateIds);
      if (candidateId !== employeeIds[i]) {
        managerUpdates.push({ id: employeeIds[i], managerId: candidateId });
        break;
      }
    }
  }

  // Apply updates in batches using Prisma's transaction
  for (let offset = 0; offset < managerUpdates.length; offset += BATCH_SIZE) {
    const batch = managerUpdates.slice(offset, offset + BATCH_SIZE);
    await prisma.$transaction(
      batch.map((u) =>
        prisma.employee.update({
          where: { id: u.id },
          data:  { managerId: u.managerId },
        }),
      ),
    );
    process.stdout.write(
      `\r    ${String(Math.min(offset + BATCH_SIZE, managerUpdates.length)).padStart(5)} / ${managerUpdates.length}`,
    );
  }
  console.info(`\n  ✔ Phase 2 complete — ${managerUpdates.length} manager relationships assigned`);

  // ── 6. Phase 3 — bulk insert salary history ───────────────────────────────
  console.info('  [Phase 3] Inserting salary history...');

  const historyRows = employeeRows.map((emp, i) => ({
    id:               `hist_seed_${String(i + 1).padStart(6, '0')}`,
    employeeId:       emp.id,
    previousSalary:   null,   // null = initial hire; no prior record exists
    previousCurrency: null,
    newSalary:        emp.baseAnnualSalary,
    newCurrency:      emp.salaryCurrency,
    effectiveDate:    emp.hireDate,
    reason:           pick(INITIAL_HIRE_REASONS),
    changedById:      hrManager.id,
  }));

  for (let offset = 0; offset < TOTAL_EMPLOYEES; offset += BATCH_SIZE) {
    const batch = historyRows.slice(offset, offset + BATCH_SIZE);
    await prisma.salaryHistory.createMany({ data: batch });
    process.stdout.write(
      `\r    ${String(Math.min(offset + BATCH_SIZE, TOTAL_EMPLOYEES)).padStart(5)} / ${TOTAL_EMPLOYEES}`,
    );
  }
  console.info('\n  ✔ Phase 3 complete');

  // ── 7. Verify & summarise ─────────────────────────────────────────────────
  const [empCount, histCount, userCount, managedCount] = await Promise.all([
    prisma.employee.count(),
    prisma.salaryHistory.count(),
    prisma.user.count(),
    prisma.employee.count({ where: { managerId: { not: null } } }),
  ]);

  const byCountry = await prisma.employee.groupBy({
    by: ['country'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 6,
  });

  const byDept = await prisma.employee.groupBy({
    by: ['department'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: 5,
  });

  console.info('\n─────────────────────────────────────────────────────');
  console.info('  ✅ Seed complete');
  console.info(`  Users            ${userCount}`);
  console.info(`  Employees        ${empCount}`);
  console.info(`  Salary records   ${histCount}`);
  console.info(`  With manager     ${managedCount} (${((managedCount / empCount) * 100).toFixed(1)}%)`);
  console.info('\n  Top countries:');
  for (const r of byCountry) console.info(`    ${r.country.padEnd(22)} ${r._count.id}`);
  console.info('\n  Top departments:');
  for (const r of byDept) console.info(`    ${r.department.padEnd(22)} ${r._count.id}`);
  console.info('\n─────────────────────────────────────────────────────');
  console.info('  Demo credentials (assessment only — not for production)');
  console.info(`    Email    ${HR_MANAGER_EMAIL}`);
  console.info(`    Password ${HR_MANAGER_PASSWORD}`);
  console.info('─────────────────────────────────────────────────────\n');
}

main()
  .catch((e) => { console.error('Seed failed:', e); process.exit(1); })
  .finally(() => void prisma.$disconnect());
