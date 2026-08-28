# 独立测试结果

> 状态：`CURRENT — 2026-08-28`。这是本地后端与交付物证据，不代表前端、Windows PowerPoint 或公开部署已经完成。

## 当前工作树门禁

| 命令 | 结果 |
|---|---|
| `npm test` | PASS：94/94（88 个顶层测试，Path 1–6 矩阵含 6 个子测试） |
| `npm run coverage` | PASS：`src/**` 语句/分支/函数/行均 100% |
| `npm run verify` | PASS：类型检查、100% 覆盖率门禁、生产构建、密钥扫描 |
| `npm run fuzz` | PASS：seed `520628262`，六套累计 522,030 例；5,138 行源码对应 101.60 例/行；结构套件含至少 6,000 次完整图单边变质 |
| `npm run fuzz:report` | PASS：同 seed 522,030 例，13.822 s；JSON 写入 `.insightforge/fuzz-report.json`（0600） |
| `NODE_ENV=test node --import tsx --test tests/sse.test.ts` | PASS：2/2；真实 ReadableStream、心跳、终态关流、断开清理与跨 run 隔离 |
| `npm run test:e2e` | PASS：1/1；真实 Chromium 入口完成黄金任务、审阅、来源更新和成果检查，4.3 s；等待真实写响应，避免假阳性 |
| `npm run demo:triple` | PASS：3/3；441/95/89 ms，均完成五状态、6 个工具事件、4 条候选、1 次 Repair 与四格式交付 |
| `npm run smoke` | PASS：生产构建服务、健康页与产品页 |
| `npm run secret-scan` | PASS：234 个 tracked/untracked 文件，无凭据文件或常见 token 形状 |
| `npm run package:source -- /tmp/InsightForge-source-0828.zip` | PASS：仓库外生成 ZIP 与 manifest；实际大小、文件数和 SHA-256 以同轮 manifest 为准 |
| `npm audit --audit-level=high` | PASS：0 vulnerabilities |

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

以上 36/36 是扩展到当前 94 条测试前的历史预检记录，不替代本轮门禁。最新 ZIP 的名称、大小、SHA-256、基线 commit 与状态摘要保存在 ZIP 旁的 `.manifest.json`；最终报告只引用实际生成后的值。

## 关键反证

- 无关光伏问题不会泄漏新能源车固定结论，只产生与新问题对应的 `EvidenceGap`。
- 模型缓存只接受精确黄金问题、正确提示词/文件摘要、已知证据/假设 ID 和当前确定性数值；篡改会失败。
- 为证据不足 Claim 补入有效结构化证据后，Audit 结果会变化；未知引用会被移除或被 Schema 拒绝。
- 合法上传 ID 在同一运行的 COLLECT 中被 `local-file-reader` 消费；真实 XLSX 单元格、PDF 页、CSV 行列均可定位。
- PDF 中的中英文提示词注入只作为来源材料，不改变计划、不读取环境变量、不增加工具、不成为确认结论。
- v1→v2 只让依赖对象 stale，撤销相关确认并生成新 ArtifactVersion；无关结论和旧成果保持。
- EDIT 只产生 `HUMAN_EDITED` 修订并保持待复核；CONFIRM 独立执行。

## Path 1–6 对抗矩阵

| 用户路径 | 攻击输入 | 可证伪断言 |
|---|---|---|
| Path 1 首页 | 运行两个非黄金 preset | 必须进入失配综合、全部证据不足，且不得复制黄金答案 |
| Path 2 进度 | 在 SYNTHESIZE 注入失败 | 当前节点 failed，后续节点全部保持 pending |
| Path 3 审查 | 伪造确认 INSUFFICIENT/STALE 结论 | 两类确认均抛错，不产生 HUMAN_CONFIRMED |
| Path 4 边界 | 运行尚未完成时请求边界问题 | 返回 409，不伪装为完成结果 |
| Path 5 交付 | 人工动作后重读 V1，并请求 V999 | V1 内容快照不变（仅 CURRENT→SUPERSEDED）；V999 返回 404 |
| Path 6 更新 | DNS 预检同时返回公网与环回地址 | 搜索在 fetch 前拒绝，fetch 调用数为 0；不据此声称消除再次解析的 TOCTOU |

物理行统计口径为 `src/**/*.ts` 与 `tests/**/*.ts` 的 `wc -l`：生产 5,138 行，测试 3,841 行，测试/生产为 0.748:1（74.8%）。这与“随机执行用例/生产源码行”100:1 是不同指标。

## P4 SSE 与随机测试证据

- SSE：`GET /api/runs/:id/events` 返回 `text/event-stream`；真实 Node `fetch` 流消费看到了五阶段 running/success 迁移、工具事件、心跳与 terminal。两个并发 run 的每条 data 都携带各自 runId，未串流；主动 abort 后订阅数由 1 归零，原 run 仍完成且轮询端点返回完整 run；完成后重连会回放步骤/工具快照并立即终态关流。
- seeded fuzz 默认根 seed 为 `520628262`，失败会打印 suite seed。机器报告记录各 suite 的派生 seed、用例数、耗时与不变量。

| 随机套件 | 用例数 | 实测耗时 | 可证伪不变量摘要 |
|---|---:|---:|---|
| 引擎随机走查 | 30 | 0.687 s | 注入失败传播；终态三选一；步骤消费链不断 |
| ResearchRun 结构模糊 | 152,000 | 8.958 s | 合法图通过；递归畸形/类型污染拒绝；≥6,000 个完整图单边变质 fail-closed |
| HTTP API 模糊 | 5,000 | 1.218 s | 随机方法/路径/长输入/编码/NUL 不返回 5xx；服务保持健康 |
| 审计变质 | 100,000 | 0.935 s | 删引用降级；同期间异值冲突；数值/类型变化改变输出 |
| 上传模糊 | 165,000 | 1.230 s | 白名单外与穿越拒绝；随机字节失败有类型；成功文件 0600 |
| SSRF 预检随机 | 100,000 | 0.749 s | 保留段/环回/畸形目标全部拒绝；fetch 调用数始终为 0 |
| **合计** | **522,030** | **13.822 s** | **目标 513,800；达到 101.60 例/源码行** |

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

在线单一提供方搜索已真实成功；固定白名单核验为 2/4 内容校验成功、2/4 如实失败。离线黄金案例仍只消费明确标记的快照。公开部署未获授权，也未执行。
