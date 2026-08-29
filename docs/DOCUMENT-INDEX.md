# InsightForge 文档索引

> 状态：`FINAL — 2026-08-30`。对外提交状态以 `SUBMISSION.md` 为唯一入口；其他文件分别承担产品定义、工程设计、历史决策或验证证据，不得用旧阶段说明覆盖最终状态。

## 评委与提交入口

1. `SUBMISSION.md`：作品信息、背景、目标用户、创新、团队、过程、验证、边界与后续计划。
2. `DEMO-SCRIPT.md`：唯一有效的五分钟讲稿，与当前 React UI 按钮和文案一致。
3. `P0-ACCEPTANCE-MATRIX.md`：十二条 P0 最终判定与反证。
4. `TEST-RESULTS.md`：自动门禁、外部环境和交付物验证。
5. `VERIFICATION-EVIDENCE.md`：证据索引和诚实边界。

## 产品定义

| 文档 | 作用 | 状态 |
|---|---|---|
| `BRIEF-RESEARCH-EVIDENCE.md` | 区分命题原文、所有者解释和产品推导 | FROZEN |
| `PRODUCT-DISCOVERY.md` | 问题、目标用户假设、JTBD 和待验证风险 | FROZEN |
| `MVP-STRATEGY.md` | 一句话定位、三个场景和 72 小时切线 | FROZEN |
| `PRD.md` | 功能、非功能、P0 与人机责任边界 | FROZEN |
| `DEVELOPMENT-SCOPE.md` | 本期做/不做与变更边界 | FROZEN |
| `USER-FLOWS.md` | 主流程、失败流程、人工决定与来源更新 | FROZEN |
| `FRONTEND-REQUIREMENTS.md` | React 信息架构、状态、交互和可访问性 | IMPLEMENTED |
| `PROJECT-SPECIFICATION.md` | 对外项目说明、技术栈、创新和团队分工 | FINAL |
| `BUSINESS-HYPOTHESES.md` | 商业假设、包装方式、验证设计与停止条件 | CURRENT HYPOTHESES |
| `GOLDEN-CASE-SPEC.md` | 黄金问题、来源、冲突、不足与更新反证 | FROZEN |
| `GOLDEN-SOURCE-MANIFEST.md` | 原始、派生、合成资料和哈希边界 | FROZEN |
| `RESEARCH-OBJECT-MODEL.md` | 证据图、状态轴和 ArtifactVersion | IMPLEMENTED |

## 工程与验证

| 文档 | 作用 | 状态 |
|---|---|---|
| `ARCHITECTURE.md` / `STATE-MACHINE.md` | 当前系统架构与五状态合同 | CURRENT |
| `AI-SYNTHESIS.md` | 模型提出、程序校验和 fail-closed | CURRENT |
| `SECURITY-MODEL.md` | 上传、SSRF、注入、凭据与本地边界 | CURRENT |
| `USER-PATHS-0828.md` | 前后端 API、SSE 和持久化合同 | CURRENT |
| `IMPLEMENTATION_REPORT.md` | 后端与 React 集成实现证据 | CURRENT |
| `ISSUE-RESOLUTION-AUDIT-0828.md` | Issue 修复与对抗复核 | EVIDENCE |
| `ABLOOM-ISSUE-AUDIT.md` | 前端联调 Issue 的逐项解决记录 | EVIDENCE |

## 历史和复盘

`PITCH-NARRATIVE.md`、`DECISION-LOG.md`、`RISK-REGISTER.md`、`PRODUCT-DOC-AUDIT.md`、`DUAL-AGENT-REVIEW.md`、`REFERENCE-PRODUCT-METHOD.md` 和各版本路线图保留当时的判断、权限和失败记录。它们是历史证据，不是当前讲稿或完成状态；出现冲突时服从项目所有者最新要求、`DEMO-SCRIPT.md`、`SUBMISSION.md`、冻结 PRD 和真实测试结果。

## 当前发布边界

- GitHub 仓库和 Topic `shenicest-fission` 属于最终提交范围。
- 当前项目图片、演示视频、README、项目文档和源码包属于最终提交范围。
- 可直接体验链接为可选项，本期没有公开部署。
- 未迁移数据库、未修改生产配置、未操作真实用户数据。
- 当前 loopback-only 单用户服务不能未经安全改造直接暴露到不可信网络。
