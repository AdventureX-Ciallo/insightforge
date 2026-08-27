# 验证证据索引

> 状态：`CURRENT — 2026-08-28`。所有结论按“真实成功、真实失败、环境未具备”分开记录。

## 基线与变更边界

- 基线 commit：`2113f1091c4e5dbacc5b828013f0ff62514fbd9e`。
- 当前是本地隔离 worktree，保留已有脏改动。
- 未 commit、push、创建 PR、打 Tag、部署、迁移数据库、修改线上配置或操作真实用户数据。
- 本轮不修改 ABloom 负责的 `public/`。

## 自动门禁

2026-08-28 在当前工作树与一个无 `.git`、无依赖、无构建和无运行状态的全新解包目录分别执行：

```text
npm ci                         PASS
npm run verify                 PASS; 36/36; build; secret scan
npm run test:e2e               PASS; 1/1 Chromium
npm run demo:triple            PASS; 3/3
npm run smoke                  PASS
npm audit --audit-level=high   PASS; 0 vulnerabilities
```

详细结果见 `docs/TEST-RESULTS.md`。最终源码包的 SHA-256 和基线保存在 ZIP 同目录的 `.manifest.json`，避免把包自身哈希写入包内形成循环。

## 模型提出、程序校验

- 默认黄金 PLAN 和 SYNTHESIZE 消费有摘要清单的真实模型缓存，不再把开发者固定字符串伪装成 AI 输出。
- 程序检查缓存文件、提示词摘要、精确研究问题、Schema、语义角色、工具白名单、证据/假设 ID 和 37.1%、47.6%、31.3%、3.04 等当前数值。
- 无关问题不能消费缓存；确定性失配结果标记 `DETERMINISTIC`，不会伪装成 `AI_JUDGMENT`。
- 可选在线 LLM 路径只允许一个显式 HTTPS 端点，任何配置、网络、Schema 或引用失败都 fail-closed，不自动切模型。
- 已保存的真实在线模型输出及程序校验记录位于 `docs/verification/online-llm-output.json` 与 `online-llm-validation.json`；它证明一次真实模型→校验器调用，不代表仓库携带 API 凭据。

## 信源联网证据

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

- 当前前端尚未完成上传 ID→运行、编辑/确认分离、确认理由/范围及成果历史展示。
- 仓库不含在线模型密钥；现场默认使用明确标记且摘要锁定的缓存输出。
- 公开部署没有目标和授权，未执行；当前 loopback 单用户服务也不应直接暴露到不可信网络。
