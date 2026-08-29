# InsightForge 黑客松最终提交说明

> 状态：`FINAL SUBMISSION — 2026-08-30`。本文是对外提交的唯一状态入口；内部文档中的历史计划、旧验收数字和权限记录不覆盖本文。所有在线、缓存与未验证边界均按实际证据表述。

## 冻结源码制品

- ZIP：`InsightForge-source-final-b55ff73.zip`
- 基线：`b55ff738bd955b677b8ece825dcef57e8d1a0a88`
- 大小：`600,069 bytes`
- 文件数：`210`
- SHA-256：`30ece798ba8ca50cd75c311f0d88a7a79b95a6ddcd863f17f31e81b72517ca4a`
- 双轮验收：两轮均通过 `npm ci`、`verify`、`6/6 E2E`、`3/3`、`smoke` 和 `audit`。

## 赛道与命题

- 赛道：软件赛道
- 商汤小浣熊命题：AI，不止完成一步
- 沙利文命题：PROOF OF INSIGHT — 让行业判断经得起追问

## 作品信息

- 作品名称：InsightForge
- Slogan：AI，不止完成一步；让每条行业判断，经得起追问。
- 一句话定位：从一个行业问题，到一份能下钻、能质疑、能更新的研究成果。
- GitHub：https://github.com/AdventureX-Ciallo/insightforge
- GitHub Topic：`shenicest-fission`

InsightForge 是一套离线优先、证据原生的行业研究 Agent。它把一个研究问题推进为结构化计划、信源与本地文件采集、确定性计算、模型候选判断、结构化审查和可编辑交付物。每条结论都可以追到网页 URL、PDF 页码、表格行列或计算公式；冲突不会被静默消除，证据不足不能自动确认，人负责最终判断，来源更新只让真正依赖它的对象失效并生成新的成果版本。

## 背景与目标用户

传统行业报告通常保留答案，却丢失答案形成的过程。研究执行者和审阅者难以快速回答：结论来自哪里、不同来源为何冲突、估算采用什么假设、证据不足为何仍进入报告，以及来源更新后哪些数据和结论需要重做。

首要目标用户是需要把网页、PDF 和表格整理为研究判断与汇报材料的行业分析师、咨询顾问和企业战略研究人员；次要用户是负责检查证据、处理争议并确认最终文本的研究负责人。当前目标用户和商业价值仍属于待真实访谈验证的产品假设，不声称已经获得市场采用。

## 双命题对应

- 商汤“接住整个任务”：`PLAN → COLLECT → SYNTHESIZE → AUDIT → DELIVER` 五状态真实运行；同一任务调用搜索/快照、PDF/本地文件、表格确定性计算和可编辑 PPTX 四类工具。模型提出计划和候选，程序校验 Schema、工具白名单、引用和状态迁移。
- 沙利文“经得起追问”：`研究问题 → 信源版本 → 证据/数据 → 事实、观点、计算、估算 → Claim → Conclusion` 形成机器可读证据链，并保留冲突、假设、人工决定、一次 Audit→Repair 与 v1→v2 影响版本链。

## 三个核心场景

1. 接住任务：一次运行完成五状态和四类工具调用，最终交付交互报告、PPTX、JSON、Markdown 与 PDF。
2. 追问结论：两次操作从候选结论进入 Claim、Evidence/Datum、Source 与 Locator；冲突双值、估算假设和 EvidenceGap 都可见。
3. 跟踪变化：来源从 v1 更新到 v2 后，仅相关对象进入 `STALE / NEEDS_REVIEW`，旧决定与旧成果保留，无关结论不变。

## 技术栈与实现能力

- Node.js、TypeScript、React、Zod、Playwright。
- PDF.js 逐页读取 PDF；CSV/XLSX 执行可复算的确定性计算。
- JSZip 生成文本和形状可继续编辑的五页 PowerPoint OOXML。
- 纯 Node 生成可提取中文文本的 PDF 报告。
- 本地 loopback HTTP 服务、SSE 进度流、JSON 持久化、幂等写入、按 run 串行化和成果版本链。
- 上传 PDF/CSV/XLSX/TXT，执行字节类型、大小、路径和三方 SHA-256 校验。
- 实时搜索路径带 SSRF/DNS 预检；黄金案例完全离线运行。

## 核心创新

1. 不是回答型聊天框，而是一条真正产出成果的证据原生任务链。
2. 把知识类型、责任来源、证据状态、审阅状态和新鲜度拆成机器可读的正交状态轴。
3. 冲突和证据不足 fail-closed：不静默选边、不求平均、不让无证据内容伪装成确认结论。
4. 自动 Audit→Repair 最多一次，展示修正前后，严重问题继续交给人。
5. 来源变化沿依赖关系撤销相关确认、重算对象并生成新成果版本，旧版本不覆盖。

## 团队分工

- Evander：产品负责人、全部后端与接口开发、运维与发布准备、任务编排、质量总验收及最终提交；本期未执行生产部署。
- ABloom：前端设计与 React 工作台实现。

ChatGPT Pro、Codex 与其他模型只作为工程研究、实现或审查工具，不计入参赛队员；其结论必须回到源码、测试和真实入口独立验证。

## 开发过程

项目先根据两份官方命题和 P0 清单形成首轮纵向原型，随后发现缺少正式 PRD、前端需求和开发路径，暂停扩展并补建产品发现、范围、对象模型、用户路径、验收矩阵和五分钟叙事。后续采用前后端契约驱动的纵向切片：先修复“模型提出/程序校验”、问题失配、输入驱动 Audit 和上传闭环，再完成来源变化、SSE、持久化、成果版本、React 联调和对抗式测试。所有外部模型建议均未直接视为正确。

## 可验证结果

- 197 个顶层 Node 测试、203/203 断言。
- `src/**` statements、branches、functions、lines 四项覆盖率均为 100%。
- 25/25 HTTP/SSE/上传/来源更新/成果下载契约检查。
- 固定 seed `520628262` 的 770,000 例 fuzz。
- 6/6 Chromium E2E；黄金案例连续三次 3/3。
- 最终源码包在两个全新解压目录完成 `npm ci`、`verify`、E2E、三连演示、smoke 与依赖审计。
- 最终提交图片与演示视频由 `npm run record:demo` 从当前 React 工作台重新生成。

最终源码包的 commit、大小、文件数和 SHA-256 记录在包外 `.manifest.json` 与桌面提交包验收报告中，避免源码包自引用自身哈希。

## 项目图片与视频

- 主工作台：`docs/assets/insightforge-workbench.png`
- 五状态任务链：`docs/assets/insightforge-task-chain.png`
- 证据下钻：`docs/assets/insightforge-evidence-drilldown.png`
- 来源变化：`docs/assets/insightforge-source-update.png`
- 成果交付：`docs/assets/insightforge-delivery.png`
- 当前版本演示视频：`demo-assets/insightforge-demo.webm`
- 灾备 PPTX：`demo-assets/insightforge-golden-fallback.pptx`

## 诚实边界

- 黄金资料是明确标记的合成离线演示资料，用于验证产品机制，不代表真实市场研究结论。
- 在线路径只允许一个部署者预配置的模型端点；没有多模型路由或自动 fallback。
- Bing、Google、百度真实请求链已执行，但最近一次只有 Google 解析出候选，不能声称三者均有效。
- PPTX 已在 Microsoft PowerPoint for macOS 打开、编辑、保存和重开；Windows PowerPoint 尚未专项验证。
- 当前没有公开体验部署；项目默认是 loopback-only 单用户服务，不应直接暴露到不可信网络。
- 没有真实用户调研、市场采用或付费验证。

## 后续计划

商业假设、包装方式、5–8 人验证设计及停止条件见 [`BUSINESS-HYPOTHESES.md`](BUSINESS-HYPOTHESES.md)。

1. 用 5–8 名行业分析、咨询或战略研究人员验证证据下钻、人工判断和来源变化三项任务。
2. 根据真实任务确定首个滩头用户和付费价值，验证本地席位、团队版或私有化交付假设。
3. 改进来源解析有效率、来源版本差异和可访问性，并完成 Windows PowerPoint 验证。
4. 只有在重新设计身份、权限、审计和网络边界后，才评估多人协作或公开部署；不把当前黑客松原型直接暴露为生产服务。

## 本地运行

```bash
npm ci
npm run verify
npm run test:e2e
npm run demo:triple
npm run smoke
npm start
```

默认打开 http://127.0.0.1:4399，选择“全功能研究案例”，点击“开始研究”。离线黄金案例不需要 API Key。
