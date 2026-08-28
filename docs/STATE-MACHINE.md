# Five-state machine

> Status: `HISTORICAL IMPLEMENTATION DOCUMENT — REVALIDATE AFTER PRODUCT FREEZE`.

## Workflow states

| State | Required output | Consumed by |
|---|---|---|
| `PLAN` | Structured objectives, scope, tool mapping, expected outputs | `COLLECT` |
| `COLLECT` | Sources, page/row locators, tool events, deterministic metrics | `SYNTHESIZE` |
| `SYNTHESIZE` | Typed data, claims, 3–5 candidate conclusions | `AUDIT` |
| `AUDIT` | Six-category findings, before/after diff, at most one repair | `DELIVER` |
| `DELIVER` | Interactive report state, editable PPTX, evidence JSON | Human review |

Every step has `pending`, `running`, `success`, or `failed`. The previous step's hashed `outputId` appears in the next step's `consumedOutputIds`.

## Terminal states

- `DELIVERED`: every candidate conclusion has been explicitly confirmed or rejected by a human.
- `NEEDS_REVIEW`: artifacts exist, but one or more conclusions remain pending, conflicted, stale, or otherwise require a human.
- `FAILED`: execution could not produce valid deliverables. A failed step must never be presented as success.

失败发生在完整证据图和交付物形成之前，因此服务把 `FAILED` 持久化在 job/progress 状态（含失败节点和错误），不会伪造一个满足完整 `ResearchRun` Schema 的半成品 run。`ResearchRun.terminalStatus` 保留 `FAILED` 作为跨层终态词汇；读取执行失败应检查 job 状态。

The golden case intentionally ends in `NEEDS_REVIEW`; automatic delivery would violate the human-responsibility boundary.

## Human transition rules

| Action | Result |
|---|---|
| Confirm supported/conflicted candidate | `HUMAN_CONFIRMED`, timestamp and confirmed text recorded |
| Edit supported/conflicted candidate | AI original retained; edited text becomes `HUMAN_EDITED / PENDING_REVIEW`，必须再执行一次独立确认 |
| Reject candidate | `REJECTED`, decision recorded |
| Confirm `INSUFFICIENT_EVIDENCE` or `STALE` | Blocked fail-closed |
| Source update touches confirmed conclusion | Confirmation revoked; conclusion becomes `NEEDS_REVIEW` |

## Repair loop

```text
SYNTHESIZE → AUDIT → one repair/downgrade → DELIVER/NEEDS_REVIEW
```

There is no return edge from `AUDIT` to an unlimited generation loop. If a critical issue remains after the single repair, it is assigned to the human review state.
