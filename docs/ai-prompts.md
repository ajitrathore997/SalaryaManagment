# AI Development Prompt Log

This document records the prompts used to guide AI-assisted development of the Salary Management application. Entries are added as each phase is completed, providing a traceable history of how the codebase was built.

---

## How to use this log

After each significant AI-assisted session, add an entry with:

- **Phase** — the feature or milestone being built
- **Date** — when the session took place
- **Prompt summary** — a condensed version of the instruction given to the AI
- **Outcome** — files created or changed, and any notable decisions made

---

## Entries

### Phase 0 — Project Foundation

**Date:** September 2026

**Prompt summary:**
> Build the initial project foundation for a salary management assessment application. Monorepo with Node.js + TypeScript + Express backend, React + Vite + TypeScript frontend, Material UI, PostgreSQL + Prisma, Zod validation, Vitest + Supertest, ESLint + Prettier. Include a health endpoint, a minimal dashboard page, .env.example files, a README, and docs (requirements, design notes, this prompt log). Do not implement authentication, employee APIs, business models, or seed data yet.

**Outcome:**
- Monorepo root with npm workspaces configured
- `backend/` — Express app, Prisma schema skeleton, Zod-validated env config, health endpoint (`GET /api/health`), error handler, Vitest + Supertest setup, ESLint + Prettier
- `frontend/` — Vite + React SPA, MUI theme, responsive AppLayout with sidebar, Dashboard page that calls the health endpoint, React Router, ESLint + Prettier
- `docs/requirements.md`, `docs/design-notes.md`, `docs/ai-prompts.md` (this file)
- `README.md` with full install and run instructions

---

_Subsequent phases will be recorded here as development continues._
