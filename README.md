# ClarityDocs

Tiered document intelligence pipeline — invoices/receipts/bills/payments/payslips/settlement slips → structured data with observability.

## Stack
- Backend: Node 20 + Express (ESM `type:module`, `NodeNext`) + `mysql2` (no ORM)
- Extraction cascade (cheapest first): heuristic type sniff → rule-based regex → local Flan-T5-small (`@huggingface/transformers`, quantized) → cloud Gemini-flash fallback
- Text layer: `pdf-parse` with `pdftotext` (poppler) fallback; OCR: `tesseract.js` + `sharp` preprocessing (`pdfjs-dist`/`canvas` raster path is inactive — neither is installed, so scanned PDFs go through `pdftotext`/tesseract only)
- Currency display: free keyless FX (Frankfurter.app primary, open.er-api.com fallback) → `totalAmountConverted` in `DISPLAY_CURRENCY` (default INR), best-effort, rate-cached
- Frontend: React 18 + Vite + TypeScript (SPA)
- DB: MySQL 8, local `mysql:8` via docker-compose or MySQL cloud for deploy
- Async: no AWS. Upload extracts local-only (fast); incomplete results enqueue a DB-backed `refine_jobs` row; an in-process worker (`REFINE_POLL_MS=15s`, daily cap) runs the cloud pass. No S3/SQS/Lambda — deleted per TECHNICAL_SPEC §10.

See `TECHNICAL_SPEC.md` for API contract, DDL, and phased checklist. PRD at `ClarityDocs-PRD.md`.

## Auth

Shipped (not in the original PRD scope): JWT in HttpOnly cookie (`SameSite=lax`, CORS with credentials; no CSRF tokens — SameSite is the only CSRF mitigation) + `bcryptjs`. Logout only clears the cookie (no server-side revocation; tokens live `JWT_EXPIRY`, default 1d). Register → email verify (Resend SMTP, auto-verified in dev **only when `SMTP_HOST` is empty** — never leave it empty in production or all accounts self-verify) → login (unverified → `403 EMAIL_NOT_VERIFIED`) → per-user isolation (`WHERE user_id=?` on all document queries; cross-user access returns `404`, never `403`, to avoid ID probing). All `/api/documents/*` routes require auth — see Quick start for cookie-based `curl`.

## Main endpoints

- `POST /api/documents/upload` → `201 {id, name, status}` (`409 {code:"DUPLICATE_UPDATED"}` on content dup)
- `GET /api/documents`, `GET /api/documents/:id`, `GET /api/documents/:id/attempts`
- `POST /api/documents/:id/reprocess`, `POST /api/documents/:id/refinement/retry`
- `POST|GET /api/documents/:id/corrections`, `GET /api/documents/corrections/stats`
- `GET /api/documents/summary`, `GET /api/documents/summary/export?format=pdf|csv`
- Auth: `POST /api/auth/register|login|logout|resend-verification|verify-email|forgot-password|reset-password`, `GET /api/auth/me`, `PATCH /api/auth/profile`, avatar up/down/load

## Quick start

```bash
cp backend/.env.example backend/.env  # edit DB_* if needed; leave SMTP_HOST empty in dev to auto-verify accounts
docker compose up -d mysql   # or run MySQL locally
cd backend && npm install && npm run dev   # http://localhost:4000
cd frontend && npm install && npm run dev  # http://localhost:5173 (proxies /api to :4000)
```

Authenticated API use (all `/api/documents/*` return 401 without a login cookie):

```bash
curl -c jar.txt -H 'Content-Type: application/json' -d '{"email":"a@b.c","password":"secret123!","first_name":"A","last_name":"B"}' http://localhost:4000/api/auth/register
curl -c jar.txt -b jar.txt -H 'Content-Type: application/json' -d '{"email":"a@b.c","password":"secret123!"}' http://localhost:4000/api/auth/login
curl -b jar.txt -F file=@invoice.pdf http://localhost:4000/api/documents/upload
curl -b jar.txt http://localhost:4000/api/documents
curl -b jar.txt http://localhost:4000/api/documents/<id>  # poll until done|failed
```

## Why sync → async (interview note)

Upload extracts local-only so the API contract (`POST /upload` → 201, `GET :id` polling every 2s) is proven end-to-end with minimal moving parts. When the local result is incomplete or stages disagreed, the API enqueues a `refine_jobs` row and returns; the in-process worker picks it up (`REFINE_POLL_MS`), spends Gemini quota under a rate bucket + daily cap, and null-fills the stored `data`. Frontend polling does not change, demonstrating a sync→async evolution without reshaping the data model. The earlier S3/SQS/Lambda plan was dropped (zero-infra equivalent, same teaching goal).
