# InsightForge 架构全景（0828 评审版）

```
┌────────────────────────────── 前端（ABloom 域，public/ 不改交互） ──────────────────────────────┐
│  index.html + app.js（vanilla，textContent 安全渲染）+ styles.css                                │
│  首页(3预设+自定义) → 任务进度(五状态轨道) → 候选结论 → 审查修正 → 来源更新 → 成果交付(V1-V5)    │
└───────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                        │ fetch 轮询 + 可选 SSE（loopback 4399，CSP/no-referrer 硬化头）
┌───────────────────────────────────────▼──────────────────────────────────────────────────────┐
│ HTTP 层  server.ts (547L)                                                                      │
│  POST /api/runs · GET /api/runs/:id · GET /api/runs/:id/events(SSE) · POST /decisions          │
│  GET  /artifact-versions · GET /boundary-questions · GET/POST /api/settings/llm (key 掩码)     │
│  POST /api/uploads (5MiB/类型/字节/路径校验, 0600, SHA-256) · POST /source-update · /sources/search│
│  GET  /api/presets · GET /artifacts/:kind (MD/PDF/PPTX/JSON 下载) · GET /api/current           │
└───────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                        │
┌───────────────────────────────────────▼──────────────────────────────────────────────────────┐
│ 引擎层  engine.ts (399L) ── 五状态 fail-closed 状态机                                            │
│   PLAN → COLLECT → SYNTHESIZE → AUDIT → DELIVER   （终态 DELIVERED/NEEDS_REVIEW/FAILED）        │
│   每步 outputId 哈希被下一步 consumedOutputIds 消费；失败传播不留假成功                           │
│                                                                                                │
│   PLAN        模型提出(draftPlanSteps) ──程序校验──▶ 工具允许列表+audit/deliver 双锚点           │
│   COLLECT     快照搜索 + PDF 逐页 + CSV 确定性计算 + 上传白名单文件(local-file-reader)           │
│   SYNTHESIZE  三路：llm-assisted(白名单引用校验) / deterministic / mismatch(诚实证据缺口)        │
│   AUDIT       audit.ts 六规则读真实输入（悬空引用/缺数据自述/全称量词/FACT→FORECAST/             │
│               估算假设派生/AI判断无数据降级/同期间冲突双值保留），单次修复                        │
│   DELIVER     artifacts.ts 版本链(V1-V5) + report-export(MD+PDF) + pptx-export(手写OOXML)       │
│               + evidence JSON(Zod) —— 每版本四格式真实文件                                      │
└──────┬────────────────┬───────────────┬────────────────┬─────────────────┬────────────────────┘
       │                │               │                │                 │
┌──────▼─────┐  ┌───────▼──────┐ ┌──────▼───────┐ ┌──────▼────────┐ ┌──────▼─────────────┐
│ domain.ts  │  │ llm.ts (226L)│ │ model-cache  │ │ source-       │ │ settings-store    │
│ (807L)     │  │ 单端点 fail- │ │ (149L)       │ │ confidence.ts │ │ (85L)             │
│ Zod 全链   │  │ hard，传输重 │ │ SHA-256+问题 │ │ 域名静态权重   │ │ .insightforge/    │
│ schema+    │  │ 试×2，token  │ │ 域+Schema 校 │ │ gov .97/协会/  │ │ settings.json     │
│ 类型系统   │  │ 预算 4096    │ │ 验的离线回放 │ │ 社媒低+维度    │ │ API>环境变量      │
└────────────┘  └──────────────┘ └──────────────┘ └───────────────┘ └────────────────────┘
       │                │               │                │                 │
┌──────▼────────────────▼───────────────▼────────────────▼─────────────────▼────────────────────┐
│ 工具层 tools/                                                                                    │
│  snapshot-search(离线索引) · pdf-reader(pdfjs逐页) · csv-calculator(确定性公式)                   │
│  search-engines：Bing/Google/Baidu HTML 解析 + 域名白名单 + 请求前 DNS/IP 黑名单预检             │
│                  （默认 fetch 会再次解析 DNS，因此不声称已消除 DNS rebinding/TOCTOU）            │
│  live-source-check(权威页核验) · upload-validator(类型/字节/穿越) · local-file-reader            │
│                        (PDF/XLSX/CSV/TXT 结构化解析，XLSX=手写OOXML解包)                         │
│  pptx-export(手写OOXML) · report-export(MD + 确定性纯 Node CID/ActualText PDF)                  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘

外部边界：DEEPSEEK/自配端点(HTTPS) · Bing/Google/Baidu(SSRF过滤) · 权威白名单域 · 无数据库(文件JSON)

直接运行时依赖：jszip@3.10.1 · pdfjs-dist@5.4.149 · zod@3.25.76；它们存在锁定的传递依赖，不能表述为“零传递”。
开发依赖：playwright(页面 E2E) · c8(覆盖率门禁100) · tsx · typescript · @types/node。实际依赖树、漏洞数和安装体积以本轮 `npm ls` / `npm audit` / 干净安装结果为准。
```
