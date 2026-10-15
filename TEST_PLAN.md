# Phase 1 Test Plan — Close-out (Sync MVP: Upload → Extract → View)

**Scope:** `ClarityDocs-PRD.md §7` + `TECHNICAL_SPEC.md §6 Phase1 Checklist`. Backend local-only extract on upload (`allowCloud:false`), frontend polling contract `GET /api/documents/:id` until `done|failed`. Covers `documents` table, `multer 10MB`, `pdf-parse + pdftotext fallback + tesseract.js/sharp + regex + Flan-T5 local + Gemini cloud + keyless FX to INR`, `dedup 4-field`, list `q/type` filter, `pending→processing→done|failed`, corrections loop, `refine_jobs` worker.

**Entry Criteria**
- `backend npm run lint && npm run build` green
- `frontend npm run lint && npm run build` green
- `docker-compose mysql:8` up or local `clarity_docs` DB reachable
- `.env` has `DB_*, UPLOAD_DIR=./uploads, MAX_FILE_SIZE=10485760, AI_API_KEY=""` (local-only path: rules + local Flan-T5, no cloud; first extraction pays quantized-model load cost)

**Exit / Close-out Criteria (all must be green)**
- [ ] `backend npx vitest run` 19 spec files 143 tests pass (no coverage gate; run `--coverage` for info only)
- [ ] `backend npm run test:legacy` 5 fixtures `text-invoice.pdf, invoice-image.png 1300, receipt-image.png 200 INR, scanned-invoice.pdf, invoice-hindi-mixed.png 4520` → 5/5 `✓` with `confidence ≥0.5` and `document_type` correct
- [ ] Manual `curl` upload flow (authenticated session cookie required) 6 cases `201 → poll done` with `vendor/date/total` visible
- [ ] Frontend list filters `?q` + `?document_type`, duplicate `409 DUPLICATE_UPDATED` toast, error `400/413/500` mapping (5xx red, 4xx yellow)
- [ ] No P1 defects, `README` arch note present, tag `phase1-complete`

---

## 1. Test Types

| Type | Runner | Where |
|---|---|---|
| Unit (pure) | `vitest` `src/**/*.spec.ts` `environment: node` | `extraction` (cascade stages, docType gate), `ai` (fence strip, date/currency normalize), `dedup` (4-field), `strategies/registry/transformers` (per-type prompts, rules), `confidence` (refine gating), `utils` (amount/currency/date/json) + middleware `validate/uuid, error 400/413/500, upload` + db `pool/schema CREATE TABLE` + jobs `refine` (enqueue/claim/backoff) |
| Controller (service/DB mocks — call them unit, not integration) | `vitest` | `controllers/documents.controller.spec.ts` (mocks `pool.query`, `extract`, `dedup`, `conversion`) + `routes/documents.route.spec.ts` (`GET /health`, pagination `400`, upload `400`, invalid UUID `400`) |
| Fixture Integration | `tsx src/services/extraction.test.ts` | real OCR stack (`pdf-parse` → `pdftotext`, `tesseract.js`+`sharp`) on 5 PDFs/PNGs (no DB). Note: the `pdfjs-dist`/`canvas` raster path in `ocr.service.ts` is inactive (neither package installed) |
| Frontend Unit | manual (no runner yet) | `usePolling` 2s until terminal, `FormattedDate inline vs stacked` |
| E2E Manual (SPEC verification) | `curl` + browser (authed) | `TECHNICAL_SPEC.md §6 Verification` — see §2 |
| Non-functional | Manual | `10MB` limit, `pdf/png/jpg` mime filter, `LIMIT 200` dedup window, `idx_status_created` ordering |

---

## 2. Manual E2E Matrix — Run in order (closes SPEC §6 demo exit)

```bash
# All /api/documents/* calls below need an authenticated session (login cookie).
# 0. health
curl http://localhost:4000/health → {"status":"ok"}

# 1. happy PDF text layer
curl -F file=@backend/fixtures/text-invoice.pdf http://localhost:4000/api/documents/upload → 201 {id, status:done} (terminal status; pending exists only transiently in the row)
curl http://localhost:4000/api/documents/<id> — poll 2s → status done, data.vendor, totalAmount, currency USD, document_type invoice

# 2. image PNG (lib OCR)
curl -F file=@backend/fixtures/invoice-image.png http://localhost:4000/api/documents/upload → 201 → poll → done totalAmount 1300 document_type invoice

# 3. receipt narrow
curl -F file=@backend/fixtures/receipt-image.png http://localhost:4000/api/documents/upload → done totalAmount 200 currency INR type receipt

# 4. scanned PDF (image-wrapped, <20 chars → ocrBuffer application/pdf)
curl -F file=@backend/fixtures/scanned-invoice.pdf http://localhost:4000/api/documents/upload → done data.vendor defined

# 5. duplicate — upload same content as #2 again → expect 409 {code:"DUPLICATE_UPDATED", duplicateOf:"<first-id>"}
curl -F file=@backend/fixtures/invoice-image.png http://localhost:4000/api/documents/upload → 409

# 6. list + filters
curl "http://localhost:4000/api/documents?limit=20&offset=0" → total ≥5 ordered created_at DESC
curl "http://localhost:4000/api/documents?q=Acme" → name LIKE %Acme%
curl "http://localhost:4000/api/documents?document_type=receipt" → only receipt rows

# 7. negative
curl -F file=@/dev/null http://localhost:4000/api/documents/upload → 400 No file
curl -F file=@<exe-file> http://localhost:4000/api/documents/upload → 400 Invalid file type
# 11MB file → 413 File too large
curl http://localhost:4000/api/documents/not-uuid → 400 Invalid document id
curl http://localhost:4000/api/documents/550e8400-e29b-41d4-a716-446655440000 → 404 Document not found
curl "http://localhost:4000/api/documents?limit=9999" → 400 Invalid pagination

# 8. frontend (authed session)
# Upload page dropzone → Upload → toast green success → nav /documents/:id → poll Processing… → done pre JSON
# List header heading + List/Grid toggle same row (no Document|Created sub-header) → search debounce 300ms URL ?q= persists → type FilterDropdown → Clear
# DocumentRow hover bg #f1f5f9, date 2 lines stacked (List) vs Detail header 1 line comma FormattedDate inline
# Duplicate upload → toast warning dark yellow #ca8a04; 413/500 → red #dc2626

# 9. correction + FX (authed; needs network to Frankfurter/ER-API — absent FX fields on API failure are expected, not a bug)
# POST /api/documents/<id>/corrections {field:"totalAmount", value:1275.65} → 200 {changed:true}
# GET /api/documents/<id> → totalAmount 1275.65 AND totalAmountConverted/currencyConverted/conversionRate/conversionAt recomputed (no re-upload)
# POST /api/documents/<id>/reprocess → {status:"done"} preserves the correction, FX intact
```

---

## 3. Automated Coverage Map (19 files, 143 tests)

```
backend/src/services/extraction.service.spec.ts — cascade stages with mocked ocrBuffer/tryAI: rules-first, local fill, cloud merge/keep, FX enrichment
backend/src/services/ai.service.spec.ts — Gemini fence strip → validateAndNormalize INR + DD/MM/YYYY→YYYY-MM-DD, settlement_slip/invoice types, 401 throw
backend/src/services/transformers.service.spec.ts — rule fallbacks via utils/regex-utils (amount/date/vendor/invoiceNumber/currency)
backend/src/services/strategies.spec.ts — per-type strategy registry + prompt selection
backend/src/services/confidence.service.spec.ts — needsRefinement on missing/invalid/disagreement, vendor-only gaps stay local
backend/src/services/dedup.service.spec.ts — 4-field null guard, case-insensitive vendor, upper invoiceNo, toFixed(2) rounding, skip invalid JSON
backend/src/services/ocr.service.spec.ts (2) — exports, importable without side effects
backend/src/utils/conversion.spec.ts (9) — mocked fetch: same-currency shortcut, input guards, primary/fallback/failure, cache, applyConversion, clearConversion
backend/src/services/summary.service.spec.ts (3) — totals mapping, FX-preferring sums, empty-ledger defaults
backend/src/services/email.service.spec.ts (3) — SMTP-unset skip, single code render, reset link
backend/src/services/extraction.test.ts — legacy manual harness, NOT run by vitest (use npm run test:legacy)
backend/src/utils/utils.spec.ts — amount/currency/date/json helpers
backend/src/jobs/refine.spec.ts — enqueue/claim/quota/backoff, stale sweep
backend/src/middleware/validate.spec.ts — uuidSchema, q trim, pagination 400, document_type filter
backend/src/middleware/error.spec.ts — status 400, Invalid file type 400, LIMIT_FILE_SIZE 413, else 500
backend/src/middleware/upload.spec.ts — multer existence
backend/src/db/pool.spec.ts — pool query/execute
backend/src/db/schema.spec.ts — CREATE TABLE idx_status_created, migration catch
backend/src/controllers/documents.controller.spec.ts — upload 400 no file, local-only 201, duplicate 409 DUPLICATE_UPDATED + correction-preserving FX recompute, reprocess, correctField 400/404/200, corrections history/stats, list q escape %_ + type filter, get 400/404/200 parse
backend/src/routes/documents.route.spec.ts — GET /health, pagination 400, upload 400, invalid uuid 400, refinement retry 400
+ legacy: backend/src/services/extraction.test.ts (5 fixtures real OCR)
```

Dropped (no longer exist, do not look for them): `storage.service.spec.ts`, `queue.service.spec.ts` — S3/SQS adapters deleted with the AWS plan.

---

## 4. Frontend Manual Checklist (no runner yet)

- [ ] Registration with SMTP disabled → account is verified and continues to optional profile setup; with SMTP enabled → email verification screen
- [ ] Login → authenticated navigation; refresh → session restored; logout → guest navigation and protected routes return to login
- [ ] Guest navigation shows Login/Create account only; verified users see Upload/Documents/Dashboard
- [ ] Upload dropzone `accept .pdf/.png/.jpg` + max 10MB client hint → submit disabled until file → Upload → Button loading
- [ ] List `GET /api/documents` via `client.ts` `listDocuments(limit,offset,{q,document_type})` → `Heading muted total` + `Input` + `FilterDropdown` + `DocumentList view=list|grid` (header toggle, no sub-header)
- [ ] `usePolling.ts` 2s interval until `done|failed`, cleanup on unmount; `Detail` header renders single-line inline `FormattedDate` (vs stacked 2-line date in `List`)
- [ ] Toast: 5xx red #dc2626, 4xx dark yellow #ca8a04, 2xx green, 3s via `ToastProvider kindFromStatus`

---

## 5. Risks / Gaps to Acknowledge on Close

- `ai.service` real LLM not hit in unit tests (`AI_API_KEY=""`) — `tryAI` path covered only via mocks; add an `AI_API_KEY` staging run before Phase3 if needed
- S3/SQS adapters deleted with the AWS plan — async is DB-backed `refine_jobs` + in-process worker instead; nothing to exercise beyond `jobs/refine.spec.ts`
- `pdfjs-dist`/`canvas` raster path in `ocr.service.ts` is inactive (neither package installed) — scanned PDFs rely on `pdftotext`/tesseract
- `frontend vitest/jsdom/msw` not yet added — covered manually for Phase1 close; add first (polling + client error mapping), it is the biggest untested surface
- No coverage gate enforced — `--coverage` is informational only
- No specs yet for: auth routes (register→verify→login→me with cookies), cross-user isolation (user A reads user B's id → 404), refine worker with fake timers. Priority order for interviews: isolation test first (security), then auth cookie flow, then worker timers (FX now covered)
- Upload validation trusts the client-supplied mime only — no magic-byte sniff at upload (the `%PDF`/PNG/JPEG sniff exists solely for OCR routing in `getImageMime`). Spoofed content-type passes the filter; reuse the sniff at upload

---

## 6. Execution Order to Close Phase 1

1. `cd backend && npm run lint && npm run build`
2. `npx vitest run --coverage` → attach report
3. `npm run test:legacy` → 5/5 fixtures
4. Run §2 curl matrix (6 positives + 7 negatives, authed) — screenshot `done` JSON + List filters + duplicate 409 + toast colors
5. `cd frontend && npm run lint && npm run build`
6. Tag: `git tag phase1-complete -m "Phase1 sync MVP verified 143 specs + 5 fixtures + curl matrix"`
```
