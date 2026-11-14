# ParseTrail agent rules
Stack: backend = Express 5 + TypeScript ESM + mysql2 (no ORM); frontend = React 18 + Vite + SCSS modules + Vitest.

Rules
- Work on ONE task per session. Do not start other improvements you notice; list them at the end instead.
- Read a file before editing it. Edit small hunks with the edit tool. Never rewrite a whole file.
- Do not change API response shapes, env var names, DB column names or existing test expectations unless the task says so.
- Use single quotes, semicolons, 2-space indent (Prettier config is in each package).
- Never invent data fields, endpoints or functions. If something the task refers to does not exist, say so and stop.
- Every behavior change needs a test in the matching *.spec.ts / smoke.test.tsx.
- Do not push, do not touch .github/, package.json or lockfiles unless the task says so.

Checks (run all, paste the real output, fix failures before saying done)
- Backend: cd backend && npx tsc --noEmit && npx eslint "src/**/*.ts" && npx prettier --check "src/**/*.{ts,js}" && npx vitest run
- Frontend: cd frontend && npx tsc --noEmit && npx eslint "src/**/*.{ts,tsx}" && npx prettier --check "src/**/*.{ts,tsx}" && npx vitest run && npm run build

Final report format (always)
1. Files changed  2. Tests added  3. Check commands + pass/fail  4. Anything skipped or uncertain  5. Ideas noticed but NOT done
