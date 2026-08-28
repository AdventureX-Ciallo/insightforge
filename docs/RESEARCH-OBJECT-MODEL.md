# InsightForge 研究对象、状态与成果版本模型

- 版本：`ACTIVE v1.2`
- 状态：`后端合同已实现并由 Zod 交叉引用校验；前端展示待收口`
- 作用：本文件是 PRD、用户流程、前端需求和 P0 验收共同引用的唯一对象与状态词典。

## 1. 研究对象关系

```text
ResearchQuestion
  → ResearchPlan
  → SourceVersion → Source → Locator
                    ├→ Evidence ───────────────┐
                    └→ Datum → Assumption? ───┤
                                              ↓
                                            Claim
                                              ├→ EvidenceGap
                                              ↓
                                         Conclusion
                                              ├→ AuditFinding / CandidateRevision
                                              ├→ HumanDecision
                                              └→ ArtifactVersion
```

关系规则：

- `SourceVersion` 保存某个来源版本、抓取/快照时间、模式和哈希；`Source` 保存发布者、标题、URL/文件及口径。
- `Locator` 精确定位网页摘录、PDF 页码、CSV 行列、XLSX 工作表/单元格或计算输入。
- CSV 定位与确定性计算共用严格的 RFC-4180 风格解析器：支持引号字段、字段内逗号/CRLF、`""` 转义和 UTF-8 BOM；`rows` 按解析后的逻辑记录编号生成，字段内换行不伪造新行，畸形引号 fail-closed。
- `Evidence` 是来源中的可引用材料；来源观点仍是 `SOURCE_OPINION`，不会自动成为系统事实。
- `Datum` 是可计算的数据项。它必须连接来源或派生输入，并保存值、单位、期间、公式和上游数据；表格只是输入容器，不自动成为新事实来源。
- `Assumption` 是估算/预测的显式前提，保存文本、数值、范围、责任主体和来源状态。
- `Claim` 消费一个或多个 `Evidence/Datum/Assumption`；`Conclusion` 只能引用 `Claim`，不得绕过中间对象直接挂来源。
- `EvidenceGap` 是 Claim 在现有材料不足时的机器可读缺口，不得为它伪造 Source。
- `AuditFinding` 记录结构化问题和动作；`CandidateRevision` 保存 AI 或人工产生的新文本版本及前后关系。
- `synthesisOutput` 保存进入 Audit 前的不可变阶段快照（bundle、模式、证据匹配度、来源快照 ID）；SYNTHESIZE 的 `outputId` 是它的稳定 SHA-256。Audit 在副本上修复，当前证据图与原阶段提交不会互相覆盖。
- `HumanDecision` 是显式确认或驳回记录；编辑只产生人工编辑版本，不自动产生确认。
- `HUMAN_CONFIRMED/HUMAN_REJECTED` 是一次性终态：重复提交或直接翻转为另一终态返回冲突且不新增决策/成果版本；必须先 `EDIT` 生成待审修订，才能再次确认或驳回。
- 信源置信度把权威性、新鲜度与定位完整度分开计算；`OTHER` 表示未命中静态域名分类，即使页码/单元格定位完整、综合分超过通用阈值，也必须向关联结论传播未验证折扣，不能用“找得到”替代“可信”。
- XLSX 定位按单个 `<c>` 单元格边界解析；空白、仅样式或无缓存值的公式单元格会被跳过，绝不借用后续单元格的值。共享字符串、inline string 与普通值分别解码，`cellRange` 只覆盖实际提取的首末单元格。
- PPTX 核心结论页支持 Schema 上限 5 条候选；第 5 条触发紧凑行距与字号，所有正文、状态、来源编号及分隔线均保持在 7.5 英寸画布内，3–4 条时保持标准布局。
- PPTX 来源页支持 Schema 上限 10 个信源；超过 5 个时自动切换为双栏紧凑布局，但仍逐项保留来源编号、标题与定位信息，不允许静默截断。
- `ArtifactVersion` 是交互报告、PPTX 和证据 JSON 在同一研究快照上的版本集合。

## 2. 支撑路径与证据缺口路径

每条候选结论必须满足二选一，覆盖率为 100%：

1. `支持路径`：`Conclusion → Claim → Evidence/Datum → Source → Locator`；估算或预测还必须经过 `Assumption`。
2. `证据缺口路径`：`Conclusion → Claim → EvidenceGap`，列出已有部分材料、缺少的来源/指标/口径/交叉验证，以及为何不能确认。没有真实来源时不得为凑覆盖率伪造 `Evidence/Source`。

支持充分的引用必须 100% 可定位，确定性计算必须 100% 可重算；证据不足项必须 100% 有机器可读缺口记录。

`EvidenceGap` 最小字段：

```text
gapId
claimId
existingEvidenceIds[]
existingDatumIds[]
missingItems[]: { kind, description, requiredScope? }
blockingReason
blockedAction: CONFIRM
createdAt
resolvedAt?
resolutionEvidenceIds[]?
```

`missingItems.kind` 只允许 `SOURCE | METRIC | SCOPE | METHOD | CROSS_CHECK | ASSUMPTION`。缺口解决前 `blockedAction` 不得被 UI 或导出忽略；解决后必须保留原缺口与解决证据，不能删除历史。

`CandidateRevision` 最小字段：

```text
revisionId
conclusionId
parentRevisionId?
authorType: AI | HUMAN
originType: AI_JUDGMENT | HUMAN_EDITED
text
changeReason
createdAt
auditStatus: PENDING | PASSED | NEEDS_REVIEW
auditFindingIds[]
sourceSnapshotId
isCurrent
```

同一 Conclusion 只能有一个 `isCurrent=true` 的候选版本；任何编辑或语义改写都新增 revision，不覆盖原文。`parentRevisionId` 必须能重建前后差异。

## 3. 正交状态轴

P0-05 要求的七类机器可读标签不能混成一个会丢失信息的单一字段。每个研究对象按适用性保存以下轴：

### 3.1 知识类型 `knowledgeType`

`FACT | SOURCE_OPINION | CALCULATION | ESTIMATE | FORECAST`

- `FACT` 仅用于来源可直接支撑、口径明确的历史事实。
- `CALCULATION` 保存公式、输入、单位、期间和舍入规则。
- `ESTIMATE` 必须连接假设；`FORECAST` 还必须有预测时间或区间。

### 3.2 责任来源 `originType`

`SOURCE_EXTRACTED | DETERMINISTIC | AI_JUDGMENT | HUMAN_EDITED`

模型产生的候选默认 `AI_JUDGMENT`；开发者固定字符串不得使用该标签。人工编辑产生 `HUMAN_EDITED` 版本，但仍待审。

### 3.3 证据状态 `evidenceStatus`

`SUPPORTED | CONFLICT | INSUFFICIENT_EVIDENCE`

冲突保留所有值和来源；证据不足记录缺口并阻止确认。

### 3.4 人工审阅状态 `reviewStatus`

`PENDING_REVIEW | HUMAN_CONFIRMED | HUMAN_REJECTED | NEEDS_REVIEW`

`HUMAN_CONFIRMED` 是 P0 要求的机器可读人工确认标签，只能由显式确认动作产生；它不是知识类型。编辑、Audit 修复或来源更新均不能自动产生确认。

为兼容现有 API，运行对象仍同时保存旧 `reviewStatus`，但二者不是可自由组合的双状态：`PENDING_REVIEW ↔ PENDING_REVIEW`、`CONFIRMED ↔ HUMAN_CONFIRMED`、`REJECTED ↔ HUMAN_REJECTED`、`NEEDS_REVIEW ↔ NEEDS_REVIEW` 必须逐项一致。Schema 会拒绝任何交叉伪造，权限边界只读取通过该校验的对象。

### 3.5 新鲜度 `freshness`

`CURRENT | STALE`

依赖来源发生变化时，受影响对象变为 `STALE`；无关对象保持 `CURRENT`。

旧 `evidenceStatus` 与 normalized 轴同样受约束：非 stale 时 `SUPPORTED/CONFLICT/INSUFFICIENT_EVIDENCE` 必须完全一致；只有 `evidenceStatus=STALE` 时 normalized 字段保留失效前的证据质量，并且 `freshness` 必须为 `STALE`。反向亦成立，`STALE` freshness 不得搭配非 stale 原始状态。

### 3.6 运行状态

- 步骤状态：`pending | running | success | failed`。
- 运行终态：`DELIVERED | NEEDS_REVIEW | FAILED`。

运行终态与结论审阅状态不同：`DELIVERED` 表示系统已交付一版包含真实状态的成果，不表示其中所有候选都已人工确认。

持久化运行的五个 `RunStep` 必须严格按 `PLAN → COLLECT → SYNTHESIZE → AUDIT → DELIVER` 排列。成功步骤必须携带 64 位 SHA-256 `outputId`；PLAN 不消费输入，之后每个已启动步骤只能消费前一节点的唯一 `outputId`，前一节点必须成功。`DELIVERED/NEEDS_REVIEW` 运行必须五步全成功；任何伪造、断链、额外输入或待执行节点都会被 Zod 拒绝。

## 4. 人工决定合同

`HumanDecision` 至少包含：

```text
decisionId
conclusionId
candidateRevisionId
action: CONFIRM | REJECT
decidedAt
decidedText
decisionReason?
scopeNote?
invalidatedAt?
invalidationReason?
sourceUpdateId?
```

- 确认冲突、估算或预测时，`decisionReason` 和 `scopeNote` 必填。
- 编辑保留原 AI 文本，产生新 `CandidateRevision`，重新经过 Audit，状态仍为 `PENDING_REVIEW`。
- 来源更新不会删除旧决定；旧记录增加失效时间、原因和更新 ID。

## 5. Audit 与一次修复边界

确定性 Audit 读取当前 `Evidence/Datum/Assumption/Claim/Conclusion`，不得按固定对象 ID 播放结果。

Audit 必须是纯变换：不得原地修改已提交并计算 `outputId` 的 SYNTHESIZE 输入。持久化恢复会重算 `hash(synthesisOutput)` 并与该步骤 `outputId` 比对；不一致的运行对象 fail-closed。

自动修复仅允许：

- 结构归一和挂接已经存在的来源/假设；
- 保留并标记冲突；
- 将越界判断降级为证据不足；
- 阻断确认并请求人工处理。

确定性程序不得凭空新增假设或语义改写结论。需要新增假设或改写时，只能产生新的 `AI_JUDGMENT` 或 `HUMAN_EDITED` 候选版本，再审查并保持待确认。自动修复总次数最多 1 次。

## 6. 成果版本生命周期

1. `DELIVER` 首次生成 `ArtifactVersion v1`，页面写“成果已生成，含待审候选”；三个成果共享同一研究快照 ID。
2. 人工确认、驳回或编辑后，系统生成新的 `ArtifactVersion`；旧版本标记 `SUPERSEDED` 并保留下载/审计记录。
3. 应用来源 v2 后，相关对象和人工决定被标记失效；重算生成新的 `ArtifactVersion`，旧版本不删除。
4. PPTX 和 JSON 必须同步带上候选、冲突、不足、人工状态、来源模式和版本号；不得只刷新网页。

`ArtifactVersion` 至少包含 `artifactVersionId/researchSnapshotId/version/createdAt/trigger/artifacts[]/status/supersedesId?`；`trigger` 只允许 `INITIAL_DELIVER | HUMAN_DECISION | HUMAN_EDIT | SOURCE_UPDATE`，`status` 只允许 `CURRENT | SUPERSEDED`。每个 `artifacts[]` 项保存类型、文件名、大小和 SHA-256。

## 7. 来源与模型模式

`sourceDiscoveryMode`：`OFFLINE_SNAPSHOT | LIVE_SINGLE_PROVIDER`

`authorityVerificationMode`：`NOT_RUN | LIVE_ALLOWLIST`

`synthesisMode`：`CACHED_MODEL_OUTPUT | LIVE_SINGLE_ENDPOINT | DETERMINISTIC_GOLDEN_RULES | DETERMINISTIC_MISMATCH_BLOCK`

`offlineMode/offlineModeLabel` 必须由 `synthesisMode` 派生并通过 Schema 交叉校验：缓存输出、确定性黄金规则与确定性失配阻断均为 `true / 使用缓存快照`；在线单端点生成固定为 `false / 在线模型生成 · 信源使用缓存快照`。后一个标签同时说明模型在线而本轮信源发现仍使用离线快照，禁止把混合模式误称为全离线或实时搜索。

- 离线黄金路径使用“加载并校验缓存搜索/模型快照”，不得写成“本次实时发现/生成”。
- 在线信源发现只允许一个明确提供方；固定白名单核验是另一项能力，不能冒充搜索或与发现模式合并。
- 实时模型模式只允许一个预配置端点。页面不接收或回显 API Key；未配置、网络或 Schema 失败均显式失败，禁止静默回退。
- 三个字段必须分别出现在任务顶部、运行 JSON 和 PPTX；不能用一个“在线/离线”总标签掩盖不同来源。
- 来源更新按钮可保留赛事要求的“发现新版来源”，但必须同时显示“载入内置 v2 演示快照”，不能声称自动监控全网。
