# 独立测试结果

> 状态：`CURRENT — 2026-08-29`。这是本地后端与交付物证据，不代表前端、Windows PowerPoint 或公开部署已经完成。

## 当前工作树门禁

| 命令 | 结果 |
|---|---|
| `npm test` | PASS：158/158 |
| `npm run coverage` | PASS：`src/**` 语句/分支/函数/行均 100% |
| `npm run verify` | PASS：生产源码及 unit/fuzz/E2E 测试源码严格类型检查、当前源码四项 100% 覆盖率门禁、生产构建、密钥扫描、23/23 契约自检、确定性 fuzz；不使用已提交的机器路径 coverage 快照替代本轮输出 |
| `npm run fuzz` | PASS：seed `520628262`，七套累计 685,000 例；6,840 行源码对应 100.15 例/行；结构套件含输出链、状态轴与至少 6,000 次完整图单边变质，人工决定套件覆盖终态幂等性与 EDIT 重开，Audit 套件校验纯变换，SSRF 套件含 DNS 回退危险答案停止链不变量 |
| `npm run fuzz:report` | PASS：同 seed 685,000 例，26.082 s；JSON 写入 `.insightforge/fuzz-report.json`（0600） |
| `npm test -- --test-name-pattern SSE` | PASS：SSE 的真实 ReadableStream、心跳、终态关流、断开清理、写入竞态与跨 run 隔离；命令由跨平台 Node runner 枚举测试文件 |
| `npm run test:e2e` | PASS：1/1；真实 Chromium 完成黄金任务、审阅、来源更新和成果检查，并解析下载的 5 页 PPTX 及画布对象，测试体 2.2 s、命令总耗时 4.7 s；等待真实写响应，避免假阳性 |
| `npm run demo:triple` | PASS：3/3；88/20/16 ms，均完成五状态、6 个工具事件、4 条候选、1 次 Repair 与四格式交付 |
| `npm run smoke` | PASS：生产构建服务、健康页与产品页 |
| `npm run secret-scan` | PASS：172 个 tracked/untracked 且未被忽略的文件，无凭据文件或常见 token 形状 |
| `npm run package:source -- /tmp/InsightForge-source-0828.zip` | 当前工作树未执行：按所有者要求推迟到前端冻结；收口前旧包及 manifest 的 PASS 仅列于下节历史预检 |
| `npm audit --audit-level=low` | PASS：0 vulnerabilities |

## 此前干净源码包预检

源码打包器排除 `.git`、`node_modules`、`dist`、`.insightforge`、缓存、构建/测试产物、浏览器录制、日志、ZIP、`.env*`（仅保留 `.env.example`）及常见凭据文件，并拒绝符号链接。预检包解压到全新目录后执行：

```text
npm ci                         PASS; 0 vulnerabilities
npm run verify                 PASS; 36/36
npm run test:e2e               PASS; 1/1; 3.2 s
npm run demo:triple            PASS; 3/3; 219 ms / 19 ms / 16 ms
npm run smoke                  PASS
npm audit --audit-level=high   PASS; 0 vulnerabilities
```

以上 36/36 是扩展到当前 158 条测试前的历史预检记录，不替代本轮门禁。最新 ZIP 的名称、大小、SHA-256、基线 commit 与状态摘要保存在 ZIP 旁的 `.manifest.json`；最终报告只引用实际生成后的值。SHA-256 前缀 `30601c95` 的已验 ZIP 是本轮收口前基线，本节新增改动尚未重新打包，不能把旧哈希说成当前工作树哈希。

## 关键反证

- 无关光伏问题不会泄漏新能源车固定结论，只产生与新问题对应的 `EvidenceGap`。
- 模型缓存只接受精确黄金问题、正确提示词/文件摘要、已知证据/假设 ID 和当前确定性数值；篡改会失败。
- 为证据不足 Claim 补入有效结构化证据后，Audit 结果会变化；未知引用会被移除或被 Schema 拒绝。
- 合法上传 ID 在同一运行的 COLLECT 中被 `local-file-reader` 消费；真实 XLSX 单元格、PDF 页、CSV 行列均可定位。
- PDF 中的中英文提示词注入只作为来源材料，不改变计划、不读取环境变量、不增加工具、不成为确认结论。
- v1→v2 在缓存模型和在线单端点模型两种黄金问题运行中都由后端沿实际依赖图处理动态 ID：只让依赖对象 stale，撤销相关确认并生成新 ArtifactVersion；无关结论和旧成果保持，服务重启后 v2/失效决定/版本链均可恢复。
- 实时模型候选被 Audit 因语义不匹配降级时，程序会创建并连接机器可读 `EvidenceGap`；已有已解决缺口作为历史保留，重开的缺口使用新 ID，不再在最终 Schema 校验处崩溃。
- 来源更新只改变受影响结论的 freshness/review 轴，保留原有 `SUPPORTED`、`CONFLICT` 或 `INSUFFICIENT_EVIDENCE` 语义；更新文案不会加入该 Claim 未引用的 47.6% 对照数据。
- EDIT 只产生 `HUMAN_EDITED` 修订并保持待复核；CONFIRM 独立执行。
- `MAX_SOURCES=10` 同时作用于 Bing/Google/百度候选、单提供方搜索、离线快照和运行 COLLECT；第 11 条候选被截断，搜索响应与最终运行对象均记录发现数、保留数、截断数和 `MAX_SOURCES` 原因。完整运行反证使用 9 个网页候选加 PDF/CSV 形成 11 个总信源，最终保留 10 个且 COLLECT 摘要明确记录截断 1 个。

## Path 1–6 对抗矩阵

| 用户路径 | 攻击输入 | 可证伪断言 |
|---|---|---|
| Path 1 首页 | 运行两个非黄金 preset | 必须进入失配综合、全部证据不足，且不得复制黄金答案 |
| Path 2 进度 | 在 SYNTHESIZE 注入失败 | 当前节点 failed，后续节点全部保持 pending |
| Path 3 审查 | 伪造确认 INSUFFICIENT/STALE 结论 | 两类确认均抛错，不产生 HUMAN_CONFIRMED |
| Path 4 边界 | 运行尚未完成时请求边界问题 | 返回 409，不伪装为完成结果 |
| Path 5 交付 | 人工动作后重读 V1，并请求 V999 | V1 内容快照不变（仅 CURRENT→SUPERSEDED）；V999 返回 404 |
| Path 6 更新 | DNS 预检同时返回公网与环回地址 | 搜索在 fetch 前拒绝，fetch 调用数为 0；不据此声称消除再次解析的 TOCTOU |

物理行统计口径为 `src/**/*.ts`、`tests/**/*.ts` 与 `e2e/**/*.ts` 的 `wc -l`：生产 6,840 行，Node/fuzz 测试 6,604 行，测试/生产为 0.965:1（96.5%）；计入 97 行 E2E 后为 6,701/6,840 = 0.980:1（98.0%）。这与“随机执行用例/生产源码行”100:1 是不同指标。

## P4 SSE 与随机测试证据

- SSE：`GET /api/runs/:id/events` 返回 `text/event-stream`；真实 Node `fetch` 流消费看到了五阶段 running/success 迁移、工具事件、心跳与 terminal。两个并发 run 的每条 data 都携带各自 runId，未串流；主动 abort 后订阅数由 1 归零，原 run 仍完成且轮询端点返回完整 run；完成后重连会回放步骤/工具快照并立即终态关流。
- seeded fuzz 默认根 seed 为 `520628262`，失败会打印 suite seed。机器报告记录各 suite 的派生 seed、用例数、耗时与不变量。

| 随机套件 | 用例数 | 实测耗时 | 可证伪不变量摘要 |
|---|---:|---:|---|
| 引擎随机走查 | 30 | 0.531 s | 注入失败传播；终态三选一；步骤消费链不断 |
| ResearchRun 结构模糊 | 284,970 | 17.581 s | 合法图通过；步骤输出链、状态轴与递归畸形/类型污染拒绝；≥6,000 个完整图单边变质 fail-closed |
| 人工决定幂等性 | 1,000 | 0.839 s | 终态重复与跨终态翻转拒绝；EDIT 显式重开审阅 |
| HTTP API 模糊 | 5,000 | 1.090 s | 随机方法/路径/长输入/编码/NUL 不返回 5xx；服务保持健康 |
| 审计变质 | 104,000 | 3.749 s | 删引用降级；同期间异值冲突；数值/类型变化改变输出；输入 bundle 不被原地改写 |
| 上传模糊 | 165,000 | 1.145 s | 白名单外与穿越拒绝；随机字节失败有类型；成功文件 0600 |
| SSRF 预检随机 | 125,000 | 1.119 s | 保留段/环回/畸形目标全部拒绝；危险 DNS 答案停止回退链；fetch 调用数始终为 0 |
| **合计** | **685,000** | **26.082 s** | **目标 684,000；达到 100.15 例/源码行** |

## PPTX 独立验收

- 本轮最新 PPTX 由 JSZip 读取 5 个 slide XML 并检查文本节点；`unzip -t` 对完整 OOXML 包报告 `No errors detected`。当前沙箱同时阻断 Quick Look 初始化，因此没有把本轮 Quick Look 渲染记为 PASS。
- 当前生成文件：5 页，标题、正文、数字和来源编号均为 OOXML 文本元素。
- Microsoft PowerPoint for macOS：真实打开；对象模型读取 5 页及中文标题；修改 `PROOF OF INSIGHT` 为 `OFFICE EDIT CHECK`，保存、关闭、重开后修改仍存在。
- PowerPoint 自身导出 5 页 PDF，视觉检查中文、结论状态、公式、冲突、证据不足和来源页均正常。
- 当前有效原件：18,158 bytes，SHA-256 `61bd293855e99b0ebf565a1dcbb9d92ff2e17132cc3198250d87e82e78867ce3`。
- 编辑重开件：20,156 bytes，SHA-256 `27199f489a2183a83903d722fff65667c64457e89e8c9a94ca98708193b6381c`。
- PowerPoint 渲染蒙太奇：SHA-256 `964c99aabb88fe7bf7c93a550a3092b0c197a4ae0d5c4a7be2e38e6db3958b29`。

Windows 桌面 Microsoft PowerPoint 当前不可用，因此 Windows 专项打开、编辑、保存、重开仍未验证；本地 OOXML、Quick Look、LibreOffice 或 macOS PowerPoint 不能替代这项环境证据。

## 当前产品入口边界

后端上传→COLLECT、编辑/确认分离、理由/范围约束和历史成果接口已通过集成测试。ABloom 负责的当前 `public/` 尚未把上传 ID 带入运行、尚未拆开旧“保存并确认”交互，也未补理由/范围和成果历史展示，因此不声称 12 条 P0 全部完成。

本轮 E2E 曾复现人工编辑与来源更新并发写导致状态覆盖；服务端现按 `runId` 串行化写操作，API 回归会并发发送两项操作并断言最终同时保留人工修订和来源 v2。页面 E2E 也改为等待真实 HTTP 响应，避免用原本就存在的 `PENDING_REVIEW` 文本制造假通过。

历史记录中的单提供方搜索成功与固定白名单 2/4 成功，不替代下述 2026-08-28 当次环境实测。离线黄金案例仍只消费明确标记的快照。公开部署未获授权，也未执行。

## 2026-08-28 三搜索引擎真实只读实测

执行方式：直接调用产品函数 `searchSelectedEngine()`，使用默认 DNS resolver、默认 `fetch`、真实查询“中国新能源汽车 公共充电基础设施 2024 行业报告”；未注入模拟响应，未绕过 URL/host/DNS/SSRF 校验。三次调用均在请求网页前因本机 DNS 返回 RFC 2544 基准测试保留网段 `198.18.0.0/15` 而 fail-closed，因此没有到达搜索结果页，也没有可伪装为成功的挑战页。

产品函数原始结果（记录产生后，代码仅把该类拒绝的错误文案改为明确的 fake-IP 提示；没有重写这份历史原始输出，也没有放宽 SSRF）：

```json
[
  {
    "engine": "bing",
    "query": "中国新能源汽车 公共充电基础设施 2024 行业报告",
    "startedAt": "2026-08-28T04:31:29.948Z",
    "completedAt": "2026-08-28T04:31:29.961Z",
    "durationMs": 12,
    "outcome": "failure",
    "error": "Search target resolves to a private, reserved, or loopback address"
  },
  {
    "engine": "google",
    "query": "中国新能源汽车 公共充电基础设施 2024 行业报告",
    "startedAt": "2026-08-28T04:31:29.961Z",
    "completedAt": "2026-08-28T04:31:29.964Z",
    "durationMs": 3,
    "outcome": "failure",
    "error": "Search target resolves to a private, reserved, or loopback address"
  },
  {
    "engine": "baidu",
    "query": "中国新能源汽车 公共充电基础设施 2024 行业报告",
    "startedAt": "2026-08-28T04:31:29.964Z",
    "completedAt": "2026-08-28T04:31:29.967Z",
    "durationMs": 3,
    "outcome": "failure",
    "error": "Search target resolves to a private, reserved, or loopback address"
  }
]
```

同轮 DNS 原始观测（`2026-08-28T04:31:41.820Z`）：

```json
{"host":"www.bing.com","addresses":[{"address":"198.18.1.116","family":4}]}
{"host":"www.google.com","addresses":[{"address":"198.18.1.68","family":4}]}
{"host":"www.baidu.com","addresses":[{"address":"198.18.1.123","family":4}]}
```

结论：三引擎代码都经过了真实 DNS 路径，但本环境无法证明任一引擎取得真实候选；当前可验证的是安全边界按设计阻断保留地址。不得以单元测试或历史网络成功替代本轮失败。

## 2026-08-28 在线 LLM 环境检查

只检查进程环境变量是否存在，不读取或记录任何值，也不读取本地 settings 文件作为替代。原始结果：

```json
{
  "checkedAt": "2026-08-28T04:31:52.155Z",
  "presence": {
    "INSIGHTFORGE_LLM_API_KEY": false,
    "INSIGHTFORGE_LLM_BASE_URL": false,
    "INSIGHTFORGE_LLM_MODEL": false
  },
  "liveLlmConfigResolved": false,
  "outcome": "not-run-missing-environment-config"
}
```

结论：本轮没有环境 Key，故按要求未发起线上 LLM 请求；认证缓存和模拟测试均未被当作线上成功。线上 PLAN/SYNTHESIZE 成功仍是未关闭边界。

## 2026-08-28 DNS 三跳默认适配器实测

针对可配置 DNS 回退链直接调用产品函数 `resolveHostnameWithFallback("www.bing.com")`，没有注入 resolver，也没有发起搜索网页请求。`2026-08-28T08:26:54.410Z` 的默认链由第一跳固定 HTTPS DoH 成功返回 12 个公网 A/AAAA 地址，留痕为 `doh: success`、`addressCount: 12`；因此默认链按设计未继续调用后两跳。

随后分别只启用宿主机 DNS 与固定 `1.1.1.1:53` 适配器做同一主机解析。两次都收到 `198.18.0.0/15` fake-IP 代理保留段，产品原样返回“本机 DNS 返回 fake-IP 代理保留段，实时搜索需直连网络或调整代理模式，已 fail-closed 未发出请求”。这证明当前环境中两个适配器确实被调用且危险结果没有触发后续 fetch；它不证明这两个网络路径能在当前代理环境获得真实公网答案。

自动化证据：`tests/dns-fallback.test.ts` 覆盖 DoH → system → UDP/53 顺序、三个独立 `0/1` 开关、全部关闭、失败回退、危险答案立即阻断、固定 DoH/UDP 目标、响应大小与格式边界及 `dnsResolution` 留痕；当前全量 `npm test` 为 158/158，`npm run coverage` 四项 100%。
