# AI Synthesis：模型提出、程序校验与问题泛化

> 状态：`CURRENT — 2026-08-27`

## 三种综合模式

| `run.synthesisMode` | 触发条件 | 候选来源与边界 |
|---|---|---|
| `CACHED_MODEL_OUTPUT` | 默认黄金问题、无在线配置 | 读取认证模型 PLAN/SYNTHESIZE 缓存；明确标记缓存，不冒充本轮实时调用 |
| `LIVE_SINGLE_ENDPOINT` | 显式启用并完整配置唯一 HTTPS 端点 | 同一端点生成计划与候选；任何配置、网络、Schema 或引用失败都 fail-closed |
| `DETERMINISTIC_MISMATCH_BLOCK` | 问题不能使用黄金缓存，或测试显式关闭模型 | 只输出问题相关 EvidenceGap 或确定性边界；origin 为 `DETERMINISTIC`，不贴 AI 标签 |

## 黄金模型缓存校验

`fixtures/golden/model-cache-manifest.json` 锁定 PLAN 与 SYNTHESIZE 文件 SHA-256。加载时依次验证：

1. 缓存文件摘要；
2. 对应 prompt 文件摘要；
3. 精确研究问题；
4. Zod Schema；
5. PLAN 工具 allowlist、单一 Audit 锚点、末尾 Deliver 锚点；
6. 四个 SYNTHESIZE 语义角色唯一；
7. evidence ID 与 Assumption ID 全属于本轮图；
8. 37.1%、47.6%、31.3% 和 3.04 与确定性 Datum 一致。

模型只能提出文本和已知 ID，程序负责分配 Claim/Conclusion/CandidateRevision/EvidenceGap 的稳定关系。缓存被改一个字节、提示词变化、问题变化或数字与本轮计算不一致都会阻断。

## 在线单端点

在线模式需要 `INSIGHTFORGE_LLM=1` 及 API key、HTTPS base URL、model。它不支持：

- 多模型路由；
- 自动切换提供方；
- 失败后静默使用缓存；
- 模型自报来源；
- 未知 evidence ID；
- 少于 3 条有效候选。

传输只允许同一请求的最多两次有界重试，不更换模型或端点。密钥不进入事件、错误、证据包或日志。

## 问题泛化

缓存只属于黄金问题。光伏等无关问题不会得到新能源车预写结论，而是形成三类 EvidenceGap：

- 缺少问题相关权威信源；
- 缺少对应指标时间序列；
- 缺少量化和交叉验证，不能形成候选行业判断。

这些结论没有伪造 Evidence/Source 路径，全部阻止确认。该反证由 `tests/generalization.test.ts` 覆盖。

## 输入驱动 Audit

`src/audit.ts` 的六类规则读取当前结构化对象，不按固定业务 ID 播放剧本：

- 悬空证据 ID 被移除；
- AI 候选只有在存在有效 Evidence 或可重算 Datum 时才可能保持支持；
- 来源自述“没有数据”只能证明边界，不能支撑正向断言；
- 冲突值同时保留并标记候选解释；
- ESTIMATE 只能链接 Audit 前已存在的 Assumption，不能临时编造；
- 预测语言与 FACT 冲突时改为 FORECAST；
- 全称范围越界交人处理。

`tests/audit-input.test.ts` 证明给原证据不足 Claim 补入有效结构化证据后，Audit 不再重复同一降级；替换成未知 evidence ID 时，引用会被删除。最多只进行一轮自动修复。

## 人类责任

所有模型输出默认 `PENDING_REVIEW`。EDIT 创建 `HUMAN_EDITED CandidateRevision`，仍待复核；CONFIRM 是下一次独立动作。冲突、估算或预测确认必须带理由与适用范围。证据不足或 stale 内容无法确认。
