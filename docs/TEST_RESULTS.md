# Test Results — ParseTrail (2026-11-16)

This document summarizes all test results across unit, integration, and E2E layers.

## Test Summary

| Layer | Runner | Files | Tests Passed | Tests Failed | Status |
|-------|--------|-------|-------------|--------------|--------|
| Backend Unit | vitest | 27 | 263 | 0 | Pass |
| Frontend Unit | vitest | 1 | 27 | 0 | Pass |
| E2E Playwright | playwright | - | - | - | - |

---

## 1. Backend Unit Tests

**Command:** `cd backend && npx vitest run`  
**Result:** 26 test files passed, 263 tests passed, 0 failed

### Test Coverage by File:

| Spec File (relative to repo root) | Tests | Status |
|-----------------------------------|-------|--------|
| `backend/src/app.spec.ts` | 9 | Pass |
| `backend/src/config.spec.ts` | 11 | Pass |
| `backend/src/controllers/documents.controller.spec.ts` | 37 | Pass |
| `backend/src/jobs/cleanup.spec.ts` | 8 | Pass |
| `backend/src/jobs/refine.spec.ts` | 20 | Pass |
| `backend/src/db/pool.spec.ts` | 3 | Pass |
| `backend/src/db/schema.spec.ts` | 3 | Pass |
| `backend/src/middleware/auth.spec.ts` | 5 | Pass |
| `backend/src/middleware/error.spec.ts` | 5 | Pass |
| `backend/src/middleware/upload.spec.ts` | 1 | Pass |
| `backend/src/middleware/validate.spec.ts` | 6 | Pass |
| `backend/src/routes/auth.route.spec.ts` | 13 | Pass |
| `backend/src/routes/documents.route.spec.ts` | 6 | Pass |
| `backend/src/routes/reset-password.spec.ts` | 7 | Pass |
| `backend/src/services/ai.service.spec.ts` | 13 | Pass |
| `backend/src/services/aiKeys.spec.ts` | 9 | Pass |
| `backend/src/services/confidence.service.spec.ts` | 7 | Pass |
| `backend/src/services/dedup.service.spec.ts` | 9 | Pass |
| `backend/src/services/email.service.spec.ts` | 4 | Pass |
| `backend/src/services/export.service.spec.ts` | 1 | Pass |
| `backend/src/services/extraction.service.spec.ts` | 28 | Pass |
| `backend/src/services/ocr.service.spec.ts` | 2 | Pass |
| `backend/src/services/strategies.spec.ts` | 11 | Pass |
| `backend/src/services/summary.service.spec.ts` | 3 | Pass |
| `backend/src/services/transformers.service.spec.ts` | 27 | Pass |
| `backend/src/utils/conversion.spec.ts` | 9 | Pass |
| `backend/src/utils/utils.spec.ts` | 6 | Pass |
| **Total** | **263** | **Pass** |

---

## 2. Frontend Unit Tests

**Command:** `cd frontend && npx vitest run`  
**Result:** 1 test file passed, 27 tests passed, 0 failed

### Test Coverage:

| Spec File (relative to repo root) | Tests | Status |
|-----------------------------------|-------|--------|
| `frontend/src/smoke.test.tsx` | 27 | Pass |
| **Total** | **27** | **Pass** |

---

## 3. E2E Playwright Tests

Playwright E2E: run manually; see browser-automation/README.md
