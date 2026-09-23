# Salary Management

A salary data management and pay insights platform for HR Managers, supporting organisations with up to 10,000 employees across multiple countries.

---

## Project structure

```
salary-management/
├── backend/          # Node.js + TypeScript + Express API
│   ├── prisma/       # Prisma schema & future migrations
│   ├── src/          # Application source
│   └── tests/        # Vitest + Supertest tests
├── frontend/         # React + Vite + TypeScript SPA
│   └── src/          # Application source
└── docs/             # Requirements, design notes, AI prompts
```

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Node.js | 18.x |
| npm | 9.x (ships with Node 18) |
| PostgreSQL | 14.x |

---

## First-time setup

### 1. Install dependencies

From the **repository root**, run:

```bash
npm install
```

npm workspaces will install dependencies for both `backend` and `frontend` in one step.

### 2. Configure environment variables

Copy the example files and fill in your values:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Edit `backend/.env` — at minimum set:

```
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/salary_management
JWT_SECRET=<a random string of at least 32 characters>
```

### 3. Generate the Prisma client

```bash
cd backend
npm run db:generate
```

### 4. Run database migrations

```bash
npm run db:migrate --workspace=backend
```

### 5. Seed the database

Populates the database with 10,000 deterministic employees and one HR Manager account for development and assessment use.

```bash
npm run db:seed --workspace=backend
```

The seed is **idempotent** — safe to run multiple times. It always produces the same logical dataset.

> ⚠️ **Assessment demo credentials** — for local development only. Never use in production.
>
> | Field    | Value                        |
> |----------|------------------------------|
> | Email    | `hr.manager@salaryapp.dev`   |
> | Password | `HRdemo2026!`                |
> | Role     | `HR_MANAGER`                 |

---

## Development

Run backend and frontend concurrently from the repo root:

```bash
# Backend only
npm run dev --workspace=backend

# Frontend only
npm run dev --workspace=frontend
```

| Service | URL |
|---------|-----|
| Frontend (Vite) | http://localhost:5173 |
| Backend (Express) | http://localhost:4000 |
| Health endpoint | http://localhost:4000/api/health |

> The frontend Vite dev server proxies `/api/*` requests to the backend automatically, so no CORS configuration is needed during local development.

---

## Build

```bash
# Build both packages
npm run build

# Build individually
npm run build --workspace=backend   # outputs to backend/dist/
npm run build --workspace=frontend  # outputs to frontend/dist/
```

---

## Tests

```bash
# Run all backend tests (single pass)
npm run test

# Watch mode
npm run test:watch --workspace=backend

# With coverage report
npm run test:coverage --workspace=backend
```

---

## Linting & formatting

```bash
# Lint both packages
npm run lint

# Auto-fix lint issues
npm run lint:fix --workspace=backend
npm run lint:fix --workspace=frontend

# Format source files
npm run format

# Check formatting without writing
npm run format:check --workspace=backend
npm run format:check --workspace=frontend
```

---

## Database tooling

```bash
# Run migrations
npm run db:migrate --workspace=backend

# Seed database (10,000 employees + HR Manager demo account)
npm run db:seed --workspace=backend

# Open Prisma Studio (visual DB browser)
npm run db:studio --workspace=backend
```

---

## Docs

| Document | Description |
|----------|-------------|
| [`docs/requirements.md`](docs/requirements.md) | One-page product requirements |
| [`docs/design-notes.md`](docs/design-notes.md) | Architecture and design decisions |
| [`docs/ai-prompts.md`](docs/ai-prompts.md) | AI development prompt log |
