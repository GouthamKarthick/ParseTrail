# ClarityDocs — Technical Specification

> Derived from `ClarityDocs-PRD.md`. Covers API contract (Phase1 vs Phase2), DDL, folder structure, AWS resources, and phased checklist. Stack: `Node 20 + Express + TypeScript (ESM)` + `React + TypeScript + Vite SPA` + `MySQL (mysql2, no ORM)` + `pdf-parse` (Phase1, swappable) per PRD §8. Deploy deferred.
> **Update 2026-09-14 — Freelancing Finish:** `S3/SQS/Lambda` dropped (code in `backend/src/lambda/` `backend/infra/` deleted per user trade-off), MySQL cloud (`Clever Cloud`/`Railway` free) used for online deploy, `Render` ephemeral `UPLOAD_DIR=/tmp/uploads` accepted. See §10 Reasoning.

---

## 1. Overview & Conventions

**Philosophy:** Upload → Extract → View pipeline where Phase1 is synchronous (local-only extract inline) and Phase2 is asynchronous (DB-backed `refine_jobs` + in-process worker) with **identical frontend contract**. The earlier S3/SQS/Lambda design (§10, 2026-09-14 update) was dropped — no AWS code remains. Tiered extraction (§6 PRD: regex → local LLM → cloud LLM) is implemented in `extraction.service.ts` with per-type strategies.

**Module system:** Backend is ESM (`package.json "type":"module"`, `tsconfig "NodeNext"`).

**No ORM:** Plain `mysql2/promise` pool. Reason: PRD §8 explicitly says `plain mysql2` unless justified; keeps SQL visible for interviewers and avoids migration magic.

**Env:** `dotenv` + `.env.example`. Frontend `VITE_API_URL` points to `http://localhost:4000`.

---

## 2. API Contract

Base URL: `http://localhost:4000` (Phase1/2). All routes under `/api`. JSON responses. CORS open in dev (`cors()`), locked down later.

### 2.1 Common Types

```ts
type DocumentStatus = "pending" | "processing" | "done" | "failed";

interface Document {
  id: string; // UUID v4, server-generated via crypto.randomUUID() (~5.3e36 values, PK prevents dup)
  name: string; // as uploaded, e.g. "invoice-2024-01.pdf"
  path: string;   // local ./uploads/<uuid>-<name> (no cloud variant)
  status: DocumentStatus;
  data: ExtractedData | null;
  error: string | null;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

interface ExtractedData {
  vendor?: string;
  invoiceNumber?: string;
  invoiceDate?: string; // ISO date string
  totalAmount?: number;
  currency?: string;    // e.g. "INR", "USD" (source currency, immutable)
  totalAmountConverted?: number | null;  // FX display value (DISPLAY_CURRENCY)
  currencyConverted?: string | null;
  conversionRate?: number | null;
  conversionAt?: string | null;
  // per-type extras ride on the same JSON shape
}

interface ApiError {
  error: string;
  details?: unknown;
}
```

### 2.2 Endpoints

#### `GET /health`
- **Purpose:** Liveness probe.
- **Request:** none
- **Response 200:**
```json
{ "status": "ok" }
```

#### `POST /api/documents/upload`
- **Purpose:** PRD §7 MVP: store file + create `pending` record + trigger extraction.
- **Request:** `multipart/form-data`, field `file` (single).
  - Allowed mimes: `application/pdf`, `image/png`, `image/jpeg`
  - Max size: `10 MB` (configurable via `MAX_FILE_SIZE`)
  - Validation: `zod` + `multer` fileFilter
- **Phase1 behavior:** Server generates `id` via `crypto.randomUUID()` (v4, 122 random bits, collision <1e-25 at 1M docs; `PRIMARY KEY` guards duplicates — `ER_DUP_ENTRY` → retry), save to `UPLOAD_DIR` (`./uploads`), insert `documents` row `pending`, immediately set `processing`, call `extractionService.extract(filePath)` in-process, update `done` + `data` or `failed` + `error`.
- **Phase2 behavior (actual):** save to local `UPLOAD_DIR`, insert `pending`, run local-only extract (`allowCloud:false`), write `done`+`data` or `failed`+`error`. If the local result is incomplete or stages disagreed, insert a `refine_jobs` row (`status=queued`) and return. The in-process worker (`jobs/refine.ts`, `REFINE_POLL_MS=15s`) claims queued jobs, runs the cloud pass, null-fills `data`, and marks the job `done/retry/dead` under a rate bucket + daily cap. No S3/SQS/Lambda involved.
- **Response 201 (both phases):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "invoice.pdf",
  "status": "pending",
  "created_at": "2026-09-08T10:00:00.000Z"
}
```
- **Errors:**
  - `400` — no file / invalid mime / zod fail `{error:"Invalid file type. Allowed: pdf,png,jpg"}`
  - `413` — file too large
  - `500` — storage/DB/queue failure `{error:"Failed to process upload"}`

#### `GET /api/documents`
- **Purpose:** PRD §7 list view.
- **Query:** `?limit=20&offset=0` (defaults 20/0, max limit 100)
- **Response 200:**
```json
{
  "documents": [ Document ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```
- **Ordering:** `created_at DESC`
- **Errors:** `400` bad pagination, `500`

#### `GET /api/documents/:id`
- **Purpose:** Polling contract — frontend polls until terminal (`done|failed`) per PRD §10. Unchanged across phases.
- **Params:** `id` UUID
- **Response 200:** `Document`
- **Errors:** `400` invalid UUID, `404` `{error:"Document not found"}`, `500`

#### `POST /api/documents/:id/corrections` — **shipped (see §2.3)**
- **Request:** `{ field: "vendor"|"invoiceNumber"|"invoiceDate"|"totalAmount"|"currency", value: string|number }`
- **Response 200:** `{ id, field, original, corrected, changed }`
- **Side effect:** inserts into `corrections` (re-applied on reprocess/duplicate); correcting amount/currency recomputes FX immediately.

### 2.3 Shipped API deltas (supplement to §2.2 — code is source of truth)

- Auth: all `/api/documents/*` require a logged-in JWT-cookie session (`401` otherwise). Auth surface in `auth.route.ts`: register/login/logout/me/profile/avatar/verify-email/resend-verification/forgot-password/reset-password.
- `POST /upload` duplicate → `409 {code:"DUPLICATE_UPDATED", duplicateOf}` (not `DUPLICATE_CONTENT`); corrections are re-applied onto the surviving record.
- `ExtractedData` = `{vendor?, invoiceNumber?, invoiceDate?, totalAmount?, currency?}` plus FX `totalAmountConverted?/currencyConverted?/conversionRate?/conversionAt?` (target `DISPLAY_CURRENCY`, default INR; wiped + recomputed when amount/currency is corrected).
- Added since §2.2: `GET /:id/attempts` (cascade ledger), `POST /:id/reprocess` (local re-run + refine enqueue), `POST /:id/refinement/retry`, `POST|GET /:id/corrections`, `GET /corrections/stats`, `GET /summary`, `GET /summary/export?format=pdf|csv`. Summary sums prefer FX-converted amounts in the target currency.
- `path` is always local disk (no S3-key variant).

### 2.4 Status Codes Summary

| Route | 2xx | 4xx | 5xx |
|---|---|---|---|
| `POST /upload` | 201 | 400,401,413 | 500 |
| `GET /documents` | 200 | 400,401 | 500 |
| `GET /documents/:id` | 200 | 400,404 (+401 unauth) | 500 |
| `POST /documents/:id/corrections` | 200 | 400,401,404 | 500 |
| `POST /documents/:id/reprocess` | 200 | 400,401,404 | 500 |
| `GET /health` | 200 | — | — |

Auth failures: unauthenticated → `401`; unverified login → `403 EMAIL_NOT_VERIFIED`; wrong-owner access → `404` (not `403`, to avoid ID probing). Duplicate content → `409 DUPLICATE_UPDATED`.

### 2.5 Phase1 vs Phase2 — Exact Delta

| Aspect | Phase1 (sync, local-only) | Phase2 (async, DB-backed refine) |
|---|---|---|
| `POST /upload` latency | Includes local extraction (no cloud call) | Same, plus a `refine_jobs` insert when the local result is incomplete |
| `path` | Local `./uploads/<uuid>-<name>` | Same (local disk; cloud deploy uses `UPLOAD_DIR=/tmp/uploads`, rows in MySQL cloud are the source of truth) |
| `status` lifecycle | `pending → processing → done/failed` in the request handler | Same, plus optional `refine_jobs queued → working → done/retry/dead` afterwards |
| Queue | None | `refine_jobs` table + in-process worker (`REFINE_POLL_MS`, `REFINE_DAILY_CAP`) |
| Worker | None | `jobs/refine.ts` `startRefineWorker()`, reuses `extraction.service` cloud path |
| Frontend change | — | **None** — polling `GET :id` contract identical (PRD §7.2); UI shows a refining badge from `refine_status` |
| Config flag | None (cloud never runs inline) | `REFINE_POLL_MS`, `REFINE_DAILY_CAP`, `AI_API_KEY` |
| Failure visibility | Inline try/catch → `failed` | Refine failures → `retry` with exponential backoff (5 tries → `dead`), never silent |

No frontend code change required. The S3/SQS/Lambda variant of this table from earlier drafts is superseded (see header update 2026-09-14).

---

## 3. Database Schema (DDL)

### 3.1 `documents` — Phase1 (now)

```sql
CREATE TABLE IF NOT EXISTS documents (
  id CHAR(36) PRIMARY KEY COMMENT 'UUID v4 server-generated, PK prevents dup',
  name VARCHAR(255) NOT NULL,
  path VARCHAR(500) NOT NULL COMMENT 'local disk path; file bytes, not source of truth',
  status ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending',
  data JSON NULL COMMENT 'ExtractedData: vendor/invoiceNumber/invoiceDate/totalAmount/currency + totalAmountConverted/currencyConverted/conversionRate/conversionAt',
  error TEXT NULL,
  document_type VARCHAR(50) NOT NULL DEFAULT 'unknown' COMMENT 'invoice|receipt|payment|bill|payslip|settlement_slip|other|unknown',
  document_category VARCHAR(20) NOT NULL DEFAULT 'unknown' COMMENT 'financial|unknown',
  user_id CHAR(36) NULL COMMENT 'FK → users.id; app always sets it, every query scopes WHERE user_id=?',
  expires_at DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL 30 DAY) COMMENT 'hard-delete purge horizon',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status_created (status, created_at),
  INDEX idx_document_type (document_type),
  INDEX idx_type_status (document_type, status),
  INDEX idx_category (document_category),
  INDEX idx_user_created (user_id, created_at),
  INDEX idx_expires (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Notes:**
- Short names: `name` (for `original_name`), `path` (for `stored_path`), `data` (for `extracted_data`), `error` (for `error_message`) per PRD §9.
- `path` is always local disk. There is no S3 key variant (AWS plan dropped).
- `data` JSON shape = `ExtractedData` (financial fields + FX `*Converted` fields + per-type extras). No generated columns in MVP.
- `user_id` scoping is the authz boundary — every document query includes `WHERE user_id=?`.
- `DATETIME` uses `CURRENT_TIMESTAMP` (MySQL 8). `updated_at` auto-updates on row change.

Type mapping (`mysql2`):

```ts
interface DocumentRow {
  id: string;
  name: string;
  path: string;
  status: DocumentStatus;
  data: string | null; // JSON string from mysql2, parse on read
  error: string | null;
  created_at: string;
  updated_at: string;
}
```

### 3.2 `extraction_attempts` — built (was "Phase3 future" in early drafts)

```sql
-- extraction_attempts ledger: one row per cascade rung per document
CREATE TABLE IF NOT EXISTS extraction_attempts (
  id CHAR(36) PRIMARY KEY,
  document_id CHAR(36) NOT NULL,
  method VARCHAR(50) NOT NULL COMMENT 'e.g. heuristic-detect, rule-based, local-llm, llm, fallback-merge',
  predicted_type VARCHAR(50) NULL,
  confidence FLOAT NOT NULL COMMENT '0-1',
  latency_ms INT NOT NULL,
  cost_estimate DECIMAL(10,6) NULL,
  succeeded BOOLEAN NOT NULL,
  fallback_reason VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  INDEX idx_doc_id (document_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 3.3 `refine_jobs`, `corrections`, `users` — built (not in early drafts)

```sql
-- refine_jobs: DB-backed async queue replacing the dropped SQS plan
CREATE TABLE IF NOT EXISTS refine_jobs (
  id CHAR(36) PRIMARY KEY,
  document_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  status ENUM('queued','working','done','retry','dead') NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  next_retry_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'exponential backoff base',
  error TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_refine_due (status, next_retry_at),
  INDEX idx_refine_doc (document_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- corrections: user fixes, re-applied on reprocess so human edits survive
CREATE TABLE IF NOT EXISTS corrections (
  id CHAR(36) PRIMARY KEY,
  document_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  field VARCHAR(50) NOT NULL,
  original_value TEXT NULL,
  corrected_value TEXT NULL,
  extraction_method VARCHAR(50) NULL,
  confidence FLOAT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- users: JWT auth ( Cookies). Passwords bcrypt-hashed; email verification tokens + avatars live here.
-- (Exact columns in backend/src/db/schema.ts — auth was added after this spec's DDL section.)
```

### 3.4 Dropped (early-draft only, do not implement)

- `003_add_document_type.sql` migration — `document_type` shipped in the base table instead.
- `storage.service` / `queue.service` S3/SQS adapters, `EXTRACTION_MODE` flag, `S3_BUCKET`/`SQS_QUEUE_URL` env — deleted with the AWS plan.

---

## 4. Folder / Module Structure

### 4.1 Repository Layout (separate frontend/backend, deploy deferred)

```
clarityDocs/
├── ClarityDocs-PRD.md
├── TECHNICAL_SPEC.md        # this file
├── docker-compose.yml       # mysql:8 for local dev
├── backend/
│   ├── package.json         # type: module, ESM — pdf-parse, tesseract.js, sharp, @huggingface/transformers, mysql2; NO @aws-sdk/*
│   ├── tsconfig.json        # module NodeNext
│   ├── .env.example
│   ├── src/
│   │   ├── index.ts         # bootstrap: pool → ensureSchema → app.listen + refine worker + retention cleanup
│   │   ├── app.ts           # express app factory (for tests)
│   │   ├── config.ts        # typed env (PORT, DB_*, UPLOAD_DIR, AI_*, REFINE_*, CURRENCY_CONVERSION_*, DISPLAY_CURRENCY)
│   │   ├── db/
│   │   │   ├── pool.ts      # mysql2/promise createPool
│   │   │   └── schema.ts    # ensureSchema() runs DDL §3 (documents, attempts, refine_jobs, corrections, users…)
│   │   ├── routes/
│   │   │   ├── documents.route.ts  # upload/list/get/attempts/reprocess/corrections/summary/export
│   │   │   └── auth.route.ts       # register/login/logout/me/profile/avatar/verify/reset
│   │   ├── controllers/
│   │   │   ├── documents.controller.ts
│   │   │   └── auth.controller.ts (or inline in route — see file)
│   │   ├── services/
│   │   │   ├── extraction.service.ts  # cascade orchestrator: heuristic → rules → local Flan-T5 → cloud Gemini + FX enrichment
│   │   │   ├── transformers.service.ts# Flan-T5 loader + composition (rules live in utils/regex-utils.ts)
│   │   │   ├── ai.service.ts          # Gemini/Anthropic extraction + validation
│   │   │   ├── ocr.service.ts         # tesseract.js + sharp (pdfjs path inactive)
│   │   │   ├── dedup.service.ts       # 4-field content match over last 200 rows
│   │   │   ├── confidence.service.ts  # refine gating (needsRefinement)
│   │   │   ├── summary.service.ts     # dashboard aggregates (sums prefer FX-converted amounts)
│   │   │   ├── export.service.ts      # summary CSV/PDF
│   │   │   ├── email.service.ts       # Resend SMTP verify/reset
│   │   │   ├── registry.ts + strategies.ts  # per-type prompts/examples
│   │   ├── jobs/
│   │   │   ├── refine.ts    # in-process async worker (replaces dropped SQS/Lambda)
│   │   │   └── cleanup.ts   # 30-day hard-delete + uploads unlink
│   │   ├── prompts/ + utils/ + types/ + middleware/  # as named
│   │   └── uploads/              # gitignored, local Phase1
├── frontend/
│   ├── package.json          # vite + react + TS (no test runner yet)
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx           # router (incl. /verify-email, /setup-profile)
│       ├── api/
│       │   └── client.ts     # fetch wrapper (VITE_API_URL) + auth/corrections/summary calls
│       ├── hooks/
│       │   ├── usePolling.ts # 2s interval until done|failed (+refine badge)
│       │   └── useApi.ts     # data-fetch helper (used by Dashboard)
│       ├── routes→pages/
│       │   ├── Upload.tsx    # form + drag-drop
│       │   ├── List.tsx      # table + FilterDropdown + ?q= URL sync
│       │   ├── Detail.tsx    # status + extracted_data + polling + corrections UI
│       │   ├── Dashboard.tsx # summary charts (recharts) + CSV/PDF export
│       │   └── Login/Register/Profile/…  # auth pages
│       └── types/ + utils/ (format/badges/avatar/security) + context/ (Auth/Theme/Toast)
```

### 4.2 Module Responsibilities

- **routes/documents.route.ts:** Defines routes, wires `multer` + controller. No business logic.
- **controllers/documents.controller.ts:** Parses req, validates, calls services, maps DB rows → JSON, handles status codes.
- **services/extraction.service.ts:**
```ts
export interface ExtractionResult {
  data: ExtractedData;
  confidence: number; // 0-1, filled-ratio per stage
  method: string;     // e.g. rule-based|local-llm|llm
}
export async function extract(filePathOrBuffer: string | Buffer): Promise<ExtractionResult>;
```
Impl: `pdf-parse` → text (→ `pdftotext` fallback) → deterministic rules; images/scanned PDFs → `tesseract.js`+`sharp` OCR; then local Flan-T5 fill, cloud Gemini arbitration, FX enrichment. (The `pdfjs-dist` swap note from early drafts is stale — that package is not installed.)

- **services/jobs/refine.ts (replaces the two deleted adapters below):** `enqueueRefineJob` + `startRefineWorker()` poll `refine_jobs`; no S3/SQS involved.

> Deleted: `services/storage.service.ts` and `services/queue.service.ts` (S3/SQS adapters) — removed with the AWS plan. Do not re-add; see §5.

---

## 5. Deploy Resources — actual (AWS dropped)

The S3/SQS/Lambda design below from early drafts was **deleted** (2026-09-14, $0 equivalent via `refine_jobs`). Kept here as a struck-through reference so interviewers see the trade-off that was made; do not implement it.

| Resource (dropped) | Was planned as | Replaced by |
|---|---|---|
| **S3 Bucket** | `claritydocs-uploads-*`, 5 GB free | Local `UPLOAD_DIR` (`/tmp/uploads` on Render ephemeral); rows in MySQL cloud are the source of truth |
| **SQS Queue + DLQ** | `claritydocs-jobs`, 1M req/mo free | `refine_jobs` table (`queued/working/done/retry/dead`), 5 tries → dead, sweep of stale `working` |
| **Lambda worker** | `nodejs20.x`, SQS trigger | In-process `startRefineWorker()` (`setInterval REFINE_POLL_MS`), same `extraction.service` code |
| **IAM role** | S3/SQS/logs policies | Nothing — no AWS calls remain |

**Actual deploy:** backend on Render (`node:20-alpine`, `PORT=10000`, `UPLOAD_DIR=/tmp/uploads`), MySQL cloud (Clever Cloud/Railway free, `DB_*` env), frontend on Vercel (`VITE_API_URL`). Demo scale (<100 docs/mo) fits free tiers.

---

## 6. Phased Implementation Checklist (each independently shippable & demoable)

### Phase1 — Synchronous MVP (PRD §7.1)

- [x] Re-init `backend/` ESM (`module NodeNext`, `type:module`, `tsx`)
- [x] `db/pool.ts` + `schema.ts` run DDL §3.1; `config.ts` typed env; `.env.example` with `DB_*, PORT, UPLOAD_DIR, MAX_FILE_SIZE`
- [x] `middleware/upload.ts` (`multer` diskStorage `uploads/<uuid>-<name>`, 10MB, pdf/png/jpg filter) + `error.ts` + `validate.ts` (zod)
- [x] `services/extraction.service.ts` `pdf-parse` impl (export `extract`), regex for `vendor/date/total` + confidence; unit fixture with sample PDF
- [x] `routes` + `controllers` implement `POST /upload` inline flow `pending→processing→done/failed`, `GET /documents`, `GET /documents/:id`
- [x] `app.ts`/`index.ts` wire `cors`, `express.json`, `/api`, `/health`, `ensureSchema`
- [x] `frontend/` Vite scaffold: `Upload` (file input + POST), `List` (GET), `Detail` (polling hook 2s), `client.ts` with `VITE_API_URL`
- [x] `docker-compose.yml` (`mysql:8`, `backend` depends_on, init `clarity_docs` DB), `README` arch note (why sync first)
- [x] Verification (authed cookie): `curl -F file=@invoice.pdf http://localhost:4000/api/documents/upload` → `201` → poll `GET :id` → `done` with `data`; upload 3 real invoices, show list; `npm run build` passes

**Demo exit:** User uploads PDF/PNG, sees `vendor/date/total` within seconds, list persists.

### Phase2 — Async via refine_jobs (done; SQS variant dropped)

- [x] `POST /upload`: local save + local-only extract, `pending→processing→done/failed` inline; incomplete/disagreed results insert `refine_jobs (queued)` and return
- [x] `jobs/refine.ts` worker: claims queued jobs on `REFINE_POLL_MS`, runs cloud pass under rate bucket + `REFINE_DAILY_CAP`, null-fills `data`, records attempts; `retry` with exponential backoff, 5 tries → `dead`; sweeps stale `working`
- [x] Frontend **unchanged** — polling contract identical; UI shows refining badge from `refine_status`
- [x] Verification: upload low-confidence doc → `done` + refining badge → cloud fill lands without new upload; kill worker mid-job → `retry` → `dead` after cap, never silent

**Demo exit:** Same UI, sync and async share the polling contract. Deploy note: file bytes stay on local disk (`UPLOAD_DIR`, ephemeral `/tmp/uploads` on Render); the MySQL row (`data` JSON) is the source of truth and is what persists in MySQL cloud.

### Phase2 → Phase3 delta — MySQL cloud (RDS t3.micro dropped, use managed MySQL)

- [ ] Point `DB_HOST/PORT/USER/PASSWORD/DB_NAME` at MySQL cloud (Clever Cloud/Railway) in `backend/.env`; keep `DB_SSL` semantics from `config.ts`
- [ ] Verify persistence: rows + `data` JSON survive `docker compose down` and container restarts (file bytes on ephemeral disk are re-extractable, not the source of truth)

**Demo exit:** Render + MySQL cloud + Vercel (see §5).

### Phase3 — Tiered + Observability (PRD §7.3 — shipped)

- [x] `extraction_attempts` ledger live (method, confidence, latency, cost, succeeded, fallback_reason, predicted_type); `GET /:id/attempts` exposes it
- [x] Cascade `heuristic → rule-based → local Flan-T5 → cloud Gemini` with rules-win arbitration + forced cloud escalation on disagreement
- [x] Detail timeline UI (attempts) + corrections loop (`corrections` table, inline edit, history, per-field/type/method stats)
- [x] Verification: upload low-confidence doc → see 2+ attempts, correct `totalAmount`, see correction persisted + FX recomputed

### Phase4 — Generalize (PRD §7.4 — shipped day one)

- [x] `document_type` + `document_category` first-class columns; per-type strategy registry (`registry.ts` + `strategies.ts`); 6 financial types from the start
- [x] Verification: upload `invoice` vs `receipt` vs `payslip` → routed extractors, different `data` shapes

---

## 7. Non-Goals & Deviations from PRD

Flagged per PRD §12 instruction — no scope added without flag:

- **Deviations (intentional):** Short meaningful names `name/path/data/error` adopted (PRD §9 updated), align `DATETIME CURRENT_TIMESTAMP` to MySQL 8, add pagination `?limit&offset` (PRD lists simple list; pagination prevents demo breakage — flagged). Add `MAX_FILE_SIZE 10MB` validation (free-tier safety).
- **Non-goals updated (PRD §5):** auth/RBAC **shipped anyway** (JWT cookie + per-user isolation, see §10) — the "no auth" non-goal was lifted. Still respected: no billing, no mobile, web only; OCR accuracy is best-effort rules-first, not production-grade IDP.

---

## 8. Open Questions (Resolved)

- PDF text: `pdf-parse` now, `pdftotext` (poppler) fallback. (`pdfjs-dist` was considered 2026-09-08 but never installed — its raster path in `ocr.service.ts` is inactive.)
- Module: ESM (confirmed 2026-09-08).
- Deploy: Render backend + MySQL cloud + Vercel frontend (§5); `docker-compose` local MySQL is source of truth for dev.

---

## 9. Success Criteria Mapping (PRD §11)

1. Upload real invoice → `vendor/date/total` appears → covered by Phase1 verification.
2. Same polling contract for local-only and refine-backed paths without frontend change → Phase2 checklist.
3. README arch decision (why async) → Phase1 doc task.

---

## 10. Reasoning — Freelancing Finish Decisions (2026-09-14)

**Context:** finish for freelancing applications without an AWS account (free tier required payment verification); deploy on free MySQL cloud + Render/Vercel; login sessions with data retained one month (30-day hard delete + uploads unlink); summary graph downloadable as PDF tables (no chart image); `lambda/` `infra/` + `S3` removed entirely. Choices below locked before build.

| Decision | Choice (locked 2026-09-14) | Why / trade-off |
|----------|----------------------------|-----------------|
| **AWS/S3/SQS/Lambda** | **Remove entirely.** Delete `backend/src/lambda/handler.ts` `backend/src/worker.ts` `backend/src/services/queue.service.ts` `backend/infra/localstack-init.sh` + `@aws-sdk/*`, `docker-compose` worker/localstack entries, and `S3_BUCKET`/`SQS_QUEUE_URL`/`AWS_REGION`/`EXTRACTION_MODE` config branches; `storage.service.ts` reduced to local `fs.readFile` only | No AWS account available and free tier required payment verification. Keeps `upload → extract → view` fully functional on `mysql2`. For deploy, Render `/tmp/uploads` ephemeral is acceptable because the row `data` JSON in cloud MySQL is the source of truth; file bytes after extraction are not re-used. Dropping S3 removes bucket/queue/DLQ/IAM/Lambda-zip setup that blocked the demo. |
| **DB for online deploy** | **MySQL cloud `Clever Cloud Free` (primary) or `Railway Free MySQL` (alt)** via `DB_HOST/PORT/USER/PASSWORD/DB_NAME` `config.ts:14` | Both are `MySQL 8` wire-protocol compatible with `mysql2/promise` — zero code change except env. Free tier covers `<100 docs/mo` `data JSON ~2KB` `Clever Cloud ~256MB` / `Railway $5 credit`. `Neon/Supabase/Turso` are `Postgres/libSQL` — would require rewriting `mysql2` queries. `Render` ephemeral disk avoided; `RDS t3.micro` deferred to later `Phase 3` as user moved `RDS → Phase 3` then asked to finish without cloud. |
| **Auth** | **`JWT HttpOnly cookie` + `bcryptjs`** (`jsonwebtoken@9`, `cookie-parser`) — per-user server isolation `documents.user_id FK→users.id`, `WHERE user_id=?` on all document queries | PRD non-goal "no auth" lifted for multi-user demo. JWT HttpOnly is stateless (no `express-session` store, works on Render free without Redis). `bcryptjs` is pure JS and avoids native builds on `node:20-alpine`. Cookies (not `localStorage`) mitigate XSS theft. |
| **Password hashing** | **`bcryptjs` 10 rounds** | `argon2` stronger but needs native `node-gyp` which fails on `alpine`. `bcryptjs` sufficient for freelancing. |
| **Email verification + reset** | **`Resend` free `100/day 1 domain` via `nodemailer` SMTP `smtp.resend.com 465`** — verification link `uuid 1d expiry` `users.verification_token/expires_at`, reset `password_reset_tokens` `1h` expiry | Simplest free option (single verified domain; `from noreply@resend.dev` for dev). Gmail SMTP needs an app password. When `SMTP_HOST` is empty, registration auto-marks `email_verified=TRUE` (dev fallback); reset still requires Resend. Production guard is exactly that env check — leaving `SMTP_HOST` empty in production self-verifies all accounts. |
| **Per-user isolation** | **Server-side `WHERE user_id=?`** never client-side filter | Prevents cross-user `GET /api/documents/:id` leak; mirrors `listDocuments` `where[]` pattern `validate.ts:1`. |
| **Retention 30-day enforcement** | **Hard delete + `uploads` unlink via `jobs/cleanup.ts` `purgeExpired()`** — `documents.expires_at` defaults to `created_at + INTERVAL RETENTION_DAYS`, `INDEX idx_expires`; purge selects `WHERE expires_at < NOW() LIMIT 500`, unlinks files (best-effort), deletes rows (cascades attempts/corrections) | Hard delete saves free DB quota vs soft `deleted_at`. `LIMIT 500` avoids long transactions. Actually running: `setInterval` 24h + `node-cron` `0 2 * * *` (both call `purgeExpired()`; idempotent so overlap is harmless). No MySQL `EVENT` is created. Purge/refine race is benign: a purged document's refine job finds "document gone" and goes `dead`; refine never resurrects rows. |
| **Graph** | **`recharts` on `frontend` `Dashboard.tsx`** (light, no `canvas` peer) | `PRD.md:81` observability deferred; `recharts` fits `Vite SPA` `frontend/package.json:12` without native deps. Metrics `average usage AVG(totalAmount)` `document authenticity AVG(confidence)` + `totalDocs sumTotal byType trend topVendors` for 30-day window `WHERE user_id=? AND status='done' AND created_at>=NOW()-INTERVAL 30 DAY` `JSON_EXTRACT(data,'$.totalAmount')`. |
| **Download** | **CSV + PDF data exports** via `pdfkit`: `GET /api/documents/summary/export?format=pdf\|csv` — two buttons, `Download Summarized CSV` + `Download Summarized PDF`; the PDF holds summarized tables only, no chart image | `pdfkit` is light vs `puppeteer/html2canvas` on Render free. `Content-Disposition: attachment; filename=claritydocs-summary-YYYY-MM-DD.pdf`. (A client-side PNG graph snapshot exists separately in the UI; it is not a data export.) |
| **File delete after 30d** | **Yes — `uploads/<uuid>-safe` `fs.unlink` in `cleanup.ts`** (`resolveFilename`, `middleware/upload.ts`) | Prevents `Render /tmp` fill. After an ephemeral-disk restart the bytes are gone: `POST /:id/reprocess` then marks the document `failed` (missing file), and refine retries age to `dead` — both graceful, never silent. |

**Consequence for deploy:** Freelancing build is `Render` `node:20-alpine` `npm run build && node dist/index.js` `PORT=10000` `UPLOAD_DIR=/tmp/uploads` `JWT_SECRET` `RETENTION_DAYS=30` `AI_API_KEY` + `Clever Cloud MySQL` `DB_HOST` → `Vercel` `VITE_API_URL`. `lambda/infra/S3/SQS` code deleted; `EXTRACTION_MODE` flag removed.
