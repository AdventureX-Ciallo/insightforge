# 独立测试结果

> 状态：`CURRENT — 2026-08-28`。这是本地后端与交付物证据，不代表前端、Windows PowerPoint 或公开部署已经完成。

## 当前工作树门禁

| 命令 | 结果 |
|---|---|
| `npm test` | PASS：91/91（85 个顶层测试，Path 1–6 矩阵含 6 个子测试） |
| `npm run coverage` | PASS：`src/**` 语句/分支/函数/行均 100% |
| `npm run verify` | PASS：类型检查、100% 覆盖率门禁、生产构建、密钥扫描 |
| `npm run test:e2e` | ENV BLOCKED：重试 2 次，Chromium 均在断言执行前因 `MachPortRendezvousServer … Permission denied (1100)` 退出；此前有 1/1 通过记录，但不作为本轮新鲜 PASS |
| `npm run demo:triple` | PASS：3/3；400/113/106 ms，均完成五状态、6 个工具事件、4 条候选、1 次 Repair 与四格式交付 |
| `npm run smoke` | PASS：生产构建服务、健康页与产品页 |
| `npm run secret-scan` | PASS：223 个 tracked/untracked 文件，无凭据文件或常见 token 形状 |
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

以上 36/36 是扩展到当前 91 条测试前的历史预检记录，不替代本轮门禁。最新 ZIP 的名称、大小、SHA-256、基线 commit 与状态摘要保存在 ZIP 旁的 `.manifest.json`；最终报告只引用实际生成后的值。

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
| Path 6 更新 | DNS 同时返回公网与环回地址 | 搜索在 fetch 前拒绝，fetch 调用数为 0 |

物理行统计口径为 `src/**/*.ts` 与 `tests/**/*.ts` 的 `wc -l`：生产 5,019 行，测试 3,095 行，测试/生产为 0.617:1（61.7%）。

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

在线单一提供方搜索已真实成功；固定白名单核验为 2/4 内容校验成功、2/4 如实失败。离线黄金案例仍只消费明确标记的快照。公开部署未获授权，也未执行。
