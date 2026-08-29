# ABloom25 Issue #43：StepFun 真实端点 RED/GREEN 证据

> 时间：2026-08-29（Asia/Shanghai）
> 性质：真实在线请求，不是 mock、缓存或录制结果。正文未落盘，只保留计量、数量和 SHA-256。API Key 仅从本机运行环境读取，未进入命令输出、源码、测试或本文档。

## 端点与协议

- 模型：`step-3.7-flash`
- OpenAI Chat Completions Base URL：`https://api.stepfun.com/step_plan/v1`
- 官方接入文档：<https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api>
- 官方文档明确该模型使用上述 OpenAI 协议路径，并支持 `reasoning_effort`；本轮保持项目现有请求字段，不启用供应商专属参数。

## RED：旧预算复现

使用与 GREEN 相同的研究问题和同形状最小证据上下文，仅把预算覆盖为旧值：

| 阶段 | `max_tokens` | HTTP | `finish_reason` | completion tokens | 可见正文字符 | reasoning 字符 | 结果 |
|---|---:|---:|---|---:|---:|---:|---|
| PLAN | 2,048 | 200 | `length` | 2,048 | 0 | 4,270 | 失败：`LLM response has no message content` |
| SYNTHESIZE | 4,096 | 200 | `stop` | 2,698 | 1,038 | 4,509 | 本次最小上下文生成 4 条候选 |

PLAN 独立复现了 Issue #43 的核心故障：传输成功并不代表可用输出；推理耗尽共享预算后没有任何最终正文。SYNTHESIZE 在这份缩小上下文中未复现截断，不据此否认 Issue 原报告在完整证据上下文中的 4,096 token 截断证据。

## GREEN：新默认预算

使用代码中的默认预算 `PLAN=8192`、`SYNTHESIZE=16384`：

| 阶段 | `max_tokens` | HTTP | `finish_reason` | completion tokens | 可见正文字符 | reasoning 字符 | 耗时 | 结构化结果 |
|---|---:|---:|---|---:|---:|---:|---:|---|
| PLAN | 8,192 | 200 | `stop` | 1,389 | 1,379 | 1,987 | 10,477 ms | 7 个步骤 |
| SYNTHESIZE | 16,384 | 200 | `stop` | 2,848 | 1,362 | 4,574 | 16,897 ms | 4 条候选 |

- 全部阶段总耗时：27,375 ms。
- PLAN 解析结果 SHA-256：`1de2a20fff20c3c4852ff97ec798d640d717ba30080e59f3c993330b964c96f5`
- SYNTHESIZE 解析结果 SHA-256：`1809b32e969faf1a24997909ecac220907bffdf72c42e7cd07264a9ae755befa`
- 该 GREEN 在提示词加入字段长度/数量合同后重新执行，和最终代码的请求形状一致。
- 两次响应均在当前默认 90 秒单次超时内完成。
- StepFun 接受当前 `response_format: {"type":"json_object"}`；不能把其他供应商也推断为兼容。

## 兼容性与诚实边界

- `8192/16384` 是本次对 `step-3.7-flash` 的真实通过默认值，不是所有 OpenAI 兼容模型的通用能力声明。
- 输出上限较低的端点可通过 API 设置 `planMaxTokens` / `synthesisMaxTokens`，或环境变量 `INSIGHTFORGE_LLM_PLAN_MAX_TOKENS` / `INSIGHTFORGE_LLM_SYNTHESIS_MAX_TOKENS` 覆盖；合法范围为 256–32768。
- 有效阶段预算随 `modelProvenance` 写入 run 和证据包，避免设置变化后丢失生成条件。
- `reasoning_content` 是最终答案之前的推理内容，不被回退当作结论；DeepSeek 官方也将其定义为 “before the final answer”：<https://api-docs.deepseek.com/api/create-chat-completion/>。
- 本次证明目标端点与样例输入通过，不构成生产 SLA、成本上限或所有模型兼容性证明。
