# AI Synthesis：模型提出、程序校验与问题泛化

> 状态：`历史实现文档；产品冻结后重新验收`。不得用本文件证明默认黄金路径已经满足“模型提出”。

下文记录旧实现的 SYNTHESIZE/AUDIT 三种形态。冻结后的产品合同要求默认离线黄金路径消费可审计的真实模型缓存，并另行强制验收单端点在线 PLAN/SYNTHESIZE；旧实现的“无模型默认”是待修缺口，不是产品决定。

## 三种综合模式（`run.synthesisMode`）

| 模式 | 触发条件 | 候选判断来源 |
|---|---|---|
| `deterministic` | 默认（未启用 LLM），且问题与证据语料匹配（匹配度 ≥ 0.35） | 确定性组合器从本轮 COLLECT 产物生成 |
| `deterministic-mismatch` | 问题与证据语料不匹配（例如向新能源资料问光伏问题） | 三条 INSUFFICIENT_EVIDENCE 结论，如实列出信源/数据/判断三类缺口 |
| `llm-assisted` | `INSIGHTFORGE_LLM=1` 且提供密钥，模型草稿通过程序校验 | LLM 草稿（仅引用白名单 evidenceId），仍标记为 AI_JUDGMENT |

要点：

- **问题泛化是可证伪的**：`tests/generalization.test.ts` 用一个光伏问题证明——不相关问题不再产出预写的充电桩结论，scope 不再硬编码领域；黄金问题仍产出完整的冲突、证据不足与估算案例。
- **历史在线模型路径是显式且 fail-closed 的**：旧实现只有显式启用并同时配置 key/base URL/model 才调用；冻结后必须按 PRD 重新实现/验收。网络、配额、超时、配置或有效草稿数不足都应使 SYNTHESIZE 失败，不自动回退或伪装为确定性结果。
- **程序校验**：`validateLlmDrafts` 要求模型草稿的每个 evidenceId 都属于本轮 COLLECT 产物，任一未知引用会使整条草稿失败；来源归属由 evidence→source 的确定关系回填，不信任模型自报来源。

## 确定性审计（`src/audit.ts`）

六条规则全部读取结构化输入本身，同一规则作用于不同数据会产生不同发现：

1. **MISSING_CITATION**：悬空引用移除；来源自述"no … dataset"式缺数据声明 → 引用缺失。
2. **SCOPE_OVERREACH**：原文使用全称量词（所有/普遍/整体）而量化支撑不足两条 → NEEDS_HUMAN。
3. **TYPE_MISMATCH**：来源的预测/展望句被抽取为 FACT → 修复为 FORECAST。
4. **MISSING_ASSUMPTION**：ESTIMATE 缺少假设 → 从其自身输入参数派生并标注"演示参数，尚缺行业来源支撑"。
5. **UNSUPPORTED_CLAIM**：AI_JUDGMENT 且无任何量化数据支撑 → 降级为 INSUFFICIENT_EVIDENCE 并阻断确认。
6. **SOURCE_CONFLICT**：同一期间、指标语义重叠但数值不同 → 双值保留、候选解释、NEEDS_HUMAN。

修复轮次上限 1（`repairAttempts` 由是否存在 REPAIRED 发现决定，0 或 1）。

## 启用模型提出

```bash
export INSIGHTFORGE_LLM=1
export INSIGHTFORGE_LLM_API_KEY=...     # 在本机环境配置，不写入仓库
export INSIGHTFORGE_LLM_BASE_URL=https://your-explicit-endpoint.example/v1
export INSIGHTFORGE_LLM_MODEL=your-explicit-model
npm run demo -- --llm                    # CLI
# 或启动服务后页面运行
```

未设置开关时，行为与离线基线完全一致。设置开关但配置缺失时，任务明确失败；系统不会选择第二模型或回退为另一套结果。

## 真实在线模型验证

2026-08-27 使用本机已认证的 OpenAI/Codex 在线通道（`gpt-5.6-sol`，只读、临时会话）把黄金案例的六个 evidenceId 交给模型生成结构化草稿。模型返回 5 条候选判断；仓库的 `validateLlmDrafts` 接收 5/5，未知 evidenceId 为 0。持久证据：

- `docs/verification/online-llm-prompt.txt`
- `docs/verification/online-llm-output-schema.json`
- `docs/verification/online-llm-output.json`（2,698 bytes；SHA-256 `86ea57b67bc638424d682499b315325995d9dce8052592454a411116e6cbbb71`）
- `docs/verification/online-llm-validation.json`

这是真实在线模型输出与本仓库程序校验器的闭环证据；它不把 Codex 登录态当作可分发 API Key，也不声称产品部署环境已经配置 OpenAI-compatible 凭据。
