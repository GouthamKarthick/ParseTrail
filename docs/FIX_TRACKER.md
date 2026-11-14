# ParseTrail Fix Tracker

One row per checklist item F00–F28. Status values: TODO | DONE | N/A | BLOCKED.
Updated together with each item's commit. Evidence = test names + check results + "Verify" proof.

| ID | Title | Status | Evidence | Commit |
|----|-------|--------|----------|--------|
| F00 | Transaction helper `withTransaction` | DONE | pool.spec.ts: withTransaction commit/rollback/release tests (3 tests); backend vitest 177 passed, tsc/eslint/prettier clean | 7a156f5 |
| F01 | Frontend `npm ci` clean-copy install | TODO | | |
| F02 | Frontend lint errors + warning | TODO | | |
| F03 | react-router advisories | TODO | | |
| F04 | Config hardening + `process.env` removal | TODO | | |
| F05 | Cookies, CSRF/origin check, TRUST_PROXY | TODO | | |
| F06 | Password reset atomic claim + JWT invalidation | TODO | | |
| F07 | Login timing equality | TODO | | |
| F08 | Register enumeration — decision required | TODO | | |
| F09 | Verify-email body-only + hashed token | TODO | | |
| F10 | Password policy (72 bytes, cost 12) | TODO | | |
| F11 | Upload hardening + transactional enqueue | TODO | | |
| F12 | Orphan cleanup guardrails | TODO | | |
| F13 | Dedup required userId + by-hash lookup | TODO | | |
| F14 | Corrections atomicity + zod validation | TODO | | |
| F15 | Reprocess as queued job | TODO | | |
| F16 | Rate limits for expensive routes | TODO | | |
| F17 | Remove `isSuspicious` regex filter | TODO | | |
| F18 | PDF text extraction upgrade | TODO | | |
| F19 | AI output guard + README privacy note | TODO | | |
| F20 | Startup order + `/health/ready` | TODO | | |
| F21 | Docker/compose hardening | TODO | | |
| F22 | Build config excludes specs | TODO | | |
| F23 | Types + boilerplate cleanup | TODO | | |
| F24 | Frontend API `request<T>()` helper | TODO | | |
| F25 | Schema integrity migration (data safety) | TODO | | |
| F26 | Docs and repo hygiene | TODO | | |
| F27 | Test gate + full checks + audit | TODO | | |
| F28 | Controller split (optional, on request) | TODO | | |
