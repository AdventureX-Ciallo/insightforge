# GitHub issues #6–#41 本地解决审计

> 状态：`CURRENT — 2026-08-29`。审计对象是 `AdventureX-Ciallo/insightforge` 当前后端收口提交。本文不代表远端 issue 已关闭；本轮获授权直接提交并推送 `main`，没有 PR、Tag 或部署，也没有修改 `public/`。

## 逐号结果

| Issue | 本地解决方式 | 直接回归证据 |
|---:|---|---|
| #6 | SYNTHESIZE 提交 `structuredClone` 的不可变 `synthesisOutput`；Schema 从该快照复算 `outputId`，Audit 只改后续图。 | `src/engine.ts`、`src/domain.ts`；`workflow.test.ts`、`domain-graph-adversarial.test.ts` |
| #7 | `researchRunSchema.superRefine` 校验五步顺序、成功输出、前序消费链及失败/待执行状态。 | `src/domain.ts`；`domain-graph-adversarial.test.ts` |
| #8 | 原始与规范化证据/审阅轴、STALE/freshness 及确认状态交叉校验，伪造矛盾图拒绝。 | `src/domain.ts`；`domain-graph-adversarial.test.ts`、`human-update.test.ts` |
| #9 | 最终确认/驳回拒绝重复执行和跨终态翻转；只有 EDIT 显式重开审阅。 | `src/human-decision.ts`；`human-update.test.ts`、`human-decision.fuzz.ts` |
| #10 | 默认缓存 v2 在创建运行目录前返回明确的 v1→v2 操作说明。 | `src/engine.ts`；`engine-branches.test.ts` |
| #11 | 失配运行只保留问题—语料匹配 Datum，不携带黄金 EV 计算行。 | `src/synthesis.ts`；`generalization.test.ts`、`user-path-adversarial.test.ts` |
| #12 | `OTHER` 来源无论定位完整度都留下明确折扣说明。 | `src/source-confidence.ts`；`source-confidence.test.ts` |
| #13 | XLSX 逐 `<c>` 单元格解析，空/样式单元格不能借用邻格值，并解码 XML 实体。 | `src/tools/local-file-reader.ts`；`tool-branches.test.ts` |
| #14 | Markdown 对 `<`、`>` 与其余控制标点逐字符转义，原始 HTML 不能形成标签。 | `src/tools/report-export.ts`；`report-export.test.ts` |
| #15 | 五结论版使用紧凑布局；测试检查第 5 条文字、来源与分隔线均在画布内。 | `src/tools/pptx-export.ts`；`tool-branches.test.ts` |
| #16 | 来源页以两列展示完整 10 个允许来源，不再静默 `slice(0, 5)`。 | `src/tools/pptx-export.ts`；`tool-branches.test.ts` |
| #17 | 搜索、单提供方、权威核验与 DoH 共用流式限长读取，首个超限块即 cancel。 | `src/tools/limited-response.ts`、搜索工具；`search-branches.test.ts`、`live-source-check.test.ts` |
| #18 | XLSX 中央目录在解压前限制条目数、单条与总解压大小，读取路径复用同一校验。 | `src/tools/xlsx-container.ts`；`upload.test.ts` |
| #19 | 独立 RFC 4180 tokenizer 支持引号逗号、转义引号、CRLF 与嵌入换行，定位使用逻辑行。 | `src/tools/csv-parser.ts`、`local-file-reader.ts`；`tool-branches.test.ts` |
| #20 | `current.json`、run 与 progress 使用同目录临时文件+原子 rename；启动从最新有效 run 恢复并修复 current。 | `src/atomic-file.ts`、`src/artifacts.ts`、`src/server.ts`；`server.test.ts`、`tool-branches.test.ts` |
| #21 | 引入带状态码/代码的 `DomainError`，非法决定、未知对象、重复/失配更新映射到具体 4xx 并保留安全消息。 | `src/domain-error.ts`、`src/server.ts`、决定/更新模块；`server-errors.test.ts`、`human-update.test.ts` |
| #22 | Artifact stream 在 pipe 前注册 error 边界；读取竞态只终止该响应，服务保持健康。 | `src/server.ts`；`server-errors.test.ts` |
| #23 | SSE 写入/关流统一 fail-soft，响应 error、同步 throw、关闭竞态只移除订阅，不污染 run。 | `src/server.ts`；`sse.test.ts`、`server-errors.test.ts` |
| #24 | 启动时加载可选 `.env`，宿主环境优先；缺失正常，存在但不可读/非法时明确失败。 | `dotenv`、`src/server.ts`；`server-errors.test.ts` |
| #25 | 运行资产从模块位置解析；构建复制 UI/fixtures，启动前完整性检查，dist 服务静态页且不依赖 cwd。 | `src/main-module.ts`、`src/server.ts`、`scripts/copy-static.mjs`；`server-errors.test.ts`、smoke |
| #26 | Node runner 设置环境并显式枚举测试，不使用 POSIX 内联 env 或 shell glob。 | `scripts/test-command.mjs`、`package.json`；`gate-scripts.test.ts` |
| #27 | 同时运行上限 2、保留上限 10；jobs/progress/run/artifact 成对淘汰并保护当前/运行中对象。 | `src/run-retention.ts`、`src/server.ts`；`run-retention.test.ts` |
| #28 | SSE 每 run 4、全局 6、业务空闲 60 秒关流；断连/超限/超时不取消后台任务。 | `src/server.ts`；`sse.test.ts` |
| #29 | 上传 20 对象、32 MiB、24 小时 TTL；并发配额串行，记录/文件/孤儿/坏元数据均计费并成对清理。 | `src/upload-store.ts`；`upload-store.test.ts`、`server.test.ts` |
| #30 | 在线提示把问题和最小化来源字段放入“不受信任 JSON 数据”信封；注入回声确定性拒绝，并有完整 hostile live mock。 | `src/llm.ts`、`src/engine.ts`；`llm-branches.test.ts`、`security.test.ts` |
| #31 | Audit 增加显著词项与百分比矛盾检查，不再因 ID 存在就授予 SUPPORTED，也不自动链接无关 Datum。 | `src/audit.ts`、`src/synthesis.ts`；`audit-input.test.ts` |
| #32 | PLAN/SYNTHESIZE 分别哈希实际发送的完整 `messages` JSON；provenance 与 mock 观测哈希逐字相等。 | `src/llm.ts`、`src/engine.ts`；`llm-settings.test.ts` |
| #33 | `verify` 强制运行 contract harness；当前逐端点结果 23/23。 | `package.json`、`scripts/contract-check.mjs`；`gate-scripts.test.ts` |
| #34 | source ZIP 排除 `demo-assets/` 与 `docs/assets/`，保留可执行黄金 fixtures，并在 manifest 记录。 | `scripts/package-source.mjs`；`gate-scripts.test.ts` |
| #35 | 黄金 PDF 同时含中英文注入诱饵；计划、工具、环境访问、候选与确认状态均不受影响。 | `fixtures/golden/market-brief.pdf`；`security.test.ts` |
| #36 | 删除机器路径绑定的已提交 coverage 快照，忽略 `coverage-detail/`，门禁每次从当前源码重算四项 100%。 | `.gitignore`、`scripts/clean.mjs`；`gate-scripts.test.ts`、`npm run coverage` |
| #37 | `verify` 串行包含确定性 fuzz；失败时 aggregate gate 失败。 | `package.json`；`gate-scripts.test.ts` |
| #38 | `tsconfig.tests.json` 严格检查 unit、fuzz 与 E2E 源码，并被 `typecheck`/`verify` 强制执行。 | `tsconfig.tests.json`、`package.json`；`gate-scripts.test.ts` |
| #39 | 57 个 Minor 子项全部逐条处理；详见下节。 | 跨模块回归、159/159 Node 测试、E2E、contract、fuzz |
| #40 | 明确采用“含未知 evidence ID 的候选整条丢弃；独立候选继续；有效少于 3 条时 SYNTHESIZE 整体失败”；认证静态缓存更严格，任一未知引用使缓存失败。 | `src/llm.ts`、`src/model-cache.ts`、相关架构文档；`llm-synth.test.ts`、`llm-branches.test.ts`、`model-cache.test.ts` |
| #41 | 测试文件由 Node API排序枚举，不依赖 shell glob；项目 engines 与实际 `c8` 依赖要求统一为 `^20.19.0 || ^22.12.0 || >=23`。 | `scripts/test-command.mjs`、`package.json`/lock；`gate-scripts.test.ts` |

## #39 的 57 个子项

### 领域与引擎（9/9）

- FAILED 半成品不伪造为完整 ResearchRun；失败节点持久化在 job/progress，并由 `STATE-MACHINE.md` 与恢复测试锁定。
- `failAt` 覆盖 PLAN/COLLECT/SYNTHESIZE/AUDIT/DELIVER，严格断言失败后节点保持 pending；删除空洞的 `>= 0`。
- 删除来源更新中的自赋值 no-op。
- v2 excerpt、哈希与 Datum inputs 均从 `market_v2.csv` 真实读取/重算。
- `researchSnapshotId` 每次决定/更新/产物写入前重算，Schema 与 ArtifactVersion 交叉校验。
- INSUFFICIENT Claim 必须关联同 Claim 的 EvidenceGap。
- 黄金确定性路径使用独立 `DETERMINISTIC_GOLDEN_RULES` 标签，不再冒充 mismatch。
- progress callback 失败不能覆盖原始 workflow error。
- `STATE-MACHINE.md` 已与 EDIT 保持 `PENDING_REVIEW`、需另行 CONFIRM 的实现一致。

### Synthesis / LLM（6/6）

- 已带 `/chat/completions` 的 base URL 不重复追加路径。
- 缓存数字一致性识别 `NOT 37.1%` 等否定上下文，不再只做裸 substring。
- 问题词项不再只取前 12 个，晚出现的关键域词参与匹配。
- 在线候选会根据关联冲突 Datum 预标 `CONFLICT`。
- PLAN 任一未授权/空步骤使整份计划失败，不做部分采纳。
- 文档明确：本地 cache manifest 的摘要一致性不是抵抗本机恶意修改者的签名认证。

### 工具（6/6）

- CSV 计算对除零、非有限值和缺年度 fail-closed。
- 超大 numeric HTML entity 安全替换，不触发 `RangeError`。
- PDF 解析上限 100 页。
- 文档明确 PPTX OOXML core properties 含墙钟时间，不承诺字节确定；每份实际产物仍有 SHA-256。
- XLSX 工作表按数值序号与 workbook 名称配对，不做字典序误排。
- 稀疏 PPTX 使用“数据缺失/无”等诚实 fallback，不渲染 `undefined`。

### Server / API（8/8）

- 重复 upload IDs 在任务入口返回 400。
- 每对 SOURCE_CONFLICT finding ID 唯一。
- COLLECT 对经验证上传再次读取同一内存字节并核对 SHA，替换竞态返回 409。
- `localhost` 只有在全部 DNS 答案均为 loopback 时才绑定其字面 IP。
- `artifact-versions/0` 等非法版本返回 400，不混作 404。
- 413 后 drain 请求体并关闭继续处理风险。
- run 完成写与人工决定/来源更新共用每 run 串行队列，`current.json` 不交错覆盖。
- 已知路径的不支持方法统一返回 405。

### 部署与可运维性（6/6）

- 真实端口占用返回友好 EADDRINUSE 错误，并有实际 listener 冲突测试。
- `bin` 指向生产 server 入口。
- `prestart`、`predemo`、`predemo:triple`、`presmoke` 与 contract 自构建消除干净克隆 foot-gun。
- 旧 `coverage-detail/coverage-final.json` 删除并忽略。
- 重启将可信 in-flight progress 转为显式失败恢复记录；非法/失配记录不恢复。
- 构建后的 `dist/public` 与黄金 fixtures 由 dist server 实际解析、检查并提供。

### OWASP / API（5/5）

- README 列出 health/current/run/SSE/decision/source-update 等正式端点。
- run ID 使用完整 `randomUUID()`。
- LLM key、base URL、model 均只返回掩码。
- live-check 与 source-update 消费并校验请求体边界。
- Artifact 下载带 `Cache-Control: no-store`。

### LLM 安全（4/4）

- low-fit auto 模式显式记录只调用 PLAN、未发送 SYNTHESIZE 及拒答原因。
- 每 run `dataDisclosure` 记录发送阶段、字段、截断和省略项；URL、publisher、本地路径、文件名/哈希、决定与成果不外发。
- 完整 hostile 上传摘录 live mock 验证模型服从注入时仍被程序拒绝，并核对真实 provenance。
- 候选先按标准化文本去重，再执行最多 5 条上限。

### 测试与门禁（13/13）

- E2E 下载并解析 PPTX，检查 5 页及可编辑画布对象。
- Playwright 从 `PORT` 构造 server 与 base URL；非默认 4497 已实测。
- fuzz 使用临时工作区并清理，不在仓库遗留 uploads。
- HTTP fuzz 超时放宽并保持进程健康断言。
- 删除 `app.stop()` 重复调用。
- 上传 SHA 测试比较独立读取字节与回执，不再自证。
- source-package 路径 guard 在 Windows 大小写语义下测试。
- secret scan 以文件系统 walk 补充 Git index，能发现被忽略的 `.env`。
- coverage 对 statements/branches/functions/lines 四项都以 100% 门禁。
- README 不再要求在 verify 后重复跑 coverage。
- demo、triple、smoke、contract 在无 dist 时各自构建并有实测。
- clean 覆盖 dist、coverage、coverage-detail、`.insightforge`、evidence、test-results 与 Playwright 产物。
- Playwright 不再硬编码 4399。

此外，`gate-scripts.test.ts` 作为额外防回归门禁，静态锁定上述跨平台脚本、构建前置、清理、扫描、coverage、contract、fuzz 与测试类型检查合同；写接口还额外实现了随机 request key、Origin/Sec-Fetch-Site 与 Host/端口边界。

## 当前独立验收

- `npm run verify`：159/159；`src/**` statements/branches/functions/lines 四项 100%；build；173 文件 secret scan；contract 23/23；seed `520628262` fuzz 685,000 例（6,840 行，100.15 例/行）。
- `npm run test:e2e`：1/1，5.9 s；真实 Chromium 与五页 PPTX 下载解析通过。
- `npm run demo:triple`：3/3，88/20/16 ms；`npm run smoke` PASS。
- `npm ls --all` PASS；`npm audit --audit-level=low` 为 0 vulnerabilities。
- 当前 Node `v22.17.0` 属声明支持范围。当前机器没有 Node 20.19+ 二进制，外部 npm/Docker 取包又被网络阻断，因此没有伪称已在真实 Node 20 主机执行；#41 的 shell 独立性由源码枚举、静态门禁与当前 Node 运行证明，最终干净包仍应在受支持 Node 20.19+ 环境补跑。
- 当前 worktree 未生成最终 ZIP；按所有者要求推迟至前端冻结后做双轮干净解包验收。旧 ZIP 哈希不能证明当前代码。
