# ParseTrail Fix Tracker

One row per checklist item F00–F28. Status values: TODO | DONE | N/A | BLOCKED.
Updated together with each item's commit. Evidence = test names + check results + "Verify" proof.

| ID | Title | Status | Evidence | Commit |
|----|-------|--------|----------|--------|
| F00 | Transaction helper `withTransaction` | DONE | pool.spec.ts: withTransaction commit/rollback/release tests (3 tests); backend vitest 177 passed, tsc/eslint/prettier clean | b9fa460 |
| F01 | Frontend `npm ci` clean-copy install | N/A | Premise does not hold: package.json has vite ^5.3.0 + vitest ^4.1.12; lockfile vitest peerDeps allow vite ^4.2.0||^5.0.0||^6.0.0||^7.0.0. Clean copy at /tmp/opencode/ft-ci: npm ci exit 0, tsc exit 0, vitest 22 passed, build exit 0. No change needed. | c4e1893 |
| F02 | Frontend lint errors + warning | DONE | List.tsx: removed setQInput effect (98), removed sync setLoading (102), added selectedTypes to dep array (118 warning); Profile.tsx: removed sync effect (30) + unused useEffect import; VerifyEmail.tsx: lazy status init (36) + removed setStatus('loading'); eslint exit 0, prettier pass, git diff | grep eslint-disable = 0, vitest 22 passed | 3b30b00 |
| F03 | react-router advisories | BLOCKED | npm audit --omit=dev reports 2 moderate vulns on react-router-dom 6.30.6 (latest 6.x): GHSA-wrjc-x8rr-h8h6 (CVE-2025-68470 open redirect via backslash) and GHSA-337j-9hxr-rhxg (Arbitrary Constructor Injection via deserializeErrors). Vulnerable range 6.0.0-7.17.0 covers all 6.x; fix is react-router-dom@7.18.5 (new major, breaking change). Per item rule, only a new major fixes it -> BLOCKED, awaiting decision on major upgrade. | |
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
