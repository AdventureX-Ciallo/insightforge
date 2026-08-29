# 黑客松提交材料

> 状态：`CURRENT DRAFT — 后端契约与本地演示门禁已冻结，前端联调、最终 ZIP 和双轮干净验收待统一完成`。本文只陈述已有证据，不把缓存、模拟或本地验证写成线上成功。

## 赛道与命题

- 赛道：软件赛道
- 商汤小浣熊命题：“AI，不止完成一步”
- 沙利文命题：“PROOF OF INSIGHT — 让行业判断经得起追问”

## 作品信息

- 作品名称：InsightForge
- Slogan：AI，不止完成一步；让每条行业判断，经得起追问。
- 作品描述：InsightForge 是一套离线优先、证据原生的行业研究 Agent。它把一个研究问题推进为结构化计划、信源与本地文件采集、确定性计算、模型候选判断、结构化审查以及可编辑交付物。每条结论都可以追到网页 URL、PDF 页码或表格行列；冲突不会被静默消除，证据不足不能自动确认，人负责最终判断，来源更新只让依赖对象失效并生成新的成果版本。

## 双命题对应

- 商汤“接住整个任务”：`PLAN → COLLECT → SYNTHESIZE → AUDIT → DELIVER` 五状态真实运行，同一任务调用搜索/快照、PDF/本地文件、CSV 确定性计算和 PPTX 四类工具；模型提出计划与候选，程序校验 Schema、工具白名单、引用和状态迁移。
- 沙利文“经得起追问”：`研究问题 → 信源版本 → 证据/数据 → 事实、观点、计算、估算 → Claim → Conclusion` 形成机器可读证据链，并保留冲突、假设、人工决定、Audit→Repair 与 v1→v2 影响版本链。

## 目标用户

需要快速完成行业研究、又不能丢失证据边界的行业分析师、战略团队、投资研究人员和业务决策者。

## 技术栈与关键实现

- Node.js `^20.19.0 || ^22.12.0 || >=23`、TypeScript、Zod 严格合同。
- PDF.js 读取 PDF 正文并保留页码；CSV 执行可复算的确定性计算。
- JSZip 直接生成文字和形状可编辑的 PowerPoint OOXML。
- PDF 报告采用纯 Node 的确定性 CID/ActualText 导出，不依赖 Python、ReportLab 或浏览器打印。
- 本地 loopback HTTP 服务；所有任务写操作按 `runId` 串行化，避免人工编辑与来源更新并发覆盖。
- 后端 SSE 已就绪：可流式输出五状态、工具事件、心跳和终态，并完成 run 隔离与断开清理；当前前端仍通过轮询刷新，不能声称已经消费 SSE。
- 统一 `MAX_SOURCES=10`：三搜索引擎、单提供方搜索、离线快照、COLLECT 和证据包共同执行上限；第 11 个信源被截断并留下机器记录。
- `npm run contract:check` 启动临时 loopback 服务，逐项真实调用联调契约并输出 PASS/FAIL 清单和 JSON 报告；标准 `npm run verify` 已强制包含该命令及确定性 fuzz，二者仍可单独重跑以生成各自报告。

## 可验证质量数字

| 项目 | 当前证据 |
|---|---|
| Node 测试 | 163/163 PASS |
| 覆盖率 | `src/**` 语句、分支、函数、行四项均 100% |
| Seeded fuzz | 694,100 例；6,931 行生产 TypeScript；100.14 例/行 |
| 浏览器 E2E | 1/1 PASS；非默认端口真实 Chromium 黄金路径与下载 PPTX 解析通过，5.9 s |
| 稳定演示 | 黄金案例连续三次成功（88/20/16 ms） |
| 联调合同 | 23/23 PASS；`npm run contract:check` 覆盖 SSE、presets、run、boundary questions、人工决定、来源更新、artifact versions、settings、uploads、搜索合同及四格式下载 |
| 安全 | loopback、上传字节/路径/SHA、工具白名单、提示词注入、SSRF 预检和密钥扫描均有门禁 |

## 核心创新

1. 不是回答型聊天框，而是一条会产出真实成果的证据原生任务链。
2. 机器可读地区分事实、来源观点、计算、估算、AI 判断与人工确认。
3. 冲突与证据不足 fail-closed：不选边、不求平均、不把无证据判断伪装成结论。
4. 最多一次自动 Audit→Repair，并展示修正前后；严重问题继续交给人。
5. 最小确定性来源影响分析：来源变化撤销相关确认、重算依赖对象并生成新 PPTX/JSON 版本，旧成果不覆盖。

## 诚实边界

| 边界 | 当前状态 | 对外准确说法 |
|---|---|---|
| 前端衔接 | ABloom 仍在联调；后端合同已提供一键 harness | “后端纵向切片和契约已验，前端最终入口尚未冻结。” |
| SSE | 后端接口与测试就绪，当前前端仍轮询 | “支持 SSE 运行事件；当前页面暂未接入。” |
| 真实搜索环境 | 当前机器的 Bing、Google、百度 DNS 返回 `198.18.0.0/15` fake-IP 代理保留段，产品在 fetch 前 fail-closed | “离线黄金案例稳定；当前代理环境未验证实时搜索成功。” |
| 在线 LLM | 当前环境没有 API Key/Base URL/Model，未发起线上调用 | “黄金案例使用认证模型缓存；在线单端点成功仍待有 Key 环境验证。” |
| 黄金资料 | 明确标记的合成离线演示资料 | “验证产品机制，不代表真实市场研究结论。” |
| PPTX | OOXML 解析与 macOS PowerPoint 打开/编辑/保存已验 | “Windows Microsoft PowerPoint 专项仍未验证。” |
| 发布 | 本地单用户 loopback 服务 | “未部署，不能直接暴露到不可信网络。” |
| 最终源码包 | 推迟到前端联调冻结后统一执行 | “本轮不生成 ZIP；最终包将执行两轮独立干净验收。” |

## 团队与开发过程

项目采用测试先行的纵向切片开发，由产品/后端、前端和运维分工协作；ChatGPT Pro 作为外部工程审查输入，所有结论与补丁均须由本地源码、测试和真实入口独立验收后才能采用。开发过程保留决策、风险、测试和双代理审查记录。

## 已有提交资产

- 项目截图：`docs/assets/insightforge-workbench.png`
- 演示视频：`demo-assets/insightforge-demo.webm`
- 灾备 PPTX：`demo-assets/insightforge-golden-fallback.pptx`
- PowerPoint 验证文件：`docs/assets/insightforge-office-valid.pptx`、`docs/assets/insightforge-office-edit-check.pptx`
- 实时权威核验截图：`docs/assets/insightforge-live-check.png`
- GitHub 仓库：`https://github.com/AdventureX-Ciallo/insightforge`
- 最终发布 Tag：前端冻结并获得发布授权后设置 `#shenicest-fission`

## 后续计划

前端冻结后，统一生成最终源码 ZIP、记录 commit/大小/SHA-256，并在两个全新解压目录分别执行依赖安装、verify、contract check、E2E、三连演示、smoke、依赖审计和密钥扫描。黑客松后再评估更强的来源版本差异、可复用研究模板与可访问性；不扩展为无人值守监控、多 Agent 群体或通用知识图谱。
