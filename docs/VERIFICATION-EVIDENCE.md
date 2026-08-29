# 验证证据索引

> 状态：`CURRENT — 2026-08-29`。所有结论按“真实成功、真实失败、环境未具备”分开记录。

## 基线与变更边界

- 当前集成基于 ABloom 前端 PR #51 的合并提交 `a79a54424a31da3b318e3d1c8467e58311e25ced`，在隔离 worktree 完成后端运行时适配与全量复验。
- 前端交互与视觉保持 PR #51 版本；后端适配其 API、SSE、同源写边界、静态资源和空状态恢复合同。
- 运行时收口已通过 PR #53 合并；merge commit 为 `517f2c8b952878729aeb6fd4d7ecf9a31b7ba7c7`。
- 未打 Tag、部署、迁移数据库、修改线上配置或操作真实用户数据。

## 自动门禁

2026-08-29 在当前工作树执行的最新门禁：

```text
verify components              PASS; 197 top-level tests / 203 assertions; four coverage metrics 100%; React+backend build; clean source-tree secret scan 222 files; contract 25/25; fuzz 770,000
npm run test:e2e               PASS; 6/6 Chromium; full React/backend workbench contracts; 52.9 s
npm run demo:triple            PASS; 3/3; every run below 2 s
npm run smoke                  PASS; launched from a non-project cwd
production SIGTERM             PASS; graceful message; exit code 0
npm audit --audit-level=high   PASS after one registry retry; 0 vulnerabilities
```

最终实现改动后已分别重跑 `npm run verify` 的全部组成门禁；不把此前中途失败的 aggregate 进程写成一次新的 aggregate PASS。当前源码通过构建/类型检查、203/203 断言与四项 100% 覆盖率、清理后 222 文件密钥扫描、25/25 契约以及 seed `520628262` 的 770,000 例 fuzz；构建产物存在时的扩大扫描也曾覆盖 1,446 个文件并通过。

收口前旧源码包曾在无 `.git`、无依赖、无构建和无运行状态的全新解包目录通过当时的 36/36 门禁；该记录只证明旧包，不证明当前工作树。当前实现按所有者要求尚未重新打包，最终源码包必须在前端冻结后生成并在两个全新解包目录重跑；SHA-256 和基线应保存在 ZIP 同目录的 `.manifest.json`，避免把包自身哈希写入包内形成循环。详细结果见 `docs/TEST-RESULTS.md`。

## 模型提出、程序校验

- 默认黄金 PLAN 和 SYNTHESIZE 消费有摘要清单的真实模型缓存，不再把开发者固定字符串伪装成 AI 输出。
- 程序检查缓存文件、提示词摘要、精确研究问题、Schema、语义角色、工具白名单、证据/假设 ID 和 37.1%、47.6%、31.3%、3.04 等当前数值。
- 无关问题不能消费缓存；确定性失配结果标记 `DETERMINISTIC`，不会伪装成 `AI_JUDGMENT`。
- 可选在线 LLM 路径只允许一个显式 HTTPS 端点，任何配置、网络、Schema 或引用失败都 fail-closed，不自动切模型。
- 推理模型 PLAN/SYNTHESIZE 默认输出预算为 8192/16384，可在 256–32768 内分阶段覆盖；无效配置在出站前失败，实际预算写入 `modelProvenance`。StepFun 3.7 Flash 的旧预算失败与新预算成功证据见 `docs/verification/ABLOOM-43-STEPFUN-LIVE-2026-08-29.md`。
- 已保存的真实在线模型输出及程序校验记录位于 `docs/verification/online-llm-output.json` 与 `online-llm-validation.json`；它证明一次真实模型→校验器调用，不代表仓库携带 API 凭据。

## 信源联网证据

2026-08-29 直接调用当前产品函数并使用默认 resolver、默认 `fetch` 对 Bing、Google、百度各执行一次真实中文查询。三次 HTTP 路径均完成：Bing 0 条、Google 1 条、百度 0 条候选；三次 DNS 都由固定 HTTPS DoH 返回公网地址。0 条结果不等于有效信源成功，因此只确认三引擎请求链和 Google 当前解析路径，本轮仍不宣称 Bing/百度获得了可用候选。

单一 MediaWiki 提供方实时搜索于 `2026-08-27T15:38:33.771Z` 成功返回 5 个候选；响应 SHA-256 为 `cd9db395a50611005cd97cd5057f2b6a072e2127acb1c115ac47e5869824a218`。候选保持未验证，不自动进入事实。

固定白名单核验于 `2026-08-27T15:39:53.405Z` 执行：

| 来源 | 结果 | 字节 | SHA-256 / 错误 |
|---|---:|---:|---|
| CAAM 旧地址 | FAILED | 0 | `fetch failed` |
| 国务院客户端转载 CAAM | VERIFIED | 8,587 | `e33bf4aef4127e54e7833b9bb42bdf9b1167368867a0d35103d727561a1f79c0` |
| 中国汽车流通协会/乘联分会 | VERIFIED | 56,674 | `2fc2dcb647c101fdc2563761359c378b928004aed22b2a6f5a7a4b5c362c09ba` |
| 中国充电联盟直页 | FAILED | 0 | 预期内容标记缺失，HTTP 200 外壳没有被误报成功 |

机器记录见 `docs/verification/live-authority-check.json`，说明见 `docs/verification/LIVE-SOURCE-VERIFICATION-2026-08-27.md`。这证明受限实时搜索和白名单核验，不证明任意网站抓取或来源真理认证。

## 上传与安全边界

HTTP 测试发送真实 PDF/CSV/XLSX/TXT 字节。服务端校验扩展名、MIME、魔数/UTF-8/ZIP 结构、路径、大小、普通文件和 SHA-256，使用 UUID、`0700` 目录、`0600` 文件、临时文件与原子 rename。篡改后 GET 或运行会失败。

集成测试证明 `uploadIds` 是 `POST /api/runs` 的正式输入，文件由同一五状态任务的 COLLECT 解析；这修复了“只有 validator、没有执行入口”的缺陷。服务只绑定 loopback，拒绝 `0.0.0.0`；CSP、前端文本转义、工具 allowlist 和提示词注入均有反证。

## PPTX

| 证据 | 字节 | SHA-256 |
|---|---:|---|
| `docs/assets/insightforge-office-valid.pptx` | 18,158 | `61bd293855e99b0ebf565a1dcbb9d92ff2e17132cc3198250d87e82e78867ce3` |
| `docs/assets/insightforge-office-edit-check.pptx` | 20,156 | `27199f489a2183a83903d722fff65667c64457e89e8c9a94ca98708193b6381c` |
| `docs/assets/insightforge-pptx-montage.png` | 1,460,150 | `964c99aabb88fe7bf7c93a550a3092b0c197a4ae0d5c4a7be2e38e6db3958b29` |

最新原件在 Microsoft PowerPoint for macOS 中真实打开为 5 页；对象模型读取到中文标题。编辑第一张文本、保存、关闭并重新打开后读取到 `OFFICE EDIT CHECK`。PowerPoint 自身导出的 5 页 PDF 经视觉检查无中文方框或明显溢出。LibreOffice 的隔离运行时缺少 CJK 字体而产生方框，这一失败没有被隐藏，也没有用它否定 PowerPoint 的真实成功。

没有可用 Windows 桌面 Microsoft PowerPoint 环境，所以 Windows 专项仍为外部未验证风险。

## 外部阻断

- 仓库不含在线模型密钥；现场默认使用明确标记且摘要锁定的缓存输出。
- 公开部署没有目标和授权，未执行；当前 loopback 单用户服务也不应直接暴露到不可信网络。
