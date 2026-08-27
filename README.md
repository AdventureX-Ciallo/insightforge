# InsightForge

> 当前状态（2026-08-27）：`PRODUCT DEFINITION — DEVELOPMENT PAUSED`。

首轮本地原型早于正式产品文档，不能视为已完成 MVP，也不能用历史命令、测试或演示结果证明当前需求已满足。本轮只完成产品前期文档；在项目所有者明确回复“文档冻结，可以开发”前，不继续业务代码、依赖、测试、构建、打包或发布工作。

## 一句话产品

`从一个行业问题，到一份能下钻、能质疑、能更新的研究成果。`

InsightForge 计划以同一个软件赛道作品响应：

- 商汤小浣熊“AI，不止完成一步”：证明 multi-step Agent、multi-tool use 和从需求到可编辑成果的完整任务链。
- 沙利文“PROOF OF INSIGHT”：证明信源、证据、数据、假设、判断与结论可追溯，冲突和不足不被隐藏，人负责最终判断，来源变化可追踪。

本期只讲三个核心场景：

1. `接住任务`：`PLAN → COLLECT → SYNTHESIZE → AUDIT → DELIVER` 调用搜索、PDF/本地文件、表格计算和 PPTX 工具，交付交互报告、可编辑 PPTX、证据 JSON。
2. `追问结论`：支持项可下钻到底稿，证据不足项显示 EvidenceGap；事实、计算、估算、AI 候选和人工决定不混称。
3. `跟踪变化`：载入内置 v2 演示快照后，相关对象和旧决定失效并生成新成果版本，无关结论保持不变。

## 当前产品边界

- 一个新能源乘用车与公共充电基础设施黄金案例，不做第二行业交付案例。
- 默认离线模式使用明确标记的缓存搜索与缓存模型输出；执行时使用“加载并校验”，不冒充实时发现或实时生成。
- XLSX 允许作为 P0-03/P0-12 的输入/上传类型，但本期只生成 PPTX 与 JSON，不生成 XLSX/DOCX。
- 任意上传必须经过真实用户入口和安全校验；保存成功不等于进入证据链。
- 单一提供方实时搜索、固定白名单来源核验、在线单端点 LLM、真实上传、Windows PowerPoint 与获授权后的公开部署必须分别保存真实验证证据；离线或本地替代不能关闭这些风险。
- 不做通用聊天、多 Agent 群体、用户系统、多人协作、向量数据库、自动全网监控、定时更新、任意爬虫、多模型路由、自动 fallback 或超过一次的自动修复。

## 产品文档入口

总入口：[产品文档索引](docs/DOCUMENT-INDEX.md)

建议按以下顺序评审：

1. [双命题调研证据](docs/BRIEF-RESEARCH-EVIDENCE.md)
2. [参考产品方法](docs/REFERENCE-PRODUCT-METHOD.md)
3. [产品发现](docs/PRODUCT-DISCOVERY.md)
4. [最小化产品策略](docs/MVP-STRATEGY.md)
5. [黄金案例规格](docs/GOLDEN-CASE-SPEC.md)与[黄金资料清单](docs/GOLDEN-SOURCE-MANIFEST.md)
6. [研究对象、状态与成果版本模型](docs/RESEARCH-OBJECT-MODEL.md)
7. [PRD](docs/PRD.md)、[开发范围](docs/DEVELOPMENT-SCOPE.md)与[开发路径](docs/DEVELOPMENT-ROADMAP.md)
8. [用户流程](docs/USER-FLOWS.md)与[前端需求书](docs/FRONTEND-REQUIREMENTS.md)
9. [项目说明书](docs/PROJECT-SPECIFICATION.md)、[决策日志](docs/DECISION-LOG.md)与[风险台账](docs/RISK-REGISTER.md)
10. [P0 验收矩阵](docs/P0-ACCEPTANCE-MATRIX.md)、[五分钟叙事](docs/PITCH-NARRATIVE.md)与[提交计划](docs/SUBMISSION-PLAN.md)

## 历史原型说明

仓库中仍存在首轮原型、历史运行命令和历史验证材料。它们统一归类为 `HISTORICAL`：可用于冻结后的差距审计，但未按未来冻结基线从干净包和真实用户入口重验，当前不得声称以下能力已完成：

- 十二条 P0 已通过或 MVP 已完成；
- 默认流程完成了实时搜索/实时模型生成；
- 上传资料已进入研究证据链；
- PPTX 已在目标 Windows Microsoft PowerPoint 环境验证；
- 产品已部署、提交、推送、创建 PR 或发布 Git Tag。

冻结后，README 才会补回经过独立验证的安装、配置、测试、构建、启动和一键演示命令。当前实现状态与产品定义发生冲突时，以项目所有者指令、官方命题和冻结文档为准。

## 当前发布状态

工作仅存在于本地隔离 worktree；本轮没有 commit、push、PR、Git Tag、部署、数据库迁移或生产配置变更。任何发布操作都需要项目所有者对具体动作另行明确授权。
