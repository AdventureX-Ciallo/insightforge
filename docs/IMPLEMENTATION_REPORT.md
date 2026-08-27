# Implementation report

> Status: `HISTORICAL PROTOTYPE RECORD — NOT CURRENT MVP COMPLETION EVIDENCE`.

## Product migration

The baseline was a Candidate-stage video-recreation controller with twelve nominal states, StepFun provider locking, ffmpeg fixtures, recording verification and an admitted happy-path paradox. The requested product is not a compatible extension of that domain, so the isolated worktree performs a deliberate replacement rather than retaining two competing runtimes.

Removed:

- video canary, renderer, recorder, ffmpeg/ffprobe and timeline code;
- StepFun model client/provider gates;
- old 12-state controller, preflight and repair loops;
- old fixtures, schemas, tests and build journal tied to the video challenge;
- historical `MEMORY/WORK` PRDs that described the replaced product.

Inherited in simplified form:

- deterministic state transitions and fail-closed behavior;
- hashed output identities and explicit consumption edges;
- schema validation and append-style tool events;
- bounded repair followed by human review.

## Implemented vertical slice

InsightForge runs one industry-research task through five states and four real tools. The golden data is reconstructed from public authority/industry-association releases and deliberately includes a PDF with page locators, a CSV calculation, a scope-conflicting web snapshot number, an unsupported profitability judgment, source v1/v2, and adversarial prompt text. It creates four candidate conclusions, six structured audit findings, one repair/downgrade, and two file artifacts.

The local web workbench displays live progress and persists completed runs. Human decisions are explicit transitions. A source update follows known dependency IDs, revokes stale confirmation and regenerates exports. A separate upload loop validates and stores user-selected source files; an optional live authority check hashes current responses from a fixed URL allowlist.

## Dependency choices

- `zod`: runtime contracts for runs and evidence packages.
- `pdfjs-dist`: real PDF page text extraction without native binaries.
- `jszip`: direct, editable PowerPoint OOXML packaging and ZIP inspection.
- `typescript`/`tsx`: build and Node test execution.
- `playwright`: owner-facing browser verification and demo capture.

`pptxgenjs` was initially evaluated and produced a working deck, but its `image-size` dependency had two high-severity infinite-loop advisories and no patched npm release. It was removed. The final direct OOXML generator has no image parsing path, and `npm audit` reports zero vulnerabilities.

## Verification model

Tests cover the workflow contract, traceability, content types, reproducible formulas, audit categories, one-repair limit, fail-closed propagation, question/evidence mismatch, strict LLM draft references, no-configuration/no-fallback behavior, human decisions, selective staleness, prompt injection, byte-level uploads, loopback enforcement, HTTP persistence and real artifact download. Playwright covers the visible entrypoint. The PPTX is imported and rendered by an independent presentation runtime, checked for overflow, inspected as a montage, then opened and edited through the installed Microsoft PowerPoint application.

## Verified boundaries and remaining platform limits

- Golden source snapshots now name and link public releases from CAAM/CADA/EVCIPA and the State Council client. They are evidence fixtures, not a claim that InsightForge has independently established market truth; the conclusion layer still preserves scope conflicts and human review.
- The optional product-side authority check made real network requests and verified three of four allowlisted pages on 2026-08-27. The CAAM origin failed TLS/network access and remained explicitly failed; its exact URL and figures were separately retrieved through web verification. This is a bounded live-source integrity check, not an arbitrary crawler.
- The golden task remains deterministic and credential-free. An optional single-endpoint LLM candidate path exists with strict evidence-ID validation and no automatic fallback. A real authenticated OpenAI/Codex online run produced five candidate drafts and all five passed the repository validator; the prompt, JSON Schema, output and SHA are retained under `docs/verification/`. The project still contains no API credential, and a Pro subscription/login is not represented as a distributable API key.
- The generated deck was opened in Microsoft PowerPoint for macOS, had an initial Office repair warning, was corrected at the OOXML generator, reopened without repair, edited through the PowerPoint object model and saved. No accessible Windows/PowerPoint environment was available, so Windows-specific behavior is not claimed.
- The server has no authentication because it is a single-user local tool. Exposure risk is mitigated and tested by refusing every non-loopback listen host; it cannot be configured to listen on `0.0.0.0` without code changes.
- The workbench now exposes the real upload loop. POST and GET both verify persisted bytes; the browser independently compares SHA-256; tampering produces 409; filenames and local paths are not interpreted as markup or client-selected storage targets. Uploaded files are still not automatically inserted into the golden evidence graph; doing so requires explicit parsing/modeling rather than treating arbitrary material as verified evidence.
- Generic semantic impact analysis is not implemented; the source-update demo follows explicit object IDs for the one golden case.
- Production deployment was not performed because the owner explicitly prohibited deployment without a separate authorization. The tracked code remains local only.

## Authority and release state

All work is local in an isolated detached worktree based on commit `2113f1091c4e5dbacc5b828013f0ff62514fbd9e`. The original `main` checkout remains clean. No commit, push, PR, deployment, database migration, production configuration or real-user operation was performed.
