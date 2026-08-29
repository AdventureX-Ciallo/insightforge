# 前端用户路径规格（V7）— 依据 2026-08-27 两次会议纪要

本文档定义产品的完整用户路径，并给出每条路径对应的后端数据与 API 契约。前端实现方式由前端开发自主决策（纪要明确"无需额外对齐细节"）；后端保证本文件所列契约全部可用、可测、可验收。配套后端实现排期见 `docs/BACKEND-ROADMAP-0828.md`。

## 路径总览

```
首页（3 预设案例 + 自定义输入）
  → 任务进度页（五状态全节点实时推进）
    → 结论审查（对抗式审查高亮 + 人工确认/驳回/编辑）
      → 边界验证（3 个非黄金领域关联问题与证据缺口）
        → 成果交付页（V1→V5 版本链：每轮结果、来源、调整依据）
          → 来源更新（搜索引擎选择 → 受影响对象 → 重算与版本推进）
```

横切能力：自定义白名单上传（多模态识别）、模型端点配置切换。

## 路径 1：首页 — 引导与任务发起

参考 Gemini/Perplexity 初始引导：顶部 3 个高确定性案例快捷入口，下方自定义输入框。

| 前端展示 | 后端契约 | 验收 |
|---|---|---|
| 3 个预设案例卡片（1 黄金 + 2 非黄金） | `GET /api/presets` → `[{id, question, kind: "golden"|"boundary", description}]` | 黄金案例全链路成功；两个边界案例进入失配路径并返回证据缺口（复用失配综合） |
| 自定义问题输入 | `POST /api/runs {researchQuestion}`（8–240 字符校验） | 最多并行 2 个任务；超限返回 429 `RUN_CAPACITY_EXCEEDED` 与 `Retry-After: 1`；内存和磁盘只保留最近 10 个 run，当前/执行中任务不淘汰 |

## 路径 2：任务进度页 — 全节点实时展示

任务进度页实时呈现 AI 从信源读取、数据处理到结果输出的全链路动作（佐证输出基于事实）。

| 前端展示 | 后端契约 | 验收 |
|---|---|---|
| 五状态轨道（PLAN→COLLECT→SYNTHESIZE→AUDIT→DELIVER），每节点 pending/running/success/failed | `GET /api/runs/:id` 轮询（现有 `RunStep[]`）；模型阶段在 events 中以 `llm-planner`/`llm-synthesizer` 工具事件出现 | 每步输出哈希被下一步消费；失败传播不误报成功（现有测试覆盖） |
| SSE 实时流（React 默认使用，错误时回退轮询） | `GET /api/runs/:id/events`；每 run 最多 4 路、全局 6 路，超限 429 `SSE_CAPACITY_EXCEEDED`；60 秒无 step/tool 后以 `stream-end {reason:"idle-timeout", reconnect:true}` 断流 | 断流只释放订阅资源，后台任务继续；客户端自动回退轮询 |
| 每个工具调用的 inputSummary/时长/状态 | `run.events[]`（七字段完整） | 事件数 = 真实调用数，无装饰性条目 |
| 信源读取明细（URL/PDF 页码/CSV 行号） | `run.sources[]` + `run.evidence[]` 定位字段 | 100% 引用可定位（现有 P0-04 测试） |

## 路径 3：结论审查 — 对抗式高亮与人工裁决

对抗式审查结果直接在对应流程节点高亮展示；人工仅对冲突、证据不足条目做确认操作。

| 前端展示 | 后端契约 | 验收 |
|---|---|---|
| 六类审查发现（引用缺失/无支撑/冲突/类型/假设/越界）高亮在结论卡片 | `run.auditFindings[]`（before/after 差异字段） | 审查读取真实输入：改变证据/数值后发现随之变化（audit-input 测试族） |
| 确认 / 驳回 / 编辑（编辑保留 AI 原文） | `POST /api/runs/:id/decisions`（现有） | INSUFFICIENT/STALE 禁止确认（409）；未知结论 404；非法/空编辑或缺少冲突确认边界 400；成功人工动作才产生新版本（见路径 5） |

## 路径 4：边界验证 — 证据缺口的诚实展示

任务末尾输出 3 个"非黄金领域关联小问题"（参考 Perplexity 相关问题设计），呈现当前研究的证据缺口与约束边界。

| 前端展示 | 后端契约 | 验收 |
|---|---|---|
| 3 个关联小问题 + 各自缺口说明 | `GET /api/runs/:id/boundary-questions` → `[{question, rationale, missingEvidence[]}]`（路线图 P1-3） | 黄金 run 返回 3 条；每条缺口可追溯到当前证据范围之外的具体数据类型 |

## 路径 5：成果交付页 — V1→V5 版本链

成果交付独立为第四页面，按 V1 至 V5 依次展示每轮迭代的交付结果、对应来源与调整依据。

| 前端展示 | 后端契约 | 验收 |
|---|---|---|
| 版本时间线 V1→V5（首版 + 每次人工决定/来源更新推进一版） | `GET /api/runs/:id/artifact-versions` → `[{version, createdAt, trigger: "initial"|"human-decision"|"source-update", triggerRef, artifacts[], sources[], adjustmentNote}]`（路线图 P1-1） | 黄金 run + 2 次人工决定 + 1 次来源更新后版本链 ≥4；每版本 artifacts 含 .md/.pdf/.pptx/.json 四类真实文件 |
| 单版本下钻（结论、来源、调整依据） | 版本快照内嵌结论/证据/来源引用 | 旧版本不可变；人工确认撤销（REVOKE_ON_SOURCE_UPDATE）在版本依据中可见 |

## 路径 6：来源更新 — 搜索引擎选择与影响传播

新增带搜索引擎选择的搜索功能，明确展示 AI 搜索路径、数据调整逻辑与受影响对象。

| 前端展示 | 后端契约 | 验收 |
|---|---|---|
| 引擎选择（百度 / Google / Bing） | `POST /api/sources/search {engine, query}` → 候选信源列表（URL/标题/引擎标识）；结果仅为候选来源，解析建模前不构成证据（路线图 P2-5） | 服务端仅发 http/https、请求前校验 host、拒绝环回/私有/保留地址、目标域限引擎白名单（SSRF 测试族） |
| v1→v2 更新影响链（受影响对象列表、确认失效、重算） | `POST /api/runs/:id/source-update` + 后端持久化的受影响对象清单；同时支持黄金问题的缓存模型与在线单端点运行，按实际 Evidence→Datum→Claim→Conclusion 关系解析动态 ID | 不相关结论不变；确认撤销留痕；刷新/重启后状态仍在；同一 run 重复更新返回 409“来源已在 v2”，非黄金任务返回 422“仅适用于内置黄金案例” |
| 基于 v2 复核 STALE 结论 | `POST /api/runs/:id/conclusions/:conclusionId/revalidate` | 仅 STALE 可复核；证据路径当前时恢复 `CURRENT/PENDING_REVIEW`，不自动确认；旧确认及失效记录保留并生成 `REVALIDATION` 成果版本 |
| 调整逻辑说明 | 冲突解释保持 CANDIDATE_EXPLANATION 状态 | 不静默选值、不求平均（现有测试） |

## 横切能力 A：自定义白名单上传

默认无预设白名单；用户上传 PDF/表格格式白名单文件，依托 AI 能力自动识别核验。

| 前端展示 | 后端契约 | 验收 |
|---|---|---|
| 上传入口（PDF/CSV/XLSX/TXT，单文件 5 MiB） | `POST /api/uploads`；请求头 `x-insightforge-file-name` 必须填写经 `encodeURIComponent` URL 编码的文件名；类型/字节/路径校验后落盘 0600，并返回 SHA-256 与 `expiresAt`；同工作区最多 20 个对象/32 MiB，24 小时 TTL | 伪造 MIME、路径穿越、NUL、单文件或聚合超限全部拒绝；并发上传不能绕过配额；过期 GET 返回 410 并清理文件/记录对 |
| 上传文件进入信源体系 | 上传解析为自定义白名单信源并进入 COLLECT 候选（路线图 P3-7） | 上传→解析→候选信源的全链路测试；解析失败如实报错不降级为忽略 |

## 横切能力 B：模型端点配置切换

用户根据研究需求自主配置 AI 模型端点（单端点、显式配置、失败不静默降级）。

| 前端展示 | 后端契约 | 验收 |
|---|---|---|
| 端点配置表单（baseUrl / model / apiKey；可选 PLAN/SYNTHESIZE token 预算） | `GET/POST /api/settings/llm`（路线图 P2-4）；可选 `planMaxTokens / synthesisMaxTokens` 为 256–32768 整数，默认 8192/16384；配置落 `.insightforge/settings.json`（gitignore），API 设置整体优先于环境变量 | GET 永不回显明文 key（掩码），预算原值可见；配置后下轮 run 出现模型工具事件并在 `modelProvenance` 留下实际预算；未配置行为与离线基线一致 |

## 信源置信度权重（贯穿路径 2/5/6）

按域名分类的静态权重表：政府/协会/官方高置信，权威赛事平台与 devpost 高置信，知乎/小红书等内容平台低置信；多维度（权威度/新鲜度/完整度）落到 source 对象并在证据链展示（路线图 P2-6）。低权重信源支撑的结论需在前端可见权重折扣说明。

## 测试与质量门槛（所有者 08-28 指令）

- 后端代码覆盖率 **100%**（行 + 分支，c8/node 覆盖率工具出具报告，作为门禁）。
- 全量对抗式审查：每条用户路径至少一个"攻击用例"（改输入必须改变输出、拒绝边界外目标、失败不得伪装成功）。
- 测试代码与生产代码比例作为报告指标随每次巡检公布。
