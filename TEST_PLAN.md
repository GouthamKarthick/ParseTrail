# Phase 1 Test Plan — Close-out (Sync MVP: Upload → Extract → View)

**Scope:** `ClarityDocs-PRD.md §7.1` + `TECHNICAL_SPEC.md §6 Phase1 Checklist`. Backend `inline` (`EXTRACTION_MODE=inline`), frontend polling contract `GET /api/documents/:id` until `done|failed`. Covers `documents` table, `multer 10MB`, `pdf-parse + tesseract.js + regex`, `dedup 4-field`, list `q/type` filter, inline `pending→processing→done|failed`.

**Entry Criteria**
- `backend npm run lint && npm run build` green
- `frontend npm run lint && npm run build` green
- `docker-compose mysql:8` up or local `clarity_docs` DB reachable
- `.env` has `DB_*, UPLOAD_DIR=./uploads, MAX_FILE_SIZE=10485760, AI_API_KEY=""` (regex-only path)

**Exit / Close-out Criteria (all must be green)**
- [ ] `backend npx vitest run` 13 spec files 50 tests pass + `npx vitest run --coverage` lines ≥70% on `services/controllers/middleware/db`
- [ ] `backend npm run test:legacy` 5 fixtures `text-invoice.pdf, invoice-image.png 1300, receipt-image.png 200 INR, scanned-invoice.pdf, invoice-hindi-mixed.png 4520` → 5/5 `✓` with `confidence ≥0.5` and `document_type` correct
- [ ] Manual `curl` upload flow 6 cases `201 → poll done` with `vendor/date/total` visible
- [ ] Frontend list filters `?q` + `?document_type`, duplicate `409 DUPLICATE_CONTENT` toast, error `400/413/500` mapping (5xx red, 4xx yellow)
- [ ] No P1 defects, `README` arch note present, tag `phase1-complete`

---

## 1. Test Types

| Type | Runner | Where |
|---|---|---|
| Unit (pure) | `vitest` `src/**/*.spec.ts` `environment: node` | services `extraction (regex/docType gate), ai (stripJsonFence/normalizeDate/currency), dedup (4-field), storage (resolveFilename/s3 throw), queue (no-op)` + middleware `validate/uuid, error 400/413/500` + db `pool/schema CREATE TABLE` |
| Integration (API+DB mock) | `vitest + supertest` | `controllers/documents.controller.spec.ts` (mock `pool.query`, `extract`, `dedup`) + `routes/documents.route.spec.ts` (`GET /health`, pagination `400`, upload `400`, invalid UUID `400`) |
| Fixture Integration | `tsx src/services/extraction.test.ts` | real `tesseract.js+sharp+poppler` on 5 PDFs/PNGs (no DB) |
| Frontend Unit | `vitest jsdom` + `msw` (existing, next) / manual | `usePolling` 2s until terminal, `FormattedDate inline vs stacked` |
| E2E Manual (SPEC verification) | `curl` + browser | `TECHNICAL_SPEC.md §6 Verification` — see §2 |
| Non-functional | Manual | `10MB` limit, `pdf/png/jpg` filter, `LIMIT 200` dedup, `idx_status_created` ordering |

---

## 2. Manual E2E Matrix — Run in order (closes SPEC §6 demo exit)

```bash
# 0. health
curl http://localhost:4000/health → {"status":"ok"}

# 1. happy PDF text layer
curl -F file=@backend/fixtures/text-invoice.pdf http://localhost:4000/api/documents/upload → 201 {id, status:pending}
curl http://localhost:4000/api/documents/<id> — poll 2s → status done, data.vendor, totalAmount, currency USD, document_type invoice

# 2. image PNG (lib OCR)
curl -F file=@backend/fixtures/invoice-image.png http://localhost:4000/api/documents/upload → 201 → poll → done totalAmount 1300 document_type invoice

# 3. receipt narrow
curl -F file=@backend/fixtures/receipt-image.png http://localhost:4000/api/documents/upload → done totalAmount 200 currency INR type receipt

# 4. scanned PDF (image-wrapped, <20 chars → ocrBuffer application/pdf)
curl -F file=@backend/fixtures/scanned-invoice.pdf http://localhost:4000/api/documents/upload → done data.vendor defined

# 5. duplicate — upload same content as #2 again → expect 409 {code:"DUPLICATE_CONTENT", duplicateOf:"<first-id>"}
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

# 8. frontend
# Upload page dropzone → Upload → toast green success → nav /documents/:id → poll Processing… → done pre JSON
# List header heading + List/Grid toggle same row (no Document|Created sub-header) → search debounce 300ms URL ?q= persists → type select → Clear
# DocumentRow hover bg #f1f5f9, date 2 lines stacked (List) vs Detail header 1 line comma FormattedDate inline
# Duplicate upload → toast warning dark yellow #ca8a04; 413/500 → red #dc2626
```

---

## 3. Automated Coverage Map (13 files, 50 tests)

```
backend/src/services/extraction.service.spec.ts (9) — extract(Buffer) mocks ocrBuffer/tryAI: vendor/invoiceNumber/Rs. confidence gate, scanned PDF application/pdf, currency INR/USD/EUR, file path readFile, receipt/invoice/unknown docType, AI skip/merge/prefer
backend/src/services/ai.service.spec.ts (3) — Gemini fence strip → validateAndNormalize INR + DD/MM/YYYY→YYYY-MM-DD, normalizeDocumentType settlement_slip/invoice, 401 throw
backend/src/services/dedup.service.spec.ts (4) — 4-field null guard, case-insensitive vendor, upper invoiceNo, toFixed(2) rounding, skip invalid JSON
backend/src/services/storage.service.spec.ts (4) — resolveFilename sanitize, saveLocal path passthrough, s3:// throw, fs.readFile local
backend/src/services/queue.service.spec.ts (3) — inline no-op, missing SQS_QUEUE_URL throw, missing SDK throw
backend/src/services/ocr.service.spec.ts (2) — exports, importable
backend/src/middleware/validate.spec.ts (5) — uuidSchema, listQuerySchema q trim, validatePagination _pagination/400, document_type enum
backend/src/middleware/error.spec.ts (4) — status 400, Invalid file type 400, LIMIT_FILE_SIZE 413, else 500
backend/src/middleware/upload.spec.ts (1) — multer existence
backend/src/db/pool.spec.ts (1) — pool query/execute
backend/src/db/schema.spec.ts (2) — CREATE TABLE idx_status_created, migration catch
backend/src/controllers/documents.controller.spec.ts (7) — upload 400 no file, inline pending→done 201, duplicate 409, list q escape %_ + type filter, get 400/404/200 parse
backend/src/routes/documents.route.spec.ts (4) — GET /health, pagination 400, upload 400, invalid uuid 400
+ legacy: backend/src/services/extraction.test.ts (5 fixtures real OCR)
```

---

## 4. Frontend Manual Checklist (no runner yet)

- [ ] Registration with SMTP disabled → account is verified and continues to optional profile setup; with SMTP enabled → email verification screen
- [ ] Login → authenticated navigation; refresh → session restored; logout → guest navigation and protected routes return to login
- [ ] Guest navigation shows Login/Create account only; verified users see Upload/Documents/Dashboard
- [ ] Upload dropzone `accept .pdf/.png/.jpg` + max 10MB client hint → submit disabled until file → Upload → Button loading
- [ ] List `GET /api/documents` via `client.ts` `listDocuments(limit,offset,{q,document_type})` → `Heading muted total` + `Input` + `Select` + `DocumentList view=list|grid` (header toggle, no sub-header)
- [ ] `usePolling.ts` 2s interval until `done|failed`, cleanup on unmount, `detail` inline `FormattedDate,`
- [ ] Toast: 5xx red #dc2626, 4xx dark yellow #ca8a04, 2xx green, 3s via `ToastProvider kindFromStatus`

---

## 5. Risks / Gaps to Acknowledge on Close

- `ai.service` real LLM not hit in Phase1 (AI_API_KEY="") — `tryAI` path covered only via mocks; add `AI_API_KEY` staging run before Phase3 if needed
- `queue/storage S3/SQS` not exercised (Phase2) — `enqueue` no-op correct for Phase1
- `frontend vitest jsdom` not yet added — covered manually for Phase1 close

---

## 6. Execution Order to Close Phase 1

1. `cd backend && npm run lint && npm run build`
2. `npx vitest run --coverage` → attach report
3. `npm run test:legacy` → 5/5 fixtures
4. Run §2 curl matrix (6 positives + 7 negatives) — screenshot `done` JSON + List filters + duplicate 409 + toast colors
5. `cd frontend && npm run lint && npm run build`
6. Tag: `git tag phase1-complete -m "Phase1 sync MVP verified 50 specs + 5 fixtures + curl matrix"`
```
