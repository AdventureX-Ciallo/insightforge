# Verification evidence

> Status: `HISTORICAL EVIDENCE INDEX — NOT A CURRENT PASS CLAIM`.

This record separates source facts, local engineering evidence and unavailable environments. All timestamps are from 2026-08-27 unless noted.

## Public-source fixtures and live integrity check

The offline golden case no longer uses `example.org` or invented publishers. It retains excerpts and values from these public pages:

- CAAM 2024 forecast: <https://www.caam.org.cn/chn/1/cate_3/con_5236311.html>
- State Council client relay of CAAM 2024 final: <https://app.www.gov.cn/govdata/gov/202501/14/523622/article.html>
- CADA/CPCA 2024 passenger-market report: <https://www.cada.cn/Trends/info_91_10118.html>
- EVCIPA 2024 charging infrastructure: <https://www.evcipa.org.cn/newsinfo/8137834.html>

Independent web retrieval confirmed the values used by the golden case: CAAM's 2024 forecast of 31.00 million total vehicles and 11.50 million NEVs; the State Council client relay of CAAM's 12.866 million final NEV sales and 40.9% all-auto share; CADA/CPCA's 10.899 million passenger-retail NEVs and 47.6% retail penetration plus the 2025 forecast of 13.30 million/57%; and EVCIPA's 3.579 million public chargers at 2024 year-end (with 2.726 million for 2023 corroborated by the alliance's historical release). Thus the fixtures are curated, source-linked offline snapshots; they are not invented market numbers. Derived judgments still remain candidates subject to scope and human review.

Fixture hashes:

| File | SHA-256 |
|---|---|
| `fixtures/golden/search-index.json` | `11c68015b7dd063803d1608e0c3181b0ab4afa6c93ed23f42564c5d28c0faac1` |
| `fixtures/golden/market_v1.csv` | `372121cd994bc6f3b2ebae00b58ba92710743094d12ee3904567960a9ab646b0` |
| `fixtures/golden/market_v2.csv` | `f4bcdb29c2371188126963966d4d483a2d8d32ca8b2190e2c519bf4b75e4fe5d` |
| `fixtures/golden/market-brief.pdf` | `0818565f1e8f1160e75e2e4f0f411adedd3f53a3e81b82af853f3434393c8355` |

The product's own `POST /api/sources/live-check` path was executed against its fixed four-URL allowlist at `2026-08-27T05:21:21.302Z`:

| Source | Result | Bytes | Response SHA-256 |
|---|---:|---:|---|
| CAAM forecast | failed | 0 | none; TLS/network failure was not converted to success |
| State Council client / CAAM final | HTTP 200 | 8,587 | `e33bf4aef4127e54e7833b9bb42bdf9b1167368867a0d35103d727561a1f79c0` |
| CADA/CPCA annual report | HTTP 200 | 56,674 | `2fc2dcb647c101fdc2563761359c378b928004aed22b2a6f5a7a4b5c362c09ba` |
| EVCIPA charging report | HTTP 200 | 1,433 | `57df779cae56bd336a99655ea1d8fbf8020b65d121e4c9960840feafe93e0172` |

This proves bounded live retrieval and honest failure reporting. It does not claim arbitrary web search or independent truth certification.

The machine-readable response is retained at `docs/verification/live-authority-check.json`. The current four-row UI is retained at `docs/assets/insightforge-live-check.png` (635,078 bytes; SHA-256 `7600ab9d9c77c06169af42b4cd6a04caa824fbec147ed65368497d7409bb1c3d`).

## Upload and local-network boundary

Automated tests send real bytes through the HTTP endpoint. PDF/CSV/TXT/XLSX inputs are accepted only after byte validation. Persistence uses UUID names, `0700` directories, `0600` files, temporary files and atomic rename. POST verifies the disk digest, GET revalidates metadata/path/type/size/SHA, and post-write tampering returns 409. A spoofed PDF, malformed XLSX, traversal filename, NUL or invalid-UTF-8 text and a body over 5 MiB are rejected. Browser E2E uploads a CSV whose filename contains an HTML injection payload, independently hashes the selected bytes, compares POST and GET receipts, and proves no injected DOM node exists.

The server was also started at `127.0.0.1:4491` and observed listening only on `TCP 127.0.0.1:4491`. The loopback health request returned HTTP 200; a direct request to the host LAN address `172.20.10.14:4491` failed to connect. A unit/integration test additionally proves `start(..., "0.0.0.0")` rejects before binding.

## Deployment boundary

The production build and production-mode server were started and smoke-tested locally. A public or shared-network deployment was not performed: the owner explicitly withheld authority to deploy, change online configuration or enable production features unless separately authorized, and no deployment platform/project was supplied. Local process liveness is not represented as production deployment evidence. Completing that distinct check requires an explicit deployment target and authorization; the current loopback-only listener would also need an intentionally reviewed exposure architecture rather than an accidental host change.

## Microsoft PowerPoint

The first direct-OOXML deck opened in the installed Microsoft PowerPoint for macOS with the title marker “已修复”. This was treated as a failed acceptance result. OOXML diffing identified an invalid slide-master color map, invalid layout ID, incomplete theme style matrices and missing standard presentation relationships. The generator and regression tests were corrected.

The regenerated deck then opened without the repair marker as a five-slide presentation. Through the Microsoft PowerPoint object model, slide 1 shape text was changed from `PROOF OF INSIGHT` to `OFFICE EDIT CHECK` and saved successfully.

| Evidence file | Bytes | SHA-256 |
|---|---:|---|
| `docs/assets/insightforge-office-valid.pptx` | 17,488 | `5d6cb36493480bb5829f8950ece8b14681ffe58b6d3f335be77ad7d636b75c47` |
| `docs/assets/insightforge-office-edit-check.pptx` | 19,479 | `57c6d0835d374d58399eb9562d4b8f1ae05b81fef75d86127c93f6414a3880d2` |

The same valid deck was independently rendered to five PNG slides and `slides_test.py` reported `Test passed. No overflow detected.` The persistent montage is `docs/assets/insightforge-pptx-montage.png` with SHA-256 `c5d1ce6a09568cb3ff1e0413a7e3ba4d1a323e64516f686cebd41f63f8a5ab63`.

No accessible Windows host with Microsoft PowerPoint was available. Therefore this evidence proves Microsoft PowerPoint for macOS compatibility and text editability, not Windows-specific compatibility. Completing the exact Windows check requires access to a Windows machine with desktop Microsoft PowerPoint; parser, LibreOffice, macOS PowerPoint or rendered images are not substitutes for that environment.

## Real online-model output

An authenticated online `gpt-5.6-sol` run received only the six allowlisted evidence IDs and was constrained by `docs/verification/online-llm-output-schema.json`. It returned five candidate judgments. The repository's `validateLlmDrafts` accepted 5/5; no unknown evidence ID appeared.

| Evidence | Value |
|---|---|
| Output | `docs/verification/online-llm-output.json` |
| Size | 2,698 bytes |
| SHA-256 | `86ea57b67bc638424d682499b315325995d9dce8052592454a411116e6cbbb71` |
| Validation record | `docs/verification/online-llm-validation.json` |

This is a real online model→program validator result. It is not a claim that a deployable API credential exists in the repository or that the external ChatGPT Pro engineering conversation is the same as the product endpoint.

## Current automated gates

Executed from the isolated worktree:

```text
npm run verify                 exit 0; 24/24 Node tests; build and secret scan pass
npm run test:e2e               exit 0; 1/1 Chromium scenario
npm run demo:triple            exit 0; all three runs complete five states with 4 tools and 1 repair
npm run smoke                  exit 0; production build server and health/page checks pass
npm audit --audit-level=high   exit 0; 0 vulnerabilities
```

These are local acceptance results. No commit, push, PR or deployment is implied.
