# ClarityDocs — Product Requirements Document
 
## 1. Problem statement
 
People and small businesses regularly receive documents (invoices, receipts,
and eventually other document types) that contain structured information —
vendor name, amount, date, line items — which today has to be read and typed
in by hand. Existing commercial extraction tools (AWS Textract, Google
Document AI, Nanonets, Rossum) solve the extraction itself but are opaque
black boxes: they give you a result with no visibility into *how* it was
produced, no control over the cost-vs-accuracy tradeoff per document, and no
way to learn from corrections over time.
 
ClarityDocs is a small, self-built document intelligence pipeline that solves
the same core problem — turn an uploaded document into structured data — but
does so transparently: every extraction attempt, its method, its confidence,
and its cost are observable, and the system escalates through cheaper
methods before reaching for expensive ones.
 
## 2. Vision
 
Start narrow (invoices/receipts), prove the pipeline works end-to-end, then
generalize into a document analyzer that can handle other document types by
adding new extraction strategies without changing the core architecture.
 
## 3. Target user (for this project's purpose)
 
This is a portfolio/learning project. The two audiences it needs to satisfy:
- **Technical interviewers** evaluating distributed/async systems knowledge
  (SDE-1 job search).
- **The builder himself** — the project must be genuinely understandable and
  extensible without external scaffolding, since it's being built from
  scratch as a learning exercise.
## 4. Goals
 
- Build a working, demoable upload → extract → view pipeline.
- Demonstrate the sync-to-async architectural evolution explicitly (Phase 1
  vs Phase 2), since that evolution *is* the thing being taught.
- Design the data model so it doesn't need to be reshaped when the project
  expands from invoices to general documents.
- The system is designed to run locally first, with optional cloud deployment
  (MySQL cloud, Render/Vercel) — AWS S3/SQS/Lambda infrastructure is optional
  and was dropped to keep the project runnable without an AWS account or paid tier.
## 5. Non-goals (for the MVP)
 
- No production-grade OCR accuracy — a rule-based extractor is acceptable
  for Phase 1/2; ML-based extraction is a later phase.
- No billing, payments, or multi-tenant concerns.
- No mobile app — web only.
- (Auth deviation: full JWT auth with register/login/profiles was added per
  deviation #4 in the living changelog to support multi-user demo needs;
  original non-goal of no multi-user auth was lifted.)
## 6. Key differentiator
 
A **tiered, confidence-scored extraction cascade** instead of one opaque call:
1. **Heuristic type detection** — light type vote across all stages (invoice/receipt/payment/bill/payslip/settlement_slip).
2. **Rule-based extraction** (cheapest) — deterministic regex over OCR/PDF text for vendor, invoiceNo, date, amount, currency; confidence = `min(1, filled/5) * 0.85`. Rules win on any conflict with ML outputs.
3. **Local LLM extraction** (moderate cost) — quantized Flan-T5-small via @huggingface/transformers with per-type 1-shot examples from `strategies.ts`; conflicts with rules resolved deterministically (rules win).
4. **Cloud LLM extraction** (most expensive) — Gemini flash fallback, only invoked if local stages fail or confidence < threshold; forced escalation on rules-vs-model disagreement for number/date/amount/currency.
Every attempt is logged: method used, confidence score, latency, cost, fallback reason, and predicted document type. This is the part existing IDP tools don't expose, and it directly answers the "AI observability" gap identified during planning.
 
## 7. Functional requirements
 
### MVP (Phase 1 — synchronous)
- User can upload a document (PDF, PNG, JPG) via a web form.
- System stores the file and creates a document record with status
  `pending`.
- System runs extraction synchronously and updates the record to
  `processing` → `done` (or `failed` with an error message).
- User can view the extracted data once processing completes.
- User can see a list of previously uploaded documents and their status.
### Phase 2 — asynchronous
- Upload triggers a message onto a queue instead of extracting inline.
- A separate worker process consumes the queue and performs extraction.
- Frontend polling behavior is unchanged — only the backend implementation
  changes.
### Phase 3 — tiered extraction + observability
- Each extraction attempt (not just the final result) is recorded.
- A simple UI shows which method was used and its confidence.
- User can correct a field; the correction is stored for future reference.
### Phase 4 — generalize beyond invoices
- Document "type" becomes a first-class concept.
- Extraction strategies are pluggable per document type.
## 8. Non-functional requirements
 
- **Cost**: designed to run locally first with zero cloud costs; optional cloud
  deployment uses MySQL cloud (Clever Cloud/Railway free tier) for data
  persistence and Render/Vercel for hosting. At demo scale (<100 docs/mo,
  <500 S3 PUT equivalents, <200 Lambda invocations), all metrics are well
  within free-tier limits, but AWS S3/SQS/Lambda are not required — the
  system is fully functional on a single MySQL instance and local disk.
- **Language/stack**: React + TypeScript (frontend), Express + TypeScript
  (backend API), MySQL (persistence), Node (Lambda worker — optional, for
  cloud async path only), Docker (local dev parity).
- **Observability**: every extraction attempt must be traceable after the
  fact — no silent failures. All attempts (method, confidence, latency, cost,
  fallback reason, predicted_type) are recorded in the `extraction_attempts`
  ledger.
## 9. Data model
 
### Phase 1/2 — `documents` table

| Column | Type | Notes |
|---|---|---|
| `id` | VARCHAR(36) PK | UUID v4, server-generated (`crypto.randomUUID()`), `PRIMARY KEY` prevents duplicates (`ER_DUP_ENTRY` → retry) |
| `name` | VARCHAR(255) | as uploaded (short name for `original_name`) |
| `path` | VARCHAR(500) | local path (Phase 1) or S3 key (Phase 2) — short name for `stored_path` |
| `status` | ENUM(pending, processing, done, failed) | |
| `data` | JSON, nullable | shape varies by document type — short name for `extracted_data` |
| `error` | TEXT, nullable | short name for `error_message` |
| `created_at` / `updated_at` | DATETIME | |
| `document_type` | VARCHAR(50) | invoice | receipt | payment | bill | payslip | settlement_slip | other | unknown — per-type extraction strategy routing |
| `document_category` | VARCHAR(50) | financial | unknown — gates per-type strategy selection |
| `user_id` | VARCHAR(36) FK → users.id | per-user isolation; all queries include `WHERE user_id=?` |
| `expires_at` | DATETIME | 30-day retention default: `created_at + INTERVAL 30 DAY`; INDEX `idx_expires` for scheduled purge |

**Notes:**
- Short names: `name` (for `original_name`), `path` (for `stored_path`), `data` (for `extracted_data`), `error` (for `error_message`) per PRD §9.
- `path`: Phase1 local path, Phase2 S3 key. Abstracted via `storageService.resolvePath()`.
- `data` JSON shape = `ExtractedInvoiceData | null`. No generated columns in MVP.
- `DATETIME` uses `CURRENT_TIMESTAMP` (MySQL 8). `updated_at` auto-updates on row change.
- `idx_status_created` index on `(status, created_at)` for list queries.
- `idx_expires` index for 30-day retention purge.

### Phase 3 — additional `extraction_attempts` table (future)

| Column | Type | Notes |
|---|---|---|
| `id` | VARCHAR(36) PK | UUID |
| `doc_id` | VARCHAR(36) FK → documents.id | short name for `document_id` |
| `method` | VARCHAR(50) | e.g. `heuristic`, `regex`, `layout`, `llm` — not indexed (query by `doc_id` only) |
| `predicted_type` | VARCHAR(50) | document type detected by this attempt |
| `confidence` | FLOAT | 0–1 |
| `cost` | DECIMAL, nullable | short name for `cost_estimate` |
| `latency` | INT | ms — short name for `latency_ms` |
| `success` | BOOLEAN | short name for `succeeded` |
| `fallback_reason` | VARCHAR(100), nullable | e.g. `rules_vs_model_disagreement`, `local_llm_failed`, `quota_exhausted` |
| `created_at` | DATETIME | |

Not built in the MVP — included here so the schema decision is made once,
not revisited mid-project.
 
## 10. High-level data flow

**Phase 1 (synchronous):**
`React frontend` → `Express API (save + call inline extraction)` → `Extraction function (rules-first cascade: heuristic → rule-based → local Flan-T5 → cloud Gemini)` → `MySQL`, with the frontend polling `GET /api/documents/:id` until status is terminal. Every extraction attempt is recorded in the `extraction_attempts` ledger.

**Phase 2 (async hybrid):**
Same frontend and API, except the API's upload handler: saves the file (local `./uploads` or S3 via `storageService`), creates a `documents` row `pending`, enqueues a `refine_jobs` row with `status=queued`, and returns immediately. An in-process worker polls MySQL every ~15s, picks up `queued` jobs, runs the extraction cascade, updates the job to `working`, writes results to `documents` (sets `done` + `data` or `failed` + `error`), and records every attempt in `extraction_attempts`. The frontend's polling contract does not change — `GET /api/documents/:id` still polls until terminal state.

**Phase 3 (tiered + observability, documented):**
Each extraction attempt (not just the final result) is recorded in `extraction_attempts` with method, confidence, latency, cost, succeeded, fallback_reason, predicted_type. A UI badge shows which method was used and its confidence. User can correct a field; the correction is stored in the `corrections` table with the producing method for failure analytics.
 
## 11. Success criteria for the MVP
 
- A user can upload a real invoice/receipt image or PDF and see structured
  fields (vendor, date, total) appear within a reasonable time.
- The same codebase can be pointed at either the inline extraction path or
  the SQS/Lambda path via configuration, without frontend changes.
- The project has a README explaining the architecture decision (why async,
  what problem it solves) clearly enough for an interviewer to follow.
## 12. Open questions / assumptions
 
- Assuming personal/demo-scale traffic (not production load) for all free
  tier and performance reasoning in this document.
- Assuming the builder will implement Phase 1 and Phase 2 himself, with an
  AI assistant used for guidance/debugging rather than full code generation.
- Extraction accuracy is explicitly not a success metric for Phase 1/2 — the
  pipeline architecture is.
## 13. Deviations from the original PRD (living changelog)
 
Recorded 2026-09-23. The build below diverged from sections 1–12 where
free-tier limits, user decisions, and demo needs demanded it. The §4 goals
are preserved in spirit; the means changed.
 
| # | Original PRD | What actually happened | Why |
|---|---|---|---|
| 1 | §2 Vision: start narrow (invoices/receipts), generalize in Phase 4 | Generalized on day one: 6 financial types (`invoice/receipt/payment/bill/payslip/settlement_slip`) + financial-only category gate | User decision: uniform quality across all six types from the start |
| 2 | §6 Tiers: regex → layout-aware → LLM | Heuristic sniff → local Flan-T5-small (quantized, in-Docker) → Gemini-flash fallback, plus deterministic amount/date fallback extractors; no separate layout stage | Free-tier + offline-first; layout handling folded into prompts and fallbacks |
| 3 | §7/§10 Phase 2: SQS + Lambda | Re-planned: DB-backed `refine_jobs` table + in-process worker, no new infra | Same sync→async teaching goal (§4) at $0 and 512MB Docker-safe |
| 4 | §5 Non-goal: no multi-user auth | Full auth shipped (register, mandatory email verify, login, profiles, avatars) | Demo and multi-user needs |
| 5 | §8 Cost basis: AWS always-free tiers | Gemini free-tier quotas + local-first; OCR via tesseract (slow — 5+ min observed on photo PDFs) | No AWS usage; everything reproducible locally via Docker |
| 6 | §12 Accuracy explicitly NOT a success metric | Accuracy IS now measured: 55-doc multi-country eval set (`backend/eval/`) + light-detection baseline 26/41 (2026-09-23) | User decision: maximize parse coverage for all types |
| 7 | MVP scope (§7) | Added beyond MVP: dedup-with-update, summary dashboard + CSV/PDF export, multi-type filters, responsive UI; reprocess endpoint planned | User requests during build |
| 8 | Schema (§9) | `documents` gained `document_type`, `document_category`, `user_id`, `expires_at`; `refine_jobs` planned instead of SQS-backed attempts | Required by generalization + async plan |
| 9 | Return-to-center package (2026-09-24) | `extraction_attempts` ledger added (what happened per stage: method, confidence, latency, cost, fallback reason) alongside planned `refine_jobs` (what needs doing); `GET /documents/:id/attempts` exposes the journey | Original differentiator (observable escalation) was log-lines only; now recorded per document |
| 10 | Cascade default (2026-09-24) | Default order switched model-first → **rules-first**; cross-strategy disagreement (rules vs model on number/date/amount/currency) forces cloud escalation | Measured over 39 fixtures: identical accuracy, 36% of docs skip the model, ~40% lower latency; disagreements (Tata date, 1stEnergy decimals) proved Flan silently degrades rule values |
| 11 | Confidence model (2026-09-24) | Experiment strains: grid-fit presence-signal weights (Spearman 0.28) LOSE to filled-ratio baseline (0.42) — NOT shipped; `confidence.service.ts` kept as explainable reporter only | Negative result recorded in `eval/confidence-fit.json`; presence ≠ correctness without ground truth — gate stays filled-ratio + disagreement escalation |
| 12 | Phase 2 async (2026-09-24) | Sync upload path is local-only (fast); incomplete results enqueue `refine_jobs`; in-process worker (15s poll, no new infra) spends Gemini quota under rate bucket + daily cap + per-user fairness, merges cloud-filled nulls, records attempts; `POST /documents/:id/reprocess` re-runs local + requeues; UI shows refining badge + dead-letter retry | Same sync→async teaching goal as SQS/Lambda plan with zero infra; swap story preserved (transport changes, engine doesn't) |
| 13 | Refine policy (2026-09-24) | Enqueue iff required fields missing/invalid OR strategies disagreed (no magic threshold); cloud failure with still-incomplete data requeues with exponential backoff (5 tries → dead); quota consumed only on successful cloud calls | Quota-conscious: vendor-only gaps stay local; dead letters are retryable, never silent |
| 14 | Phase 3 remainder (2026-09-24) | Extraction-timeline UI on Detail (attempts API) + corrections loop (`corrections` table, inline field edit, history, per-field/type/method stats API) | Original "user can correct a field" requirement closed; corrections carry the producing method for failure analytics |
| 15 | Phase 4 strategies (2026-09-24) | Per-type strategy registry (`services/strategies.ts`): cloud prompt focus lines + tailored Flan 1-shot examples; invoice path byte-identical; rollout certified neutral-or-better per type over 39 fixtures (v5) | Pluggable extraction without engine rewrite (original Phase 4 vision); cloud focus lines await quota recovery for measurement |
| 16 | Disagreement arbitration (2026-09-24) | On rules/model conflict (number/date/amount/currency), deterministic rule values win immediately AND cloud escalation is forced for arbitration | Measured: Flan silently degrades rule values (Tata date, 1stEnergy decimals); vendor excluded (formatting variance) |
| 17 | Review fixes (2026-09-24) | External review: duplicate/reprocess re-apply recorded corrections instead of clobbering; sweep requeues only aged working jobs; `path` omitted from list/get responses; upload returns actual status; amount render guarded | Corrections-preserving verified live (9999 survived re-upload); auth findings (#1–4) and search/filter issues confirmed real but deferred — auth is frozen scope, needs a dedicated hardening pass |
| 18 | Quality pass A+B (2026-09-24) | Backend: shared `utils/` (date/currency/amount/json) replacing 13 scattered copies; `uploadDocument` → `finalizeUpload`/`handleDedupUpdate`; `extract()` → rules/local/cloud stages; dead code deleted (storage.service, registry Q&A, unused zod/types/prompts/security/config); composite indexes; parallel summary queries; retention wired; current-year Aug fallback | All guarded: suite green, type agreement steady, null-precision steady; auth-scope audit items deliberately untouched |
| 19 | UX motion+content (2026-09-24) | CSS-only route fade, skeleton shells everywhere, table stays mounted during refetch, shared Empty/Error states with actions, `statusBadges`/`useApi`/`Intl` helpers, mobile keeps Status, polling visibility-pause + refine backoff, toast/button focus polish; deleted unused Select/Menu | Zero new dependencies; `prefers-reduced-motion` throughout; charts already route-split so no lazy change needed |
| 20 | Rules extraction module split (2026-10-05) | Deterministic rules moved out of `services/transformers.service.ts` into `utils/regex-utils.ts` (amount/date/vendor/invoice-number/currency + ID-like guard); the service now owns only the Flan-T5 loader and the composition around it, re-exporting the rules for callers and eval. `.gitignore` patterns un-anchored (`node_modules/`, `logs/`, `uploads/`) so root-level dirs are covered | The split was left half-applied — mangled import, `extractDateFallback` recursing into itself, `monthNum`/strategy/logger references unresolved — leaving 35 tests and `tsc` red. Rules are now importable without loading the model, which is what makes them unit-testable in isolation; `extractCurrencyFallback` delegates to the existing `detectCurrencyFromText` rather than keeping a fourth copy |
 
## 14. Real-world problem validation (market research)
 
The "so what" question — why would anyone other than an interviewer care —
has three answers backed by actual market data, not assumption. Each maps
onto a document type ClarityDocs already extracts.
 
### 14.1 Accounts payable — duplicate and erroneous payments
 
Industry benchmarks (APQC, IOFM) put duplicate or erroneous payments at
roughly 0.8–2% of a company's total disbursements — not a rare edge case,
a predictable, recurring leak. Separately, manual invoice processing is
estimated to cost around $15 per invoice, and over half of businesses
report spending more than 10 hours a week on invoice processing and
supplier payment admin. On the fraud side, industry surveys report that a
meaningful share of small businesses fall victim to invoice fraud
(duplicate or inflated invoice submissions), at real average losses per
incident.
 
**Why this matters for ClarityDocs specifically:** the dedup-with-update
feature already built (§13, deviation #7) is infrastructure for exactly
this problem. It currently silently merges duplicates; the market data
says the more valuable behavior is to **flag a likely duplicate before
it's marked paid**, since that's the moment the loss is still preventable.
 
### 14.2 GST / Input Tax Credit reconciliation (India-specific)
 
Under current GST rules, a business can only claim Input Tax Credit to the
extent the purchase invoice actually appears in the supplier-filed
GSTR-2B statement. In practice this fails constantly: GSTIN typos, invoice
number or date mismatches, late or missing supplier filings, and duplicate
entries all silently block otherwise-legitimate ITC claims, and mismatches
between returns are a common trigger for compliance scrutiny. Multiple
sources describe manual GST reconciliation as the single biggest recurring
compliance burden for Indian SMBs — and, notably, one vendor building
dedicated reconciliation tooling for this exact problem states plainly
that affordable tools for small businesses mostly just handle return
filing, while tools that do real reconciliation are priced for
enterprises. That's a specific, named gap between "cheap and does filing"
and "reconciles properly but costs enterprise money."
 
**Why this matters for ClarityDocs specifically:** the test invoices you
already built include GSTIN, CGST/SGST splits, and invoice numbers — the
exact fields a GSTR-2B cross-check needs. A lightweight "does this
purchase invoice's GSTIN/number/amount match what your supplier actually
filed" companion feature sits in a validated, underserved niche, not a
hypothetical one.
 
### 14.3 Payslip literacy and deduction anomalies
 
A 2024 study by the Chartered Institute of Payroll Professionals found
that close to 40% of employees don't fully understand what's listed on
their own payslip, and common self-audit failures include not checking
deduction math or overtime rates against expectation.
 
**Why this matters for ClarityDocs specifically:** payslip is already one
of your six supported document types. Turning the extracted numbers into
"does this month's deduction math add up, and how does it compare to last
month" is a personal-finance feature built almost entirely on data you
already extract and store — not new extraction work, just a new read on
existing rows.
 
## 15. Recommended prioritization
 
Combining this research with the extraction-only-isn't-enough gap
identified earlier, in priority order:
 
1. **Duplicate/near-duplicate payment flagging** — uses the dedup
   infrastructure that already exists; validated by real industry loss
   figures; needs no new document types or extraction work.
2. **Payslip deduction-anomaly + month-over-month diff** — uses the
   existing payslip type and corrections infrastructure; effectively free
   given the current schema.
3. **GSTR-2B cross-check for purchase invoices** — higher effort (needs a
   way to import or paste GSTR-2B data to compare against), but targets a
   specifically named, underserved gap in the Indian SMB market rather
   than a generic "wouldn't it be nice" feature.
**Explicitly not recommended right now:** building toward full GST return
filing. That's a regulated, liability-bearing space (filing rules change,
and getting a filing wrong has real consequences for a real business) —
appropriate for a company with compliance backing, not for a portfolio
project built alongside GATE prep. Cross-checking and flagging is safe,
useful, and demonstrable; auto-filing is not worth the current risk for
the return it offers this project.
 
---
 
## Instructions for generating the technical specification
 
This PRD is the input. Using it, produce a `TECHNICAL_SPEC.md` that covers:
 
1. Full API contract (routes, request/response shapes, status codes) for
   both Phase 1 and Phase 2, noting exactly what changes between them.
2. Complete database schema (DDL) for the `documents` table now, and the
   `extraction_attempts` table as a documented future migration.
3. Folder/module structure for the backend and frontend consistent with the
   stack listed in section 8 (no ORM assumed — plain `mysql2` — unless the
   spec explicitly calls out a reason to add one).
4. AWS resource list for Phase 2 (S3 bucket, SQS queue, Lambda function,
   IAM role/policy requirements) with free-tier limits noted inline.
5. A phased implementation checklist matching sections 7.1–7.4 above, each
   phase independently shippable and demoable.
6. A short "validated feature backlog" section translating §14/§15 into a
   Phase 5 checklist (duplicate-payment flagging, payslip anomaly diff,
   GSTR-2B cross-check) — additive only, without expanding Phase 1–4 scope.
Do not introduce scope beyond what's listed in Goals/Non-goals (section 4/5)
without flagging it as a deviation from this PRD.
