# Test Plan — ParseTrail (Upload → Extract → View + Async Refine)

**Scope:** [ParseTrail-PRD.md](./ParseTrail-PRD.md) §7 + [TECHNICAL_SPEC.md](./TECHNICAL_SPEC.md) §6 checklist. Upload returns `202 {status:'pending'}` immediately; local extraction and cloud refinement both run in the background `refine_jobs` worker. Frontend polling (`GET /api/documents/:id` every 2s) matters while status is `pending/processing` and while a `refine_jobs` row is `queued/working` after the document is already `done` (cloud fill lands later; UI shows a refining badge). Covers `documents` table (incl. `extracted_text`, `content_hash`, `content_fingerprint`, `reviewed_at`), `multer 10MB` + magic-byte sniff at upload, `pdfjs-dist + pdftotext fallback + tesseract.js OCR + regex + Flan-T5 local + Gemini cloud`, `audit-checks` guardrails (duplicate spike/payslip/future-date), `dedup 4-field`, list `q/type` filter, `pending→processing→done|failed`, corrections loop, `refine_jobs` worker, approve flow.

**Last run (2026-11-17):** backend `vitest` 31 files / 340 passed, 0 failed; frontend `vitest` 1 file / 34 passed, 0 failed. Backend lint/build and frontend lint/build passed.

**Entry Criteria**
- `backend npm run lint && npm run build` green
- `frontend npm run lint && npm run build` green
- `docker-compose mysql:8` up or local `parsetrail` DB reachable
- `.env` has `DB_*, UPLOAD_DIR=./uploads, MAX_FILE_SIZE=10485760, AI_API_KEY=""` (local-only path: rules + local Flan-T5, no cloud; first extraction pays quantized-model load cost)

**Exit / Close-out Criteria (all must be green)**
- [x] `backend npm test` 31 files / 340 passed, 0 failed
- [x] `backend npm run test:legacy` fixtures pass (real OCR stack on 5 PDFs/PNGs)
- [x] `backend npm run lint && npm run build` green
- [x] `frontend npm run lint && npm run build` green
- [x] Playwright E2E `chunk 1` documents list loads after login — PASS
- [x] Playwright E2E `chunk 2` invalid file type shows warning toast — PASS
- [x] Playwright E2E `chunk 3` real invoice upload → Detail page shows extracted fields + attempts — PASS
- [x] Bug fix: `parseDataField` handles mysql2 JSON column as object (not just string)
- [x] No P1 defects
- [ ] Tag `v1-verified` after all criteria pass

---

## 1. Test Types

| Type | Runner | Where |
|---|---|---|
| Unit (pure) | `vitest` `src/**/*.spec.ts` `environment: node` | `extraction` (cascade stages, docType gate), `ai` (fence strip, date/currency normalize), `dedup` (4-field), `strategies/registry/transformers` (per-type prompts, rules), `confidence` (refine gating), `utils` (amount/currency/date/json) + middleware `validate/uuid, error 400/413/500, upload` + db `pool/schema CREATE TABLE` + jobs `refine` (enqueue/claim/backoff) |
| Controller (service/DB mocks — call them unit, not integration) | `vitest` | `controllers/documents.controller.spec.ts` (mocks `pool.query`, `extract`, `dedup`, `conversion`) + `routes/documents.route.spec.ts` (`GET /health`, pagination `400`, upload `400`, invalid UUID `400`) |
| Fixture Integration | `tsx src/services/extraction.test.ts` | real OCR stack (`pdf-parse` → `pdftotext`, `tesseract.js`+`sharp`) on 5 PDFs/PNGs (no DB). Note: the `pdfjs-dist`/`canvas` raster path in `ocr.service.ts` is inactive (neither package installed) |
| Frontend Unit | vitest | `src/smoke.test.tsx` | Login validation, Upload file guards, Detail refining/dead states, list badges, Upload page validation, password policy, Text component rendering |
| E2E Playwright (automated, `browser-automation/extraction-flow.spec.ts`) | `playwright test` | Chunk 1: documents list loads after login — PASS; Chunk 2: invalid file type shows warning toast — PASS; Chunk 3: real invoice upload → Detail page shows extracted fields + attempts — PASS (after `parseDataField` bug fix) |
| E2E Manual (SPEC verification) | `curl` + browser (authed) | [TECHNICAL_SPEC.md](./TECHNICAL_SPEC.md) §6 Verification — see §2 |
| Non-functional | Manual | `10MB` limit, `pdf/png/jpg` mime filter, `LIMIT 200` dedup window, `idx_status_created` ordering |

---

## 2. Manual E2E Matrix — Run in order (closes SPEC §6 demo exit)

```bash
# -1. auth (do this first — every /api/documents/* call below needs the cookie)
# curl -c cookies.txt -H 'Content-Type: application/json' -d '{"email":"t@t.co","password":"secret123!","first_name":"T","last_name":"U"}' http://localhost:4000/api/auth/register
# curl -c cookies.txt -b cookies.txt -H 'Content-Type: application/json' -d '{"email":"t@t.co","password":"secret123!"}' http://localhost:4000/api/auth/login
# dev only: leave SMTP_HOST empty so the account auto-verifies; otherwise verify via /verify-email first
# 0. health
curl http://localhost:4000/health → {"status":"ok"}

# 1. happy PDF text layer
curl -b cookies.txt -F file=@backend/fixtures/text-invoice.pdf http://localhost:4000/api/documents/upload → 202 {id, status:pending} (terminal status reached via polling; background worker runs local extract then cloud refine if needed)
curl -b cookies.txt http://localhost:4000/api/documents/<id> — poll 2s → status done, data.vendor, totalAmount, currency USD, document_type invoice

# 2. image PNG (lib OCR)
curl -b cookies.txt -F file=@backend/fixtures/invoice-image.png http://localhost:4000/api/documents/upload → 202 {status:pending} → poll → done totalAmount 1300 document_type invoice

# 3. receipt narrow
curl -b cookies.txt -F file=@backend/fixtures/receipt-image.png http://localhost:4000/api/documents/upload → 202 → done totalAmount 200 currency INR type receipt

# 4. scanned PDF (image-wrapped, <20 chars → ocrBuffer application/pdf)
curl -b cookies.txt -F file=@backend/fixtures/scanned-invoice.pdf http://localhost:4000/api/documents/upload → 202 → done data.vendor defined

# 5. duplicate — same content as #2 → 409 {code:"DUPLICATE_UPDATED", duplicateOf:"<first-id>"}
# (409 because the exact byte-hash already exists; the existing row is NEVER updated — a new document row is created instead and content near-matches surface POSSIBLE_DUPLICATE alerts via audit-checks)
curl -b cookies.txt -F file=@backend/fixtures/invoice-image.png http://localhost:4000/api/documents/upload → 409

# 6. list + filters
curl -b cookies.txt "http://localhost:4000/api/documents?limit=20&offset=0" → total ≥5 ordered created_at DESC
curl -b cookies.txt "http://localhost:4000/api/documents?q=Acme" → name LIKE %Acme%
curl -b cookies.txt "http://localhost:4000/api/documents?document_type=receipt" → only receipt rows

# 7. negative
curl -b cookies.txt -F file=@/dev/null http://localhost:4000/api/documents/upload → 400 Invalid file type (verified live: multer's mime filter rejects the empty part before the controller's no-file check)
curl -b cookies.txt -X POST http://localhost:4000/api/documents/upload → 400 No file uploaded (no -F part at all — the clean no-file test)
curl -b cookies.txt -F file=@<exe-file> http://localhost:4000/api/documents/upload → 400 Invalid file type
# head -c 11000000 /dev/zero > big.pdf && curl -b cookies.txt -F "file=@big.pdf;type=application/pdf" http://localhost:4000/api/documents/upload → 413 File too large (size limit, not the mime filter)
curl -b cookies.txt http://localhost:4000/api/documents/not-uuid → 400 Invalid document id
curl -b cookies.txt http://localhost:4000/api/documents/550e8400-e29b-41d4-a716-446655440000 → 404 Document not found
curl -b cookies.txt "http://localhost:4000/api/documents?limit=9999" → 400 Invalid pagination

# 8. frontend (authed session)
# Upload page dropzone → Upload → toast green success → nav /documents/:id → poll until `done` (202 returned immediately; refine badge shows while `refine_status` is queued/working)
# List header heading + List/Grid toggle same row (no Document|Created sub-header) → search debounce 300ms URL ?q= persists → type FilterDropdown → Clear
# DocumentRow hover bg #f1f5f9, date 2 lines stacked (List) vs Detail header 1 line comma FormattedDate inline
# Duplicate upload → toast warning dark yellow #ca8a04; 413/500 → red #dc2626

# 9. correction + FX (authed; needs network to Frankfurter/ER-API — absent FX fields on API failure are expected, not a bug)
# curl -b cookies.txt -X POST -H 'Content-Type: application/json' -d '{"field":"totalAmount","value":1275.65}' http://localhost:4000/api/documents/<id>/corrections → 200 {changed:true}
# curl -b cookies.txt http://localhost:4000/api/documents/<id> → totalAmount 1275.65 AND totalAmountConverted/currencyConverted/conversionRate/conversionAt recomputed (no re-upload)
# curl -b cookies.txt -X POST http://localhost:4000/api/documents/<id>/reprocess → {status:"done"} preserves the correction, FX intact
```

---

## 3. Automated Coverage Map

Backend: 31 files / 340 tests (vitest). Frontend: 1 file / 34 tests (Vitest + Testing Library in `smoke.test.tsx`).

The per-file breakdown below is the v1 baseline (143 backend tests); the current suite adds `audit-checks.spec.ts`, `review.spec.ts`, `summary.service.spec.ts`, refined refine tests, and approve/export/summary route tests, bringing backend to 340 and frontend to 34.

Dropped (no longer exist, do not look for them): `storage.service.spec.ts`, `queue.service.spec.ts` — S3/SQS adapters deleted with the AWS plan.

---

## 4. Frontend Manual Checklist (Vitest + Testing Library — 32 tests in `src/smoke.test.tsx`)

- [ ] Registration with SMTP disabled → account is verified and continues to optional profile setup; with SMTP enabled → email verification screen
- [ ] Login → authenticated navigation; refresh → session restored; logout → guest navigation and protected routes return to login
- [ ] Guest navigation shows Login/Create account only; verified users see Upload/Documents/Dashboard
- [ ] Upload dropzone `accept .pdf/.png/.jpg` + max 10MB client hint → submit disabled until file → Upload → Button loading
- [ ] List `GET /api/documents` via `client.ts` `listDocuments(limit,offset,{q,document_type})` → `Heading muted total` + `Input` + `FilterDropdown` + `DocumentList view=list|grid` (header toggle, no sub-header)
- [ ] `usePolling.ts` 2s interval until `done|failed` AND refine settles (`refine_status` neither queued nor working), cleanup on unmount + visibility pause; `Detail` shows `Processing…` only for pending/processing, a refining badge during cloud fill; header renders single-line inline `FormattedDate` (vs stacked 2-line date in `List`)
- [ ] Toast: 5xx red #dc2626, 4xx dark yellow #ca8a04, 2xx green, 3s via `ToastProvider kindFromStatus`

---

## 5. Risks / Gaps to Acknowledge on Close

- `ai.service` real LLM not hit in unit tests (`AI_API_KEY=""`) — `tryAI` path covered only via mocks; add an `AI_API_KEY` staging run if the cloud path needs exercising
- S3/SQS adapters deleted with the AWS plan — async is DB-backed `refine_jobs` + in-process worker instead; nothing to exercise beyond `jobs/refine.spec.ts`
- `pdfjs-dist`/`canvas` raster path in `ocr.service.ts` is inactive (neither package installed) — scanned PDFs rely on `pdftotext`/tesseract
- `frontend vitest/jsdom/msw` not yet added — covered manually; add first (polling + client error mapping), it is the biggest untested surface
- No coverage gate enforced — `--coverage` is informational only
- No specs yet for: auth routes (register→verify→login→me with cookies), cross-user isolation (user A reads user B's id → 404), refine poll-loop scheduling/restart-recovery/concurrent claiming (`refine.spec` covers enqueue/claim/quota/backoff/sweep — the untested part is the `setInterval` loop itself). Priority order for interviews: isolation test first (security), then auth cookie flow, then worker loop timers (FX now covered)
- No real-DB tests: every DB test mocks `pool.query` (`schema.spec` asserts SQL strings). Add a small suite against a real MySQL container (Docker/Testcontainers) — it would also cover atomic `refine_jobs` claiming under concurrency
- Dedup scope untested: `dedup.spec` covers the 4-field logic, but no test proves user A's upload never returns `duplicateOf` pointing at user B's document (code scopes `user_id=?` — assert it)
- Untested features: retention purge (`purgeExpired`), attempts endpoint shape, summary CSV/PDF export bytes, avatar upload validation, cookie flags (HttpOnly/SameSite), single-use expiring reset/verify tokens, login rate limiting
- Upload validation enforces magic-byte sniff at upload (`%PDF`/PNG/JPEG header must match the client mime — spoofed content-type is rejected `400 INVALID_FILE_CONTENT`); the sniff is not only for OCR routing.

---

## 6. Execution Order to Verify v1

1. `cd backend && npm run lint && npm run build`
2. `npx vitest run --coverage` → attach report
3. `npm run test:legacy` → 5/5 fixtures
4. Run §2 matrix (auth preamble + cases 0–6: 4 doc uploads, duplicate 409, list filters, 6 negatives in case 7; plus frontend case 8 and correction case 9, all authed) — screenshot `done` JSON + List filters + duplicate 409 + toast colors
5. `cd frontend && npm run lint && npm run build`
6. Tag: `git tag v1-verified -m "v1 verified: 143 specs + 5 fixtures + curl matrix"`
