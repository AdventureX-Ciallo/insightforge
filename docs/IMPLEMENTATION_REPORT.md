# InsightForge 后端实现报告

> 状态：`CURRENT — 2026-08-28`。本报告只陈述本地后端与已执行门禁，不代表前端、Windows PowerPoint 或部署已经完成。

## 本轮纠正的根因

上一版原型把开发者预写字符串标成 `AI_JUDGMENT`，任意研究问题只做字符串插值，Audit 依赖固定结构，上传也没有进入 COLLECT。本轮没有继续补表面断言，而是重建以下合同：

- 黄金 PLAN/SYNTHESIZE 默认消费认证模型缓存；缓存必须通过文件摘要、提示词摘要、精确问题域、Schema、语义角色、证据 ID、假设 ID 和关键数值校验。
- 非黄金问题不能复用缓存；没有在线端点时进入 `DETERMINISTIC_MISMATCH_BLOCK`，只生成与问题相关的 EvidenceGap。
- Audit 读取当前 Evidence/Datum/Assumption/Claim/EvidenceGap；补入有效证据会改变结果，悬空引用会被移除。
- 上传 UUID 是运行接口的正式输入，已验证文件由 `local-file-reader` 在 COLLECT 内解析。
- Human EDIT 创建 `HUMAN_EDITED CandidateRevision` 并保持待复核；CONFIRM 独立执行。
- SourceVersion 与 ArtifactVersion 只追加不覆盖；旧 MD/PDF/PPTX/JSON 可按版本下载。

## 当前架构

五状态保持不变：

```text
PLAN → COLLECT → SYNTHESIZE → AUDIT → DELIVER
```

默认黄金路径：

```text
认证模型缓存提出计划
→ 程序校验工具计划
→ 搜索快照 + PDF + CSV + 可选上传
→ 认证模型缓存提出 4 条候选
→ 程序校验证据图和数值
→ 六类确定性 Audit + 最多一次 Repair
→ 人工审阅
→ 版本化 MD / PDF / PPTX / JSON
```

核心对象：

`SourceVersion / Source / Locator / Evidence / Datum / Assumption / Claim / EvidenceGap / Conclusion / CandidateRevision / AuditFinding / HumanDecision / ArtifactVersion`

Zod 不只检查字段形状，还检查所有跨对象 ID、当前 SourceVersion/Revision/ArtifactVersion 唯一性、确认元数据和证据不足阻断。

## 模型提出、程序校验

- `model-plan-cache.json` 与 `model-synthesis-cache.json` 有独立 SHA-256 manifest。
- 缓存只允许精确黄金问题；修改问题会失败，不能用问题前缀伪装变化。
- 四个候选语义角色必须唯一；未知证据或假设 ID 失败。
- 候选中的 37.1%、47.6%、31.3% 和 3.04 必须与本轮确定性 Datum 一致。
- 可选在线路径只允许一个显式 HTTPS 端点；配置、网络、Schema 或有效候选不足均失败，不自动切换模型。
- 确定性失配输出的 origin 为 `DETERMINISTIC`，不标成 AI 生成。

## Audit 与人工边界

Audit 覆盖：

- `MISSING_CITATION`
- `UNSUPPORTED_CLAIM`
- `SOURCE_CONFLICT`
- `TYPE_MISMATCH`
- `MISSING_ASSUMPTION`
- `SCOPE_OVERREACH`

估算假设必须在 Audit 前已经存在；Audit 只负责链接，不能根据输入参数临时编造。黄金案例的真实修正是把 `assumption-utilization-gap` 链接到估算 Datum/Claim。因果候选通过 EvidenceGap 保持证据不足，冲突双值保持待人工裁决。

冲突、估算或预测的确认必须带 `reason` 和 `scopeNote`。证据不足与 stale 内容不能确认。每个产品入口人工动作都会同步生成新 ArtifactVersion。

## 来源更新与成果版本

内置更新保存 SourceVersion v1 与 v2。v2 进入后：

- 预测输入重算值 37.1% 变为最终输入重算值约 40.9%；
- Datum 重新计算；相关 Claim 标记 stale；
- Conclusion 进入 `NEEDS_REVIEW`；
- 原确认记录保留，并写入失效时间、原因和 SourceUpdate ID；
- 不相关结论不变；
- 新 MD/PDF/PPTX/JSON 写入 `artifacts/vN/`，旧文件继续保留；
- `GET /api/runs/:id/artifacts/:kind?version=N` 可下载历史版本。

## 0828 路线图完成项

- P1：V1→V5 成果版本链、单版本下钻、四格式导出和 `boundary-questions` API 已完成；Markdown、PDF、PPTX、JSON 都来自同一版本证据快照。
- P2：`/api/settings/llm`、Bing/Google/百度选择、候选来源契约以及信源三维置信度与结论折扣说明已完成。
- P3：1 个黄金 + 2 个边界 presets、自定义白名单上传进入 COLLECT 已完成；结构损坏文件 fail-hard，不降级为忽略。
- 搜索出口只允许 HTTP/HTTPS 和引擎精确 host；fetch 前解析并检查全部 DNS 地址，拒绝凭据、非标准端口、环回/私有/保留地址、重定向与超限响应。

## 上传、安全与实时能力

- PDF/CSV/XLSX/TXT，最大 5 MiB；校验扩展名、MIME、魔数/UTF-8/ZIP 结构、路径、普通文件、大小和 SHA-256。
- 原子落盘，上传目录 `0700`、文件 `0600`；篡改后 GET/运行校验返回失败。
- 黄金任务每次最多 5 个 upload ID，保证内置 5 个信源加上传后仍满足 `MAX_SOURCES=10`；PDF 保留页码，CSV 保留列/行，XLSX 保留工作表/单元格范围。
- 服务只允许 loopback；CSP 和安全文本 DOM 已测；来源内指令只作材料。
- 单一提供方实时搜索只产出未验证候选；白名单权威核验识别 WAF/挑战页，不凭 HTTP 200 误报成功。
- API 模型设置以 `0600` 原子落盘，GET 只返回掩码；API 配置优先于环境变量，失败不静默回退。
- 来源置信度包含权威度、新鲜度、完整度和综合权重；低权重支撑会在 Conclusion 上留下折扣说明。

## 当前验证状态

- 最新全量 Node 结果为 158/158；Path 1–6 显式对抗矩阵 6/6；`src/**` 四项覆盖率均为 100%。
- c8 对 `src/**` 的语句、分支、函数、行覆盖率均为 100%，`npm run coverage` 对四项都执行 100% 失败阈值。
- 物理行统计：生产 TypeScript 6,840 行，Node/fuzz 测试 TypeScript 6,604 行；测试/生产代码比为 0.965:1（96.5%）；计入 97 行 E2E 后为 98.0%。
- TypeScript、生产构建、smoke 与三连演示已通过。`npm run test:e2e` 新鲜通过 1/1（4.7 s），并解析下载的五页 PPTX 与画布对象。
- 当前环境对 Bing、Google、百度的真实只读查询均因 DNS 返回 `198.18.0.0/15` fake-IP 而在 fetch 前 fail-closed，未取得新的搜索成功；2026-08-27 的单提供方成功与白名单 2/4 成功仅为历史网络证据，不能替代当前环境结果。
- 最新联网证据见 `docs/verification/LIVE-SOURCE-VERIFICATION-2026-08-27.md`。
- 收口前源码 ZIP 曾在全新目录完成 `npm ci`、当时的全部门禁、三连跑、smoke 与依赖审计；当前工作树此后已有新增实现，因此旧包不能证明当前版本。最终冻结后的包仍须重跑，名称、大小和 SHA-256 由包旁 manifest 记录。

## 尚不属于后端完成声明的事项

- ABloom 前端仍需传递 upload IDs、拆分编辑/确认、采集确认理由/范围并展示正交状态和成果历史。
- Windows Microsoft PowerPoint 尚无可用目标环境；macOS PowerPoint、OOXML 解析和渲染不能替代该项。
- 在线 LLM 产品端点需要显式 API 配置；缓存路径不冒充本轮在线调用。
- 未获得部署授权，因此没有公开部署、线上配置、生产流量或真实用户数据验证。

## Git 与发布状态

本轮后端收口已获授权提交并推送 `main`。没有 PR、Tag、部署、数据库迁移或生产配置修改。
