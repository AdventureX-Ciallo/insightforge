# InsightForge

> 当前状态（2026-08-28）：后端纵向切片已实现，Node/覆盖率/build/smoke/三连演示/密钥扫描与源码包门禁通过；前端仍由 ABloom 独立完善。当前受管沙箱禁止 Chromium 的 macOS Mach rendezvous，因此浏览器 E2E 需在可启动浏览器的环境复跑。尚未提交、推送、打 Tag、创建 PR 或部署。

`从一个行业问题，到一份能下钻、能质疑、能更新的研究成果。`

InsightForge 用同一个软件作品响应两个命题：

- 商汤小浣熊“AI，不止完成一步”：一个任务经过 `PLAN → COLLECT → SYNTHESIZE → AUDIT → DELIVER`，真实调用搜索/快照、PDF/本地文件、表格计算、模型候选和 PPTX 工具。
- 沙利文“PROOF OF INSIGHT”：研究问题、信源、版本、证据、数据、假设、候选判断、审查、人类决定与成果版本形成可校验的证据图。

默认黄金案例不需要网络或密钥。PLAN 与 SYNTHESIZE 消费经过 SHA-256、问题域、Schema、工具白名单、证据 ID、假设 ID 和关键数值校验的模型缓存；页面明确显示“使用缓存快照”，不会冒充本轮实时模型调用或实时搜索。

## 环境要求

- Node.js 20 或更高版本
- npm（随 Node.js 安装）
- Chromium 仅在运行 Playwright E2E 时需要；项目依赖已包含 Playwright

项目不需要数据库。运行状态、上传和成果只写入项目下的 `.insightforge/`，服务端强制仅监听 loopback。

## 从干净目录运行

```bash
npm ci
npm run verify
npm run coverage
npm run test:e2e
npm run demo:triple
npm run smoke
npm audit --audit-level=high
```

生成经过密钥扫描、排除依赖/构建/运行/浏览器状态的源码 ZIP（输出必须在仓库外）：

```bash
npm run package:source -- /absolute/path/InsightForge-source.zip
```

命令同时生成 `InsightForge-source.zip.manifest.json`，记录基线 commit、ZIP 大小、SHA-256、文件数和排除规则。

生产构建和启动：

```bash
npm run build
npm start
```

默认地址：<http://127.0.0.1:4399>。打开页面后点击“运行黄金案例”即可执行完整五状态任务，不需要手改 JSON、数据库或源码。

开发模式：

```bash
npm run dev
```

## 配置

复制 [.env.example](.env.example) 仅用于查看可选配置；离线黄金案例不需要创建 `.env`。

可选在线模型路径要求同时设置：

```text
INSIGHTFORGE_LLM=1
INSIGHTFORGE_LLM_API_KEY=...
INSIGHTFORGE_LLM_BASE_URL=https://...
INSIGHTFORGE_LLM_MODEL=...
```

该路径只允许一个 HTTPS 兼容端点，不路由多模型、不自动 fallback。缺配置、网络失败、Schema 错误、未知 evidence ID 或有效候选少于 3 条都会 fail-closed。任何密钥只存在于运行环境，不得提交。

## 一键演示会发生什么

1. `PLAN`：模型缓存提出五步计划，程序校验工具 allowlist 和 Audit/Deliver 锚点。
2. `COLLECT`：读取明确标记的搜索快照、逐页 PDF 和 CSV v1，保留 URL、页码、列名与行号。
3. `SYNTHESIZE`：模型缓存提出 4 条候选；程序校验证据、假设和数字，所有候选保持待复核。
4. `AUDIT`：执行六类输入驱动规则；链接预先存在的估算假设，保留口径冲突，因果判断保持 `INSUFFICIENT_EVIDENCE`；最多自动修复一次。
5. `DELIVER`：从同一证据快照生成 Markdown、可解析 PDF、五页可编辑 PPTX 与机器可读证据 JSON；交互式报告由当前页面提供。

演示内置 v1→v2 来源变化：相关 Datum/Claim/Conclusion 和人工确认失效，不相关结论保持不变，重算后生成新 `ArtifactVersion`，旧 MD/PDF/PPTX/JSON 不覆盖并可按版本下载。

## 0828 后端接口

- `GET /api/presets`：固定返回 1 个黄金案例和 2 个诚实失配案例。
- `GET /api/runs/:id/boundary-questions`：完成后返回 3 个可追溯到 EvidenceGap 的边界问题；运行中返回 409。
- `GET /api/runs/:id/artifact-versions[/N]`：列出或下钻不可变成果快照；每个人工动作和来源更新推进版本。
- `GET /api/runs/:id/artifacts/:kind?version=N`：按版本下载 `REPORT_MD / REPORT_PDF / PPTX / EVIDENCE_JSON`。
- `GET/POST /api/settings/llm`：单 HTTPS 模型端点配置；密钥只以掩码返回，设置以 `0600` 原子落盘并优先于环境变量。
- `POST /api/sources/search`：选择 `bing / google / baidu`，只返回尚未成为证据的候选来源。

每个 Source 都带权威度、新鲜度、完整度与综合置信度。低置信度来源对 Conclusion 的折扣说明保存在证据图中，不会被静默抬高。

## 真实上传进入 COLLECT

上传和运行是两个明确动作：

```text
POST /api/uploads
POST /api/runs  { "researchQuestion": "...", "uploadIds": ["<upload UUID>"] }
```

服务端会重新验证上传记录、路径、普通文件属性、字节大小和 SHA-256，再由 `local-file-reader` 解析 PDF 页码、CSV 行列、XLSX 工作表/单元格或 TXT。上传内容身份为 `USER_UPLOAD`，不会自动视为权威事实。最多每次任务 8 个文件，单文件上限 5 MiB，仅允许 PDF/CSV/XLSX/TXT。

## 真实搜索与权威核验

- `POST /api/sources/search`：按 Bing、Google 或百度的固定域名发起一次搜索；只允许 HTTP/HTTPS，在请求前校验端口、凭据、精确 host 及 DNS 返回的每个地址，拒绝环回、私有、保留地址和重定向越界。
- `POST /api/sources/live-search`：固定使用一个 MediaWiki API，只输出 `CANDIDATE_SOURCE`，不自动成为权威证据。
- `POST /api/sources/live-check`：只访问四个白名单 URL，校验主机、重定向、类型、大小、错误页、关键内容和 SHA-256；局部失败保持失败。
- 离线黄金任务仍只消费本地快照，因此现场断网不影响核心流程。

最新真实联网结果见 [实时信源验证记录](docs/verification/LIVE-SOURCE-VERIFICATION-2026-08-27.md)。

## 核心数据合同

运行对象使用 Zod 锁定以下实体及交叉引用：

`SourceVersion / Source / Locator / Evidence / Datum / Assumption / Claim / EvidenceGap / Conclusion / CandidateRevision / AuditFinding / HumanDecision / ArtifactVersion`

状态轴相互独立：

- 知识类型：`FACT / SOURCE_OPINION / CALCULATION / ESTIMATE / FORECAST`
- 责任来源：`SOURCE_EXTRACTED / DETERMINISTIC / AI_JUDGMENT / HUMAN_EDITED`
- 证据状态：`SUPPORTED / CONFLICT / INSUFFICIENT_EVIDENCE`
- 审阅状态：`PENDING_REVIEW / HUMAN_CONFIRMED / HUMAN_REJECTED / NEEDS_REVIEW`
- 新鲜度：`CURRENT / STALE`

人工 `EDIT` 只创建 `HUMAN_EDITED` 修订并保持待复核；`CONFIRM` 是独立动作。冲突、估算和预测的确认必须记录理由及适用范围。证据不足或过期内容不能确认。

## 当前前端交接项

后端合同已完成，但当前 `public/` 由 ABloom 负责，仍需按 [前端需求书](docs/FRONTEND-REQUIREMENTS.md) 收口：

- 上传成功后保存 upload ID，并在运行任务时通过 `uploadIds` 传入；当前页面只完成上传闭环，没有把 ID 带入任务。
- 把“保存并确认”拆成“保存修订”和单独“确认”；当前后端已禁止编辑自动确认，但旧按钮文案仍会误导。
- 为冲突、估算和预测确认补充“理由”和“适用范围”输入。
- 展示 `originType`、规范化证据/审阅/新鲜度轴及 ArtifactVersion 历史入口。
- 接入可选的实时搜索入口；权威核验入口已存在。

在这些前端项完成前，不应声称 12 条 P0 全部通过。

## 后端测试门禁

`npm run coverage` 使用 c8 对 `src/**` 执行全量测试并强制行覆盖率与分支覆盖率均为 100%。当前 Path 1–6 各有一个显式攻击用例，覆盖边界 preset 泄漏、失败伪成功、非法确认、未完成边界输出、旧版本改写和 DNS rebinding 请求前阻断。

## 文档入口

总入口：[产品文档索引](docs/DOCUMENT-INDEX.md)。核心文档包括：

- [PRD](docs/PRD.md)
- [开发范围](docs/DEVELOPMENT-SCOPE.md)
- [开发路径](docs/DEVELOPMENT-ROADMAP.md)
- [前端需求书](docs/FRONTEND-REQUIREMENTS.md)
- [研究对象模型](docs/RESEARCH-OBJECT-MODEL.md)
- [黄金案例规格](docs/GOLDEN-CASE-SPEC.md)
- [P0 验收矩阵](docs/P0-ACCEPTANCE-MATRIX.md)

## 权限与发布状态

工作只存在于本地隔离 worktree，基线 commit 为 `2113f1091c4e5dbacc5b828013f0ff62514fbd9e`。没有执行 commit、push、PR、Git Tag、部署、数据库迁移、生产配置变更或真实用户数据操作。公开部署需要新的明确授权，并且不能直接暴露当前单用户 loopback 服务。
