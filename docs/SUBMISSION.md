# Hackathon submission draft

> Status: `HISTORICAL DRAFT — DO NOT SUBMIT`. Product positioning and claims must be regenerated from the frozen document set and fresh acceptance evidence.

## Track and briefs

- Track: 软件赛道
- SenseTime brief: “AI，不止完成一步”
- Frost & Sullivan brief: “PROOF OF INSIGHT — 让行业判断经得起追问”

## Work

- Name: InsightForge
- Slogan: AI，不止完成一步；让每条行业判断，经得起追问。
- Description: InsightForge is an offline-first industry-research Agent that turns one research question into a structured plan, multi-tool collection, typed evidence, candidate judgments, deterministic audit and editable deliverables. Every conclusion can be traced to source pages/rows/URLs; conflicts are preserved, unsupported claims are blocked, humans own final confirmation, and source updates invalidate only dependent conclusions.

## Target users

Industry analysts, strategy teams, investors and operators who need fast research without losing evidence boundaries and updateability.

## Technology

- TypeScript on Node.js 20+
- Zod contracts
- PDF.js text extraction
- deterministic CSV calculation
- JSZip-based editable PowerPoint OOXML generation
- local HTTP server and dependency-free browser UI
- Playwright end-to-end verification

## Core innovation

1. Evidence-native task chain instead of an answer-only chatbot.
2. Machine-readable distinction among fact, source opinion, calculation, estimate and AI/human judgment.
3. Fail-closed conflict and insufficiency handling.
4. One bounded Audit→Repair with a visible before/after diff.
5. Minimal deterministic source-change impact analysis that revokes stale confirmation and refreshes artifacts.

## Team and process

Single-team prototype. Development used test-first slices, external ChatGPT Pro engineering review, independent source inspection, contract/security tests, real browser E2E, editable-deck rendering/overflow checks and an actual Microsoft PowerPoint open/edit/save check.

## Included assets

- Project screenshot: `docs/assets/insightforge-workbench.png`
- Demo video: `demo-assets/insightforge-demo.webm`
- Disaster PPTX: `demo-assets/insightforge-golden-fallback.pptx`
- Microsoft PowerPoint evidence: `docs/assets/insightforge-office-valid.pptx`, `docs/assets/insightforge-office-edit-check.pptx`
- Live authority-check evidence: `docs/assets/insightforge-live-check.png`
- Source repository: the existing GitHub repository after owner-approved commit/push
- Required tag: `#shenicest-fission` after owner-approved release

## Future plan

After the hackathon: connect securely uploaded files to explicit parse/review actions in the evidence schema, strengthen source-version diffing, add optional live search with explicit snapshot provenance, reusable research templates, and accessibility/localization work. Do not expand into unattended monitoring or multi-agent systems until the evidence and human-decision contract remains stable.
