# ParseTrail — Architecture

## Extraction Cascade

The core of ParseTrail is a tiered, confidence-scored extraction cascade.
Instead of one opaque cloud call, every document flows through cheaper stages
first, escalating only when required.

```mermaid
flowchart TD
    A[Upload PDF/PNG/JPG] --> B[Parse PDF text / OCR image]
    B --> C{Heuristic type detection}
    C --> D[Rule-based extraction<br/>deterministic regex]
    D -->|Pass| E[Save local extraction + guardrail alerts]
    E --> F[Return 202 pending immediately]
    E --> G{Required fields missing<br/>or strategies disagree?}
    G -->|No| H[Done — no cloud needed]
    G -->|Yes| I[refine_jobs row enqueued]
    I --> J[Background worker polls refine_jobs]
    J --> K[Cloud LLM<br/>Gemini/Groq/OpenRouter]
    K -->|Fill nulls| L[Merge into stored record]
    K -->|Fail| M[Backoff / retry / dead]
    L --> N[Re-run guardrail alerts<br/>duplicate / spike / future date]
    N --> O[Update document_type, category, fingerprint]
    O --> P[Done]
```

## How a document flows (10 lines)

1. User uploads a PDF/PNG/JPG via the web frontend.
2. Backend saves the file, creates a `documents` row with status `pending`, and returns `202 {status: 'pending'}` immediately — no inline extraction.
3. Text is extracted (pdfjs-dist → pdftotext → tesseract.js OCR as fallback).
4. Heuristic detection votes on document type (invoice/receipt/payment/bill/payslip/settlement_slip).
5. Deterministic regex rules extract vendor, date, total, currency; confidence = filled/5 × 0.85.
6. Local extraction is saved with cross-document guardrail alerts (`audit-checks`: possible duplicate, amount spike, payslip shift, future date). Any alert forces review.
7. If rules pass and no refinement is needed, the document is `done` — cloud is skipped.
8. Otherwise a `refine_jobs` row is enqueued for cloud refinement (rate bucket + daily cap + per-user fairness).
9. A background worker (15s poll) runs cloud refinement, fills nulls, re-runs guardrails, and persists `document_type`, `document_category`, and `content_fingerprint`.
10. Cloud fills nulls; every attempt (method, confidence, latency, cost) is logged in `extraction_attempts`.

## Key design decisions

- **Rules-first**: Deterministic rules run before the ML model; ~36% of documents skip model inference entirely (PRD deviation #10).
- **Rules win on conflict**: On rules-vs-model disagreement for number/date/amount/currency, the deterministic rule value is kept AND cloud arbitration is forced (PRD deviation #16).
- **No silent failures**: Every extraction attempt is recorded in `extraction_attempts`; cloud quota is spent only on successful calls.
- **Zero new infra**: Async refinement uses a DB-backed `refine_jobs` table + in-process Node worker, not SQS/Lambda (PRD deviation #3).
- **Local-first**: OCR via tesseract.js; local model via transformers.js; no AWS required.