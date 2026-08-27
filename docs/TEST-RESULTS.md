# Independent test results

> Status: `HISTORICAL TEST RECORD — REVERIFY FROM THE FINAL FROZEN PACKAGE`.

This file records local verification evidence. A bounded authority-page live check was tested; arbitrary web search and production deployment are not claimed.

## Functional contracts

- TypeScript typecheck: pass.
- Node tests: 24/24 pass — workflow, traceability, evidence-package and complete persisted-run Zod validation, machine types, reproducible calculation, six audit categories, one repair, unrelated-question mismatch behavior, strict LLM draft/config/no-fallback gates, human decisions, source update, security injection, four-format upload bytes/atomic persistence/GET revalidation/tamper rejection, loopback enforcement, live authority-check behavior, HTTP persistence/download and failure propagation.
- Production build: pass.
- Dependency audit: 0 vulnerabilities after removing the vulnerable presentation dependency chain.
- Secret scan: pass.
- Source-ZIP clean directory: `npm ci`, full verify, browser E2E, three-run demo and production smoke all pass without `.git`, prior dependencies, build output or run state.

## Owner-facing entrypoint

- Playwright Chromium E2E: pass.
- Real observed progress: at least one `running` state and five final `success` states.
- Candidate conclusions: 4.
- Evidence drawer: Conclusion→Claim→Evidence→Source and CSV locator visible.
- Human edit: stored and displayed as `HUMAN_CONFIRMED`.
- Source update: 5 affected objects; unrelated conclusion unchanged.
- Artifact downloads: PPTX starts with ZIP signature and downloads with the expected filename.
- Upload UI: Playwright selects a real CSV with an HTML-injection filename, sends raw bytes through HTTP, receives POST+GET persistence verification, compares the browser SHA-256 and confirms no injected element exists.
- External browser requests during offline run: 0.
- End-to-end interaction duration in the final clean-directory run: 3.1 seconds (hardware-specific).
- Golden CLI three-run durations in the final clean-directory run: 195 ms, 13 ms, 11 ms (hardware/cache-specific).

## PPTX

- OOXML import/render: pass, 5 rendered slides.
- Overflow test: pass, 0 findings.
- Editable text elements: present in all five slide XML files.
- Microsoft PowerPoint for macOS: initial repair warning correctly failed acceptance; generator corrected; regenerated file opened without repair, reported 5 slides, accepted an object-model text edit and saved.
- Explicit `INSUFFICIENT_EVIDENCE` state: present.
- Visual montage: `docs/assets/insightforge-pptx-montage.png`.

Windows Microsoft PowerPoint was not available on the local host or reachable remote hosts, so Windows-specific rendering remains an environment limit rather than a claimed pass.

## Network and source verification

- Product live-check endpoint: 3/4 authority URLs returned HTTP 200 and were hashed; the CAAM TLS/network failure stayed failed.
- Listener observation: process bound to `127.0.0.1`; LAN-address connection failed.
- Configuration gate: non-loopback `0.0.0.0` start is rejected by code and test.
- Online LLM: the optional single-endpoint product path is contract-tested, fail-closed and has no provider/model fallback. Separately, one real authenticated OpenAI/Codex `gpt-5.6-sol` run generated five schema-constrained drafts; `validateLlmDrafts` accepted 5/5 with zero unknown evidence IDs. Evidence and hash are retained under `docs/verification/`. This proves real model output→program validation, while correctly not claiming an embedded/distributable API credential.

## Baseline caveat

Before the rewrite, the original repository's 325-test suite had 28 failures caused by a broken local Homebrew ffmpeg/ffprobe linkage (`libx265.215.dylib` missing). The new product has no ffmpeg dependency; its independent clean gates do not inherit that host-library failure.

The first source-ZIP verification exposed one portability defect: `secret-scan.mjs` assumed a Git worktree. The scanner was changed to fall back to a bounded filesystem walk when `.git` is absent, after which the complete clean-directory gate passed. This failed attempt is retained here rather than hidden.
