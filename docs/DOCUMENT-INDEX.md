# InsightForge 产品文档总索引与执行门禁

- 版本：`ACTIVE v1.3`
- 当前阶段：`BACKEND IMPLEMENTATION VERIFIED LOCALLY — FRONTEND HANDOFF ACTIVE`
- 权限：项目所有者已授权除前端外开发；commit、push、PR、Tag 和部署仍需另行明确授权
- 事实说明：首轮原型早于正式产品文档。本索引用于纠正流程；已有代码不自动决定需求，也不构成 MVP 完成证据。

## 1. 文档状态

- `SOURCE`：外部命题或项目所有者原始要求，只读依据。
- `DRAFT`：正在评审，不能作为恢复开发授权。
- `FROZEN`：内容已获项目所有者明确确认，可作为开发基线。
- `HISTORICAL`：记录此前实现或验证，只能作参考。
- `EVIDENCE`：文档冻结后产生的测试、构建、外部验证或用户测试证据。

未经项目所有者确认，任何文档不得自行从 `DRAFT` 变成 `FROZEN`。

## 2. 需求权威顺序

出现冲突时按以下顺序处理：

1. 项目所有者最新明确指令、P0、禁止清单和权限边界。
2. 两份官方命题 PDF 的原文要求。
3. 冻结后的 PRD、开发范围与决策日志。
4. 冻结后的 MVP 策略、用户流程、前端需求和风险台账。
5. 架构、状态机、测试计划和实现文档。
6. 历史代码、历史自动化结果、外部代理报告。

历史实现与上层文档冲突时，应修改实现或提出范围变更，不能反向降低需求。

## 3. 前期文档体系

| 层级 | 文档 | 作用 | 当前状态 |
|---|---|---|---|
| 调研证据 | `BRIEF-RESEARCH-EVIDENCE.md` | 区分命题原文、所有者解释和产品推导 | DRAFT |
| 参考方法 | `REFERENCE-PRODUCT-METHOD.md` | 拆解 Hiliu 的完整产品证据链与最小化方法 | DRAFT |
| 产品发现 | `PRODUCT-DISCOVERY.md` | 问题、目标用户假设、JTBD、证据等级 | DRAFT |
| 产品策略 | `MVP-STRATEGY.md` | 一句定位、三个场景、72 小时切线 | DRAFT |
| 案例内容 | `GOLDEN-CASE-SPEC.md` | 黄金问题、来源槽位、冲突/不足/更新反证 | DRAFT |
| 案例来源 | `GOLDEN-SOURCE-MANIFEST.md` | 原始来源、派生表、合成演示资产与哈希边界 | DRAFT |
| 对象模型 | `RESEARCH-OBJECT-MODEL.md` | 唯一研究对象链、正交状态与 ArtifactVersion | DRAFT |
| 产品需求 | `PRD.md` | 功能、非功能、P0 与责任边界 | DRAFT |
| 范围 | `DEVELOPMENT-SCOPE.md` | 本期做/不做、权限与变更规则 | DRAFT |
| 用户体验 | `USER-FLOWS.md` | 主流程、失败流程、人工与更新流程 | DRAFT |
| 前端 | `FRONTEND-REQUIREMENTS.md` | 信息架构、状态、交互和可访问性 | DRAFT |
| 项目说明 | `PROJECT-SPECIFICATION.md` | 对外统一描述、技术栈、创新点 | DRAFT |
| 决策 | `DECISION-LOG.md` | 关键取舍、依据和重审触发器 | DRAFT |
| 风险 | `RISK-REGISTER.md` | 产品、工程、安全与现场风险 | DRAFT |
| 验证 | `PRODUCT-VALIDATION-PLAN.md` | 命题适配和可选用户验证 | DRAFT |
| 路演 | `PITCH-NARRATIVE.md` | 五分钟产品叙事与禁用话术 | DRAFT |
| 提交 | `SUBMISSION-PLAN.md` | 项目图片、视频、仓库、Tag 与证据包计划 | DRAFT |
| 外部审查 | `PRODUCT-REVIEW-BRIEF.md` | 约束 ChatGPT Pro 只审文档、不写代码 | DRAFT |
| 审查记录 | `PRODUCT-DOC-AUDIT.md` | Pro 意见的独立采纳/拒绝与本地一致性证据 | DRAFT |
| 开发路径 | `DEVELOPMENT-ROADMAP.md` | 文档冻结后的 72 小时实施顺序 | DRAFT |
| 验收 | `P0-ACCEPTANCE-MATRIX.md` | 十二条 P0 的测试预言，不是自我声明 | DRAFT |

## 4. 后置工程文档

以下文档只能服从前期冻结基线；当前内容属于已有原型的历史材料：

- `ARCHITECTURE.md`
- `STATE-MACHINE.md`
- `AI-SYNTHESIS.md`
- `DEMO-SCRIPT.md`
- `SUBMISSION.md`
- `IMPLEMENTATION_REPORT.md`
- `TEST-RESULTS.md`
- `VERIFICATION-EVIDENCE.md`
- `DUAL-AGENT-REVIEW.md`

在恢复开发前，需要把其中所有“PASS/完成/已实现”与冻结需求重新核对。没有新鲜入口证据的历史结论不得继承为完成状态。

## 5. 文档冻结检查表

### 5.1 调研与定位

- [ ] 两份命题的原文、所有者解释、产品推导彼此分离。
- [ ] 一句话定位同时覆盖完整任务与证据责任。
- [ ] 目标用户、JTBD 和非目标用户明确。
- [ ] 不把未执行的用户研究写成已验证事实。

### 5.2 最小产品

- [ ] 只有一个黄金案例和三个核心场景。
- [ ] 每个场景有入口、正常路径、失败路径和可观察结果。
- [ ] 十二条 P0 均映射到三个场景或横向质量门禁。
- [ ] 任何次要能力都有折叠入口、责任边界和强制验收方式，不与三个核心场景争夺主线。
- [ ] 黄金资料逐项标明原始/派生/合成，URL、定位、时间和哈希缺口无隐瞒。

### 5.3 人机责任与安全

- [ ] 模型提出、程序校验、人类决定在数据和 UI 中可区分。
- [ ] 对象链、五个正交状态轴、EvidenceGap 和 ArtifactVersion 使用同一权威定义。
- [ ] 冲突、证据不足、过期内容不能伪装为确认结论。
- [ ] 来源发现、固定白名单核验和候选生成分别使用独立模式字段，离线快照不冒充实时调用。
- [ ] 上传保存与“进入证据链”不混称。
- [ ] 禁止清单和发布权限完整。

### 5.4 体验与验收

- [ ] 前端层级由三个场景推导，不由现有代码结构倒推。
- [ ] 五分钟叙事只包含一个主线。
- [ ] P0 验收包含可执行反证，不以 `PASS` 文案代替证据。
- [ ] 未验证风险和外部环境边界已记录。
- [ ] D-006、D-012、D-014、D-015、D-017～D-020 已由项目所有者逐项接受或拒绝。

## 6. 当前执行门禁

开发授权已经由项目所有者最新指令恢复。当前每个工程切片必须满足：

1. 可映射到 PRD、P0 或明确前端交接项。
2. 不增加禁止清单中的平台化能力。
3. 修改后运行相称的类型、测试、构建和用户入口验证。
4. 前端目录由 ABloom 负责；Codex 不以修改前端掩盖后端合同缺陷。
5. commit、push、PR、Tag、部署和生产配置仍需具体的新授权。

## 7. 当前权限状态

当前授权读取仓库、修改本地后端/测试/文档、打包源码和运行本地验证。没有 commit、push、PR、Tag、部署、数据库迁移、线上配置或真实用户数据操作权限。
