# InsightForge

> 当前状态（2026-08-29）：后端纵向切片已实现；本地 163/163 Node 测试、`src/**` 四项覆盖率 100%、23/23 契约、694,100 例 fuzz、非默认端口 Playwright E2E 1/1、smoke、三连演示和 175 文件密钥扫描通过，依赖审计为 0 漏洞；前端仍由 ABloom 独立完善。最终源码 ZIP 仍须在干净解压目录重跑同一组门禁。本轮后端收口已提交并推送至 `main`；未打 Tag、创建 PR 或部署。

当前量化基线：Node 测试 163/163；seeded fuzz 694,100 例。

`从一个行业问题，到一份能下钻、能质疑、能更新的研究成果。`

InsightForge 用同一个软件作品响应两个命题：

- 商汤小浣熊“AI，不止完成一步”：一个任务经过 `PLAN → COLLECT → SYNTHESIZE → AUDIT → DELIVER`，真实调用搜索/快照、PDF/本地文件、表格计算、模型候选和 PPTX 工具。
- 沙利文“PROOF OF INSIGHT”：研究问题、信源、版本、证据、数据、假设、候选判断、审查、人类决定与成果版本形成可校验的证据图。

默认黄金案例不需要网络或密钥。PLAN 与 SYNTHESIZE 消费经过 SHA-256、问题域、Schema、工具白名单、证据 ID、假设 ID 和关键数值校验的模型缓存；页面明确显示“使用缓存快照”，不会冒充本轮实时模型调用或实时搜索。

## 环境要求

- Node.js `^20.19.0 || ^22.12.0 || >=23`（与当前 c8/pdfjs 依赖树的实际 engines 一致）
- npm（随 Node.js 安装）
- Chromium 仅在运行 Playwright E2E 时需要；首次执行 E2E 前运行 `npx playwright install chromium`

项目不需要数据库。运行状态、上传和成果只写入项目下的 `.insightforge/`，服务端强制仅监听 loopback。

资源边界：最多同时执行 2 个研究任务；第 3 个请求返回 `429 RUN_CAPACITY_EXCEEDED`。内存 job、progress 文件与完整 run/artifact 目录只保留最近 10 个，清理时保护当前运行和执行中任务；每个 run 内的成果版本仍独立遵守 V1–V5 上限。
SSE 进度流每个任务最多 4 个订阅、全局最多 6 个；超限返回 `429 SSE_CAPACITY_EXCEEDED`，连续 60 秒没有新的步骤或工具事件时发送 `stream-end` 并要求客户端重连，后台任务不受影响。

测试、覆盖率与 fuzz 命令由 Node runner 设置隔离环境并显式枚举文件，不使用 POSIX 内联环境变量或 shell glob，可在上述受支持 Node 版本的 Windows `cmd.exe`、macOS 与 Linux 下采用同一 npm 命令。Node 20.0–20.18 不在支持范围内，因为当前 c8/pdfjs 依赖树要求更高的 20.x 补丁版本。

## 从干净目录运行

```bash
npm ci
npm run verify
npm run contract:check # 可单独重跑；verify 已强制包含此项
npm run fuzz # 可单独重跑；verify 已强制包含此项
npm run test:e2e
npm run demo:triple
npm run smoke
npm audit --audit-level=high
```

生成经过密钥扫描、排除依赖/构建/运行/浏览器状态的源码 ZIP（输出必须在仓库外）：

```bash
npm run package:source -- /absolute/path/InsightForge-source.zip
```

命令同时生成 `InsightForge-source.zip.manifest.json`，记录基线 commit、ZIP 大小、SHA-256、文件数和排除规则。源码包排除可再生成或单独提交的 `demo-assets/`、`docs/assets/` 展示资产，但保留离线运行所需的 `fixtures/golden/` 输入。

生产启动（`prestart` 会先完成生产构建，干净克隆不要求手工生成 `dist/`）：

```bash
npm start
```

构建会把 UI、黄金案例 fixtures 与最小 ESM 运行清单一并写入 `dist/`。`dist/server.js` 从自身模块位置解析这些必需资产，不依赖启动命令的当前目录；启动监听前会检查全部 UI/黄金文件，缺失时直接报错退出，不会出现 `/api/health` 正常但页面或 COLLECT 延迟失败的半可用状态。项目内标准构建的 `.env` 与 `.insightforge/` 仍位于仓库根目录。

默认地址：<http://127.0.0.1:4399>。打开页面后点击“运行黄金案例”即可执行完整五状态任务，不需要手改 JSON、数据库或源码。

开发模式：

```bash
npm run dev
```

## 配置

离线黄金案例不需要创建 `.env`。如需覆盖本地监听、DNS 或在线模型配置，可复制示例后编辑：

```bash
cp .env.example .env
```

`npm start` 与 `npm run dev` 会在读取 `HOST`、`PORT`、`INSIGHTFORGE_LLM*` 等设置前加载项目根目录的 `.env`；已由宿主环境导出的同名变量优先。`.env` 缺失时正常使用安全默认值，文件存在但不可读时启动会明确失败。

可选在线模型路径要求同时设置：

```text
INSIGHTFORGE_LLM=1
INSIGHTFORGE_LLM_API_KEY=...
INSIGHTFORGE_LLM_BASE_URL=https://...
INSIGHTFORGE_LLM_MODEL=...
# 可选；默认分别为 8192 / 16384，合法范围 256–32768
INSIGHTFORGE_LLM_PLAN_MAX_TOKENS=8192
INSIGHTFORGE_LLM_SYNTHESIS_MAX_TOKENS=16384
```

该路径只允许一个 HTTPS Chat Completions 端点，不路由多模型、不自动 fallback；端点必须接受项目当前使用的 `max_tokens` 与 JSON Object 请求字段。推理模型的隐藏推理和可见 JSON 可能共享输出预算，因此默认 PLAN/SYNTHESIZE 预算为 `8192/16384`；低输出上限端点可通过上述环境变量或 `/api/settings/llm` 的同名 camelCase 字段覆盖，API 设置整体优先于环境变量。无效预算 fail-closed，实际使用值写入 `modelProvenance`。问题与经最小化的信源标题、证据摘录、定位类型、Datum/公式以“未受信任 JSON 数据”发送；完整 URL、publisher、本地路径、上传文件名/哈希、人工决定和成果字节不会发送。每个 run 的 `modelProvenance.dataDisclosure` 记录实际发送阶段、字段、截断上限和省略字段；低匹配任务若只调用了在线 PLAN，会明确写出“未发送 SYNTHESIZE”。来源中的指令没有优先级。明显注入指令回声、Schema 错误、超长字段或未知 evidence ID 会使含问题的单条候选整体丢弃，绝不删除坏字段后部分放行；其他独立候选仍逐条校验，过滤后少于 3 条才阻断整个 SYNTHESIZE。缺配置、网络失败和重复候选导致有效候选不足同样 fail-closed。任何密钥只存在于运行环境，不得提交。

## 一键演示会发生什么

1. `PLAN`：模型缓存提出五步计划，程序校验工具 allowlist 和 Audit/Deliver 锚点。
2. `COLLECT`：读取明确标记的搜索快照、逐页 PDF 和 CSV v1，保留 URL、页码、列名与行号。
3. `SYNTHESIZE`：模型缓存提出 4 条候选；程序校验证据、假设和数字，所有候选保持待复核。
4. `AUDIT`：执行六类输入驱动规则；真实引用 ID 还要通过词项/百分比语义一致性门槛，链接预先存在的估算假设，保留口径冲突，因果判断保持 `INSUFFICIENT_EVIDENCE`；最多自动修复一次。
5. `DELIVER`：从同一证据快照生成 Markdown、可解析 PDF、五页可编辑 PPTX 与机器可读证据 JSON；交互式报告由当前页面提供。PDF 使用确定性的纯 Node CID/ActualText 路径，不启动浏览器，也不依赖 Python/ReportLab。

演示内置 v1→v2 来源变化：相关 Datum/Claim/Conclusion 和人工确认失效，不相关结论保持不变，重算后生成新 `ArtifactVersion`，旧 MD/PDF/PPTX/JSON 不覆盖并可按版本下载。

认证模型缓存与黄金案例 v1 快照精确绑定。正常的 v2 演示必须先运行 v1，再调用 `applySourceUpdate`；直接调用 `runGoldenCase({ sourceVersion: "v2" })` 时若保留默认 `llmMode: "cached"` 会在创建运行目录前给出明确拒绝。仅确定性分支测试可显式使用 `llmMode: "off"` 创建全新 v2 运行。

## 0828 后端接口

- `GET /api/health`：服务与默认离线模式健康状态。
- `GET /api/current`：当前完整运行；尚无运行时返回 404。
- `GET /api/runs/:id`：任务状态、五步进度及完成后的运行对象。
- `GET /api/runs/:id/events`：SSE 步骤、工具、心跳和终态流。
- `POST /api/runs/:id/decisions`：确认、驳回或编辑候选结论。
- `POST /api/runs/:id/source-update`：用于内置黄金问题一次性 v1→v2 更新；缓存模型和在线单端点模型运行都由后端沿实际 Evidence→Datum→Claim→Conclusion 依赖图确定受影响对象、撤销相关确认并持久化新成果版本，前端不保存影子状态。
- `GET /api/presets`：固定返回 1 个黄金案例和 2 个诚实失配案例。
- `GET /api/runs/:id/boundary-questions`：完成后返回 3 个可追溯到 EvidenceGap 的边界问题；运行中返回 409。
- `GET /api/runs/:id/artifact-versions[/N]`：列出或下钻不可变成果快照；每个人工动作和来源更新推进版本。
- `GET /api/runs/:id/artifacts/:kind?version=N`：按版本下载 `REPORT_MD / REPORT_PDF / PPTX / EVIDENCE_JSON`。
- `GET/POST /api/settings/llm`：单 HTTPS 模型端点配置；POST 接受 `baseUrl / model / apiKey` 及可选整数 `planMaxTokens / synthesisMaxTokens`（256–32768，默认 8192/16384）；key、base URL 与 model 只以掩码返回，非敏感预算原值返回，设置以 `0600` 原子落盘并整体优先于环境变量。
- 所有写请求默认要求服务端随机 request key，并校验 `Origin` / `Sec-Fetch-Site`；首页会在不改前端源码的情况下通过 CSP nonce 引导脚本自动加上 `x-insightforge-request-key`。仅本地调试可显式设置 `INSIGHTFORGE_DISABLE_REQUEST_KEY=1` 关闭，禁止用于共享或不可信网络。
- 服务端把 `Host` 固定为回环 IP 与实际监听端口；若配置 `HOST=localhost`，启动前先验证全部 DNS 答案都是回环地址并绑定其中一个字面 IP，拒绝未验证的 `localhost` Host 和 DNS rebinding 形式的非回环 Host。
- 运行模式标签来自 `synthesisMode`：在线单端点模型不会再被标成“使用缓存快照”，同时会诚实保留“信源使用缓存快照”的来源边界；该状态同步进入 API、JSON 和 PPTX。
- `POST /api/sources/search`：选择 `bing / google / baidu`，只返回尚未成为证据的候选来源。

每个 Source 都带基于域名、时效与定位完整度的静态启发式分数。它不是第三方真实性认证，也不是统计置信区间；低分来源对 Conclusion 的折扣说明保存在证据图中，不会被静默抬高。

## 真实上传进入 COLLECT

上传和运行是两个明确动作：

```text
POST /api/uploads
POST /api/runs  { "researchQuestion": "...", "uploadIds": ["<upload UUID>"] }
```

服务端会重新验证上传记录、路径、普通文件属性、字节大小和 SHA-256；COLLECT 再读取一次字节、核对摘要，并让 `local-file-reader` 解析同一份内存字节，避免校验后替换文件。PDF 最多解析 100 页，CSV 保留逻辑行，XLSX 按数值工作表顺序保留工作表/单元格，TXT 保留文件定位。上传内容身份为 `USER_UPLOAD`，不会自动视为权威事实。黄金任务内置 5 个信源，因此每次任务最多再接收 5 个互不重复的上传 ID，任务总信源硬上限为 10；单文件上限 5 MiB，仅允许 PDF/CSV/XLSX/TXT。上传存储同时受 20 个对象、32 MiB 聚合上限和 24 小时 TTL 约束；并发写串行检查，过期文件与记录成对删除，超额请求返回 413。

## 真实搜索与权威核验

- `POST /api/sources/search`：按 Bing、Google 或百度的固定域名发起一次搜索；只允许 HTTP/HTTPS，在请求前校验端口、凭据、精确 host 及 DNS 返回的每个地址，拒绝环回、私有、保留地址和重定向越界。解析链依次尝试固定 HTTPS DoH、宿主机 DNS、固定 `1.1.1.1:53`，结果返回 `dnsResolution` 留痕；三跳分别由 `INSIGHTFORGE_DNS_DOH`、`INSIGHTFORGE_DNS_SYSTEM`、`INSIGHTFORGE_DNS_UDP53` 的 `0/1` 值启停，默认均启用，全部关闭会 fail-closed。任一跳返回危险地址会立即阻断，不会靠后续解析器“洗白”。该实现仍是 DNS 预检，不是 IP 固定连接；默认 `fetch` 的再次解析仍存在 DNS TOCTOU/重绑定残余风险，因此不能直接暴露到不可信网络。
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

`npm run verify` 强制串行执行生产源码及全部 unit/fuzz/E2E TypeScript 的严格类型检查、覆盖率、生产构建、密钥扫描、`npm run contract:check` 和确定性 fuzz；不能靠人工记忆补跑其中任何一项。契约自检启动临时 loopback 服务，真实调用 SSE、上传、搜索候选、五状态任务、人工决定、来源更新、版本链及四格式下载。`npm run coverage` 使用 c8 对 `src/**` 执行全量测试，并对 statements、branches、functions、lines 四项都强制 100%。密钥扫描同时遍历工作区文件，因此 Git 忽略的 `.env` 也会触发失败。当前 Path 1–6 各有一个显式攻击用例，覆盖边界 preset 泄漏、失败伪成功、非法确认、未完成边界输出、旧版本改写和混合公网/私网 DNS 响应的请求前阻断。该用例不等同于消除出站 `fetch` 的 DNS TOCTOU。

`npm run clean` 会删除 `dist/`、覆盖率、Playwright 证据以及本地 `.insightforge/` 运行状态；需要保留的成果请先复制到仓库外。

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

本轮后端收口已获授权提交并推送 `main`。没有创建 PR、Git Tag、部署、数据库迁移、生产配置变更或真实用户数据操作。公开部署需要新的明确授权，并且不能直接暴露当前单用户 loopback 服务。
