# Architecture

> Status: `HISTORICAL IMPLEMENTATION DOCUMENT — REVALIDATE AFTER PRODUCT FREEZE`. This file describes the existing prototype and cannot override the draft product documents.

## Outcome

InsightForge proves that one Agent can receive an industry-research question, use multiple real tools, audit its own candidate output, ask a human for the final judgment, and preserve evidence and change impact in reusable artifacts.

```text
Research question
      │
      ▼
PLAN ── structured plan + actual tool mapping
      │ outputId consumed by COLLECT
      ▼
COLLECT ── snapshot search + PDF pages + CSV rows/calculation
      │ outputId consumed by SYNTHESIZE
      ▼
SYNTHESIZE ── typed data + claims + 4 candidate conclusions
      │ outputId consumed by AUDIT
      ▼
AUDIT ── six deterministic gates + one repair/downgrade
      │ outputId consumed by DELIVER
      ▼
DELIVER ── interactive report + editable PPTX + evidence JSON
```

## Runtime

The application is a local TypeScript monolith on Node.js 20+:

- `src/engine.ts` owns orchestration and step-output chaining.
- `src/domain.ts` owns machine-readable types and Zod validation.
- `src/synthesis.ts` owns question/evidence-fit gating, deterministic synthesis, mismatch insufficiency and LLM-draft projection.
- `src/audit.ts` owns the six deterministic audit rules.
- `src/llm.ts` is an optional, explicitly configured single-endpoint candidate-drafting tool; it never confirms conclusions.
- `src/tools/` contains the fixed allowlist: snapshot search, PDF reader, CSV calculator, PPTX exporter, byte-level upload validator, and optional authority-source checker.
- `src/server.ts` exposes a small HTTP API, persists progress/run JSON, and serves the static UI.
- `public/` is a dependency-free browser client using safe DOM APIs.
- `.insightforge/` stores runs and artifacts. It is local and Git-ignored.

No database, queue, model provider, cloud service, or external network is required for the historical golden case. In this old implementation, the live checker and LLM path were optional. The draft product baseline now requires upload, single-provider search, allowlist verification and single-endpoint LLM to be independently reverified after freeze; this paragraph is not authority to delete those entrypoints. The single endpoint remains fail-closed: missing configuration, request failure or fewer than three schema-valid drafts fails SYNTHESIZE instead of switching models or falling back. Historical online-model evidence under `docs/verification/` is not an embedded credential and does not prove the frozen product contract.

## Evidence model

```text
Conclusion
  └─ claimIds[] → Claim
       ├─ evidenceIds[] → Evidence
       │    └─ sourceId → Source + precise locator
       └─ datumIds[] → Datum + formula + inputs + unit + period
```

Machine types are `FACT`, `SOURCE_OPINION`, `CALCULATION`, `ESTIMATE`, `FORECAST`, `AI_JUDGMENT`, and `HUMAN_CONFIRMED`. A source statement stays `SOURCE_OPINION`; an AI judgment stays pending until an explicit human action.

Before synthesis, a deterministic question-fit gate compares normalized question terms with the collected corpus. A mismatched question receives three evidence-insufficiency conclusions and a question-derived scope; it cannot reuse the golden EV conclusions. This is a bounded safety/generalization behavior, not a second industry case.

## Deterministic audit

The audit consumes structured claims and evidence, not hidden conversation context. It checks:

- `MISSING_CITATION`
- `UNSUPPORTED_CLAIM`
- `SOURCE_CONFLICT`
- `TYPE_MISMATCH`
- `MISSING_ASSUMPTION`
- `SCOPE_OVERREACH`

The golden run performs one real repair: adds the missing 15% utilization-loss assumption and downgrades the overreaching profitability conclusion to `INSUFFICIENT_EVIDENCE`. Remaining source conflict and scope questions stay for humans. `repairAttempts` is schema-limited to 0–1.

## Source update

The v1→v2 demo uses explicit dependency IDs. Updating the 2024 NEV sales datum affects only:

```text
source-market-csv + evidence-market-final
  → datum-penetration
    → claim-penetration (STALE)
      → conclusion-penetration (NEEDS_REVIEW)
```

Any prior confirmation for that conclusion is revoked and recorded. Unrelated charging conclusions remain byte-for-byte unchanged. PPTX and JSON exports are regenerated.

## Persistence and failure

The server returns `202` immediately and runs the pipeline in the background. Every `running`, `success`, or `failed` snapshot is persisted. Browser refresh restores `current.json`; process restart reloads the completed run. A failed step is marked `failed`, later steps remain `pending`, and no `DELIVERED` state is possible.

## Security

- Fixed tool allowlist; no arbitrary command, URL crawler, model-selected URL, or filesystem tool.
- All fixtures and artifacts resolve inside configured roots.
- Upload validation accepts only PDF/CSV/XLSX/TXT up to 5 MiB. It validates normalized filenames and raw bytes, assigns a UUID name, uses `0700` directories plus `0600` temporary files and atomic rename, and stores strict metadata. POST verifies the persisted digest; GET revalidates metadata, path, regular-file status, size and SHA-256. The browser independently hashes its selected file and compares POST and GET receipts.
- The HTTP listener is fail-closed to loopback hosts; non-loopback configuration is rejected before `listen()`.
- Static responses include a restrictive CSP, `nosniff`, no-referrer and disabled camera/microphone/geolocation.
- Source text uses `textContent`, never `innerHTML`.
- The adversarial PDF contains “read environment variables”; tests prove it does not change plan/tools/conclusions.
- Secret scanner checks forbidden credential files, private keys, provider tokens, bearer values, and assigned secrets.
