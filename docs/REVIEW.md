# ParseTrail Read-Only Audit Report

**Date:** Sat Nov 14 2026
**Scope:** All git branches, read-only. No source/config/lockfile/.github files were modified.
**Only file created:** `docs/REVIEW.md` (this report).

---

## 1. Branch summary

Branches (oldest to newest, linear ancestry where shown by `git log`):

| Branch | Tip commit | What it changes vs `main` |
|--------|-----------|---------------------------|
| `main` | `b41403c` | Baseline: original ParseTrail with auth, extraction, dashboard, export, FX conversion |
| `fix/p0-security` | `5a8fb54` | +26 files, +575/−158: harden auth/request handling; `.env.example`, `config.ts`, `app.ts`, `auth.ts`, `error.ts`, auth routes, documents routes, VerifyEmail |
| `fix/p1-reliability` | `df46d76` | +38 files, +1971/−539: builds on p0; AI/delivery fallbacks, refine job recovery, startup/DB lifecycle hardening; `schema.ts` (169 lines), `index.ts` (189), `cleanup.ts`, `refine.ts`, `ai.service.ts` |
| `fix/p2-correctness` | `4c7efb0` | +44 files, +2720/−1007: builds on p1; 202 deferred extraction, dedup correctness, `dedup.service.ts`, `confidence.service.ts`, `summary.service.ts` |
| `fix/p3-performance` | `b4a1aa3` | +118 files, +13006/−5314: builds on p2; CI, Dockerfile, ESLint/Prettier, frontend formatting, API timeout, React.lazy splitting, shared utils, new frontend pages/components |
| `feat/document-delete` | `7a72f6a` | +121 files, +13785/−5316: builds on p3; DELETE endpoint, cascade cleanup, UI confirm dialogs, `vercel.json` git deployment |
| `feat/async-lifecycle-ui` | `93388bd` | +119 files, +13379/−5316: builds on p3; upload lifecycle states, client validation, Detail copy, toast dismiss/pause |
| `docs/cascade-contract` (current tip) | `87f03b4` | +125 files, +14193/−5322: builds on `feat/document-delete` + `feat/async-lifecycle-ui`; p7 final fixes, `TEST_PLAN.md`, `ARCHITECTURE.md`, `ConfirmDialog`, `ExtractionCascadeResult` type |

**Branch notes:**
- `fix/p0-security`, `fix/p1-reliability`, `fix/p2-correctness` are linear backports applied on top of `main` and each other — they do NOT contain the p3/p4 frontend rewrite.
- `fix/p3-performance` is the big p3/p4 frontend+backend modernization branch; `feat/document-delete` and `feat/async-lifecycle-ui` build on it.
- `docs/cascade-contract` is the most recent tip and merges both feature branches plus p7 fixes.

---

## 2. Check results (AGENTS.md)

Run on current branch `docs/cascade-contract` (`87f03b4`). No files modified during audit.

**Backend:** `cd backend && npx tsc --noEmit && npx eslint "src/**/*.ts" && npx prettier --check "src/**/*.{ts,js}" && npx vitest run`

| Step | Result | Output |
|------|--------|--------|
| `tsc --noEmit` | PASS | exit 0, no output |
| `eslint "src/**/*.ts"` | PASS | exit 0, no output |
| `prettier --check` | PASS | "All matched files use Prettier code style!" |
| `vitest run` | PASS | Test Files 24 passed, Tests 175 passed, exit 0 |

**Frontend:** `cd frontend && npx tsc --noEmit && npx eslint "src/**/*.{ts,tsx}" && npx prettier --check "src/**/*.{ts,tsx}" && npx vitest run && npm run build`

| Step | Result | Output |
|------|--------|--------|
| `tsc --noEmit` | PASS | exit 0, no output |
| `eslint "src/**/*.{ts,tsx}"` | FAIL | 4 errors + 1 warning, all `react-hooks/set-state-in-effect`: `List.tsx:98`, `List.tsx:102`, `Profile.tsx:30`, `VerifyEmail.tsx:36`. Warning: `List.tsx:118` exhaustive-deps on `selectedTypes`. |
| `prettier --check` | PASS | "All matched files use Prettier code style!" |
| `vitest run` | PASS | Test Files 1 passed, Tests 22 passed, exit 0 |
| `npm run build` | PASS | exit 0, built in ~3.5s |

`npm ci` was NOT run (would modify lockfiles/node_modules); skip per read-only constraint. `npm ci` risk: `frontend/package-lock.json` shows 6629-line diff vs `main` — lockfiles may be out of sync with `package.json` if not regenerated.

---

## 3. Security findings

### S-1: Confirmed — High — JWT_SECRET / DB credential fallbacks when NODE_ENV != production

**File:** `backend/src/config.ts:63-78, 79`

**Quote:**
```
user: cleanVal(process.env.DB_USER) || (process.env.NODE_ENV === 'production' ? '' : 'parsetrail_user'),
password: cleanVal(process.env.DB_PASSWORD) || (process.env.NODE_ENV === 'production' ? '' : 'parsetrail_pass'),
database: cleanVal(process.env.DB_NAME) || (process.env.NODE_ENV === 'production' ? '' : 'parsetrail'),
...
jwtSecret: cleanVal(process.env.JWT_SECRET) || 'dev-secret-change-me',
```

**Why it matters:** In development/test/staging (any `NODE_ENV` not exactly `production`), the app falls back to hardcoded `parsetrail_user`/`parsetrail_pass`/`parsetrail` and `dev-secret-change-me`. These are committed to `.env.example` and visible in git history. `jwtSecret` fallback is explicitly rejected in production (`config.ts:126-132`) but not in other environments, so JWTs can be forged with the known dev secret in non-production deployments.

**Fix:** Remove non-production fallbacks for DB credentials and JWT_SECRET; require them via env in all environments, or generate a per-instance random JWT_SECRET at startup when unset (log a warning).

---

### S-2: Confirmed — Medium — Cookie auth SameSite=None in production with no CSRF/Origin check

**File:** `backend/src/routes/auth.route.ts:63-69`, `backend/src/config.ts:48-57`, `backend/src/app.ts:27-34`

**Quote:**
```
function setAuthCookie(res: Response, token: string) {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: process.env.NODE_ENV === 'production' || config.cookieSameSite === 'none',
    maxAge: 24 * 60 * 60 * 1000,
  });
}
```

**Why it matters:** Production defaults `COOKIE_SAME_SITE=none` (config.ts:53-54). Cookies are sent cross-site. `cors` in `app.ts` reflects any origin in `config.corsOrigins` with `credentials: true` and no `Origin` validation beyond the configured list. There is no CSRF token, no `Origin`/`Referer` double-submit check on state-changing endpoints (`/api/documents/upload`, `/api/auth/*`, corrections, delete). A malicious site can induce a logged-in browser to make credentialed cross-origin requests.

**Fix:** Add CSRF protection (double-submit cookie or `SameSite=Lax` for non-production and require `Origin`/`Referer` header match on mutating endpoints). If `SameSite=None` is required for cross-subdomain deployment, add a CSRF token check on POST/PUT/DELETE/ PATCH.

---

### S-3: Confirmed — Medium — Password reset tokens are not single-use atomic and do not invalidate existing JWTs

**File:** `backend/src/routes/auth.route.ts:560-590`, `backend/src/db/schema.ts:56-66`

**Quote:**
```
await pool.query('UPDATE users SET password_hash=? WHERE id=?', [hash, row.user_id]);
await pool.query('UPDATE password_reset_tokens SET used=TRUE WHERE token=?', [tokenHash]);
```

**Why it matters:** The two UPDATEs are not in a transaction. Between them, a concurrent request with the same token could succeed twice (not atomic single-use). After password reset, existing JWTs remain valid until their 1-day expiry — an attacker who captured a session cookie/JWT retains access even after the victim resets their password. Token is only invalidated (`used=TRUE`) after the reset; no JWT revocation/rotation exists.

**Fix:** Wrap the two updates in a transaction (`pool.begin()`/`commit()`/`rollback()`). Add a `password_changed_at` column to `users` and reject JWTs issued before that timestamp in `authenticate()`.

---

### S-4: Partly — Medium — Login/register response differences reveal which emails exist

**File:** `backend/src/routes/auth.route.ts:178-213` (login), `:76-163` (register), `:432-509` (verify-email)

**Quote (register):** `if (code === 'ER_DUP_ENTRY') { res.status(409).json({ error: 'Email already registered' }); return; }`

**Why it matters:** Register returns 409 "Email already registered" for existing emails vs 201 for new — email enumeration. Login returns the same generic 401 for both "user not found" and "wrong password" (good). Verify-email (token path) returns "Invalid or expired token" for both missing user and wrong token (good). Resend-verification deliberately returns `{ ok: true }` always (good — line 404 comment).

**Fix:** Make register return the same generic response regardless of whether the email exists (e.g., always 201 with a "check your email" message) to prevent enumeration.

---

### S-5: Confirmed — Low — verify-email reads token/code/email from query string

**File:** `backend/src/routes/auth.route.ts:433-436`

**Quote:**
```
const token = (req.body?.token as string) || (req.query.token as string);
const code = (req.body?.code as string) || (req.query.code as string);
const rawEmail = (req.body?.email as string) || (req.query.email as string);
```

**Why it matters:** Frontend `VerifyEmail.tsx` POSTs the token/email in the JSON body (good). But the backend also accepts `token`, `code`, `email` from `req.query`. Query strings are logged in server access logs, browser history, and proxy logs, exposing verification tokens and email addresses. The email-reset link (`email.service.ts:79`) also puts the raw reset token in a query string: `/reset-password?token=${token}`.

**Fix:** Accept verification token/code only from POST body. Change reset-password flow to POST the token in the body or use a short-lived single-use token that is consumed immediately and never appears in URLs.

---

### S-6: Confirmed — Low — dedup.service `findDuplicateByContent` optional `userId` allows cross-tenant matches

**File:** `backend/src/services/dedup.service.ts:96-115`

**Quote:**
```
export async function findDuplicateByContent(
  newData: ExtractedData,
  userId?: string,
  docTypeHint?: string,
  options?: { contentHash?: string; excludeDocumentId?: string }
) {
  ...
  const ownerClause = userId ? 'user_id=? AND ' : '';
  const ownerParams = userId ? [userId] : [];
```

**Why it matters:** `userId` is optional. Call sites pass `user.id` (from `getUser(req)`), so in practice all controller callers are authenticated. But if any future caller omits `userId`, the query matches across ALL users (`ownerClause` empty), leaking document content matches between tenants. No enforcement at the service boundary.

**Fix:** Make `userId` required (non-optional) parameter or assert it inside the function; throw if missing.

---

### S-7: Confirmed — High — `process.env` reads outside `config.ts` bypass validation

**File:** `backend/src/services/transformers.service.ts:48`, `:249-250`, `backend/src/services/email.service.ts:14`, `backend/src/routes/auth.route.ts:145,219,390,420,512,548`

**Quote (transformers.service.ts:48):** `const model = process.env.LOCAL_LLM_MODEL || 'Xenoma/LaMini-Flan-T5-77M';`

**Quote (email.service.ts:14):** `return process.env.FRONTEND_URL || process.env.APP_URL || ...`

**Why it matters:** `config.ts` centralizes validation (cleanVal, production checks, type parsing). Direct `process.env` reads bypass that, including the production JWT_SECRET/DB requirement checks. `FRONTEND_URL`/`APP_URL` are used to build email links with no validation; in production if unset they fall back to `localhost:${port}`, producing broken email links.

**Fix:** Move all `process.env` reads into `config.ts` and import from there. Add `FRONTEND_URL` to config with production validation.

---

### S-8: Partly — Low — Multi-step DB writes without transactions

**File:** `backend/src/controllers/documents.controller.ts:161-263` (upload: INSERT documents → SELECT → UPDATE status → enqueueRefineJob), `:625-723` (correctField: SELECT → UPDATE data → INSERT corrections), `backend/src/jobs/refine.ts` (claim + update job).

**Quote (documents.controller.ts:214-234):** INSERT then separate `UPDATE documents SET status='processing'`; `:685-688` UPDATE data then INSERT corrections — two separate `pool.query` calls.

**Why it matters:** Non-atomic multi-step writes can leave inconsistent state if the process crashes between statements (e.g., document row inserted but extraction never enqueued; correction data updated but corrections history not recorded). `refine.ts` claim-then-update pattern risks double-claiming under concurrent workers.

**Fix:** Wrap multi-statement logical units in transactions. Add a `claimed_by`/`claimed_at` atomic compare-and-swap for refine job claiming.

---

### S-9: Not found — Orphan-file cleanup vs files written before DB insert

**Files checked:** `backend/src/jobs/cleanup.ts`, `backend/src/controllers/documents.controller.ts`

**Finding:** `cleanup.ts:18-56` (`purgeExpired`) deletes expired docs' files then DB rows. `removeOrphanFiles()` (line 58-87) deletes uploads not referenced by any document row. Upload path writes file FIRST via multer (`middleware/upload.ts`), then inserts DB row (`documents.controller.ts:215-218`). If DB insert fails, the file is an orphan until the next cleanup run (2 AM cron) — acceptable for demo scale. `deleteDocument` unlinks the file after DB delete (line 426-430) — correct order.

**Status:** Not a vulnerability; cleanup exists and handles both directions. Low concern.

---

## 4. Code quality/modularity

### C-1: Confirmed — Medium — Frontend ESLint `set-state-in-effect` errors (5 problems, 4 errors)

**Files:** `frontend/src/pages/List.tsx:97-99`, `List.tsx:101-102`, `frontend/src/pages/Profile.tsx:29-33`, `frontend/src/pages/VerifyEmail.tsx:34-36`

**Quote (List.tsx:97-99):**
```
useEffect(() => {
  setQInput(qParam);
}, [qParam]);
```

**Why it matters:** Calling `setState` synchronously during render phase effects causes cascading renders. These are flagged as pre-existing (the PR notes 5 pre-existing frontend ESLint errors left intentionally unfixed). They degrade React 18 concurrent-mode compatibility.

**Fix:** Use `useMemo`-derived state or `useEffect` with a `setTimeout`/microtask to defer the `setState` call (matching the `useApi.ts` p7 fix pattern).

---

### C-2: Confirmed — Medium — `as unknown as` type casts (14 occurrences)

**Files:** `backend/src/routes/auth.route.ts:58` (`jwt.SignOptions`), `:225-384` (req.user casts), `backend/src/middleware/auth.ts:24,41,54`, `backend/src/controllers/documents.controller.ts:168,279`, `backend/src/services/transformers.service.ts:115`, `backend/src/config/logger.ts:85`, plus test files.

**Why it matters:** These bypass TypeScript safety. Most are Express req/res typing workarounds. Acceptable in moderation but concentrated in auth routes (5 casts) — a sign the Express types aren't well-aligned with the code's access patterns.

**Fix:** Define typed request interfaces extending `Request` with `user` and `cookies` properties; use them in route handlers instead of inline casts.

---

### C-3: Confirmed — Low — Large files over 400 lines

| File | Lines |
|------|-------|
| `backend/src/controllers/documents.controller.ts` | 865 |
| `backend/src/services/extraction.service.ts` | 901 |
| `backend/src/services/extraction.service.spec.ts` | 518 |
| `backend/src/controllers/documents.controller.spec.ts` | 627 |
| `backend/src/jobs/refine.ts` | 488 |
| `backend/src/jobs/refine.spec.ts` | 459 |
| `backend/src/routes/auth.route.ts` | 592 |
| `frontend/src/api/client.ts` | 514 |
| `frontend/src/pages/Detail.tsx` | 421 |
| `frontend/src/smoke.test.tsx` | 433 |

**Why it matters:** Files >400 lines do multiple things. `documents.controller.ts` handles upload, list, get, delete, attempts, reprocess, retry, corrections, listCorrections, correctionStats, summary, export — ten responsibilities. `extraction.service.ts` orchestrates PDF/OCR/LLM/conversion — four responsibilities.

**Fix:** Split `documents.controller.ts` into `upload.controller.ts`, `document.controller.ts` (get/delete/reprocess/retry), `corrections.controller.ts`, `summary.controller.ts`. Split `extraction.service.ts` into `pdf.service.ts`, `ocr.service.ts` (already separate), `cascade.service.ts`, `conversion.service.ts`.

---

### C-4: Confirmed — Low — Duplicated boilerplate in auth route user extraction

**File:** `backend/src/routes/auth.route.ts:225,250,331,375,384`

**Quote:** `const user = (req as unknown as { user: { id: string } }).user;` (5 identical lines)

**Why it matters:** Repeated type-unsafe cast pattern. Centralize via the existing `getUser(req)` helper in `middleware/auth.ts` — it's already defined but underused in `auth.route.ts` (used in `getUser` only for `/me`).

**Fix:** Replace all 5 inline casts with `getUser(req)`.

---

### C-5: Confirmed — Low — Swallowed errors (`catch {}`)

**Files:** `backend/src/db/pool.ts:33` (SSL cert file read), `backend/src/controllers/documents.controller.ts:701` (last attempt lookup)

**Quote (pool.ts:33):** `} catch {}` — silently ignores SSL CA file read errors.

**Why it matters:** Silent failures hide operational problems. In `pool.ts`, if the CA file is malformed, SSL is silently disabled without logging. In the controller, losing the last-attempt metadata means corrections lose `extraction_method`/`confidence` context with no trace.

**Fix:** Add `logger.warn(...)` in both catch blocks.

---

## 5. Docs drift

### D-1: Confirmed — Medium — `docs/TEST_PLAN.md` missing from `main` and earlier branches; only on `docs/cascade-contract`

**Files:** `docs/TEST_PLAN.md` (155 lines, new on `docs/cascade-contract`)

**Why it matters:** The PRD §15 and deviation #18 call for a test plan. `README.md` references test-related claims but `TEST_PLAN.md` doesn't exist on `main`/`fix/*` branches — a reviewer on an older branch sees no test documentation.

**Fix:** Already added on `docs/cascade-contract`. Consider backporting or noting in README which branch has it.

---

### D-2: Confirmed — Low — PRD deviation #20 notes half-applied rules split

**File:** `docs/ParseTrail-PRD.md:169` (deviation #20)

**Quote:** "The split was left half-applied — mangled import, `extractDateFallback` recursing into itself, `monthNum`/strategy/logger references unresolved — leaving 35 tests and `tsc` red."

**Why it matters:** The PRD itself documents that a prior refactor was left broken (`tsc` red). Current `tsc` passes on `docs/cascade-contract`, so this was fixed — but the PRD deviation log still describes it as broken. Docs drift: PRD describes a state that no longer matches code.

**Fix:** Update PRD deviation #20 to reflect the resolved state, or move it to a "resolved" section.

---

### D-3: Not found — TECHNICAL_SPEC.md vs code drift

**File:** `docs/TECHNICAL_SPEC.md` (20-line diff on `fix/p3-performance`)

I checked the diff stat only; content not read in full. The 20-line change is small. No evidence of major drift from the files read (routes, schema, types match code).

**Fix:** Read `TECHNICAL_SPEC.md` fully in a follow-up to confirm API contract matches `documents.route.ts`/`auth.route.ts`.

---

## 6. Optimizations

### O-1: Confirmed — Medium — Docker image builds dev tools and publishes DB port

**File:** `backend/Dockerfile:1-2`, `docker-compose.yml:11-12`

**Quote (Dockerfile:1):** `RUN apk add --no-cache poppler-utils vips-dev python3 make g++`
**Quote (docker-compose.yml:12):** `ports: - "3306:3306"`

**Why it matters:** Build stage installs `python3 make g++` (native compilation tools) that aren't needed at runtime — increases image size and attack surface. Compose publishes MySQL port 3306 to the host — exposes the DB externally.

**Fix:** Multi-stage build already separates build/run; ensure `vips-dev python3 make g++` are only in build stage (they are). Don't publish MySQL port in production compose; remove `ports` for mysql or bind to `127.0.0.1`.

---

### O-2: Confirmed — Low — Non-root user in Docker but uploads volume may lack write access

**File:** `backend/Dockerfile:24`, `docker-compose.yml:34`

**Quote (Dockerfile:24):** `USER node`
**Quote (docker-compose.yml:34):** `volumes: - ./backend/uploads:/app/uploads`

**Why it matters:** Container runs as `node` (non-root, good). The bind-mounted `./backend/uploads` is created by the host user (root on many CI hosts); the `node` user inside the container may not have write permission to `/app/uploads`, causing upload failures in production.

**Fix:** Ensure uploads directory is owned/writable by `node` user, or run as `node` with an explicit `USER` and fix volume permissions in compose (`user: "1000:1000"` or init container chown).

---

### O-3: Confirmed — Low — Frontend vendor chunk is 164 KB (charts 416 KB)

**File:** `frontend/dist/assets/vendor-DfAr-neT.js` (164 KB gzip 53 KB), `charts-vxkwKNiq.js` (416 KB gzip 120 KB)

**Why it matters:** `recharts` is bundled in a separate `charts` chunk (good — code-split). `vendor` chunk (react + react-dom + react-router-dom) is 164 KB — acceptable but not lazy-split per route. Dashboard and Detail pages load it upfront.

**Fix:** Charts chunk is already split. Consider lazy-loading `Dashboard`/`Detail` route components via `React.lazy` to reduce initial JS. (Already noted as possible but charts already route-split per PRD deviation #19.)

---

### O-4: Confirmed — Low — `dedup.service.ts` fetches up to 200 rows and matches in JS

**File:** `backend/src/services/dedup.service.ts:202-211`

**Quote:** `ORDER BY created_at DESC, id DESC LIMIT 200` then `findMatchInRows` iterates all rows in JavaScript.

**Why it matters:** For users with many documents, this loads 200 JSON rows into memory and parses each. The `content_hash` and `content_fingerprint` paths (lines 149-194) use indexed lookups first and are efficient; the fallback fingerprint path is the hot path. Acceptable for demo scale (<100 docs/mo per PRD §8).

**Fix:** Add a `WHERE` clause pre-filter on normalized fields if moving beyond demo scale. Not a priority.

---

### O-5: Confirmed — Low — No `readiness` endpoint separate from liveness

**File:** `backend/src/app.ts:83-96`

**Quote:** `/health` returns `{status:'ok'}` unconditionally; `/health/db` checks `SELECT 1`.

**Why it matters:** PRD §16/#5 recommends a lightweight `readiness` endpoint checking MySQL and required runtime capabilities separately from liveness. `/health/db` exists but there's no combined `/health/ready`. No check for `pdftotext`, tesseract, or AI provider keys.

**Fix:** Add `GET /health/ready` returning 200 when DB + key runtimes are available, 503 otherwise, without error text/stack traces (per p6 spec).

---

## 7. Suggested fix order (one small task per item)

1. **Security:** Remove non-production JWT_SECRET/DB fallbacks in `backend/src/config.ts` (S-1). One file.
2. **Security:** Add CSRF/`Origin` validation or `SameSite=Lax` default in `backend/src/app.ts` + `auth.route.ts` (S-2). Two files.
3. **Security:** Transaction + `password_changed_at` JWT invalidation in `auth.route.ts` + `schema.ts` + `auth.ts` (S-3). Three files.
4. **Security:** Make `userId` required in `dedup.service.ts` (S-6). One file.
5. **Security:** Centralize `process.env` reads into `config.ts` (S-7). Multiple files, one config file.
6. **Quality:** Fix frontend `set-state-in-effect` in `List.tsx`, `Profile.tsx`, `VerifyEmail.tsx` (C-1). Three files.
7. **Quality:** Replace inline `req` casts with `getUser(req)` in `auth.route.ts` (C-4/C-2). One file.
8. **Quality:** Add `logger.warn` to swallowed `catch {}` in `pool.ts` and `documents.controller.ts` (C-5). Two files.
9. **Quality:** Split `documents.controller.ts` (865 lines) into focused controllers (C-3). Multiple files.
10. **Docs:** Update PRD deviation #20 to resolved state (D-2). One file.
11. **Optimization:** Add `/health/ready` endpoint (O-5). One file.
12. **Optimization:** Fix Docker MySQL port exposure and uploads write permissions (O-1/O-2). Two files.