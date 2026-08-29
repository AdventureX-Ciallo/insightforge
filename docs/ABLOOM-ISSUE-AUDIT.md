# ABloom25 Issue 逐项解决审计

> 状态：`IN PROGRESS — 2026-08-29`。范围只含 GitHub 用户 `abloom25` 提出的 Issue；`minc-nice-100` 的 Issue 按所有者要求不在本轮处理范围。每项必须完成复现、TDD、多模型递归对抗、不定参数随机测试、完整门禁和 GitHub 证据闭环后才标记完成。

## 当前清单

| Issue | 状态 | 当前证据 |
|---:|---|---|
| #42 Windows autocrlf 破坏 fixtures | 已关闭 | commit `8ac4e49`；`.gitattributes`、真实 autocrlf clone、source ZIP 摘要复算、159/159、fuzz、E2E |
| #43 推理模型耗尽 max_tokens | 已通过本地终审，待提交并关闭 | StepFun 真实 RED/GREEN、163/163、八套 fuzz 694,100、E2E |
| #44 200 截断/空 JSON 不重试 | 待处理 | — |
| #45 实时运行 source-update 写死 ID | 待复核已有修复 | — |
| #46 rejectedDrafts 不落盘 | 待处理 | — |
| #47 STALE 无复核恢复路径 | 待处理 | — |
| #48 settings.json 明文 API Key | 待处理 | — |
| #49 PDF 未嵌入 CJK 字体 | 待处理 | — |
| #50 报告内容质量 | 待处理 | — |

## #42 Windows autocrlf 破坏 fixtures

### 复现与修复

- RED：缺少 `.gitattributes` 时，门禁测试以 `ENOENT` 失败；Issue 描述的 `core.autocrlf=true` 会改写普通文本控制文件。
- GREEN：新增 `fixtures/** -text`，保持缓存、提示词、CSV、PDF 及未来夹具的原始字节。
- 真实测试创建临时 Git 仓库并以 `core.autocrlf=true` 克隆；仓库外控制文件必须精确变成 CRLF，而所有 fixture 必须逐字节不变。
- 源仓库、克隆目录和源码 ZIP 都从 `model-cache-manifest.json` 重算认证缓存 SHA-256；不能仅比较两个同样被污染的目录。
- 系统无 Git 可执行文件时仍执行静态属性合同，只跳过依赖外部 Git 的 clone 探针，因此 source ZIP 的 Node 门禁不被额外运行时依赖阻断。

### 不定参数随机反证

每次测试随机生成 64 个 fixture，覆盖：目录深度 0–6、ASCII/中文/空格/emoji 路径、JSON/CSV/TXT/XML/MD/BIN 扩展名，以及空文件、无换行、LF、CRLF、mixed 五种内容。Git 索引使用 NUL 分隔并归一化 Windows 路径；失败信息携带当轮 nonce。

### 多模型递归审查

1. StepFun 3.7 Flash 第一轮指出“源文件已为 CRLF 时源/克隆相等”的假阳性；补入 manifest 摘要复算与精确控制文件断言。
2. DeepSeek V4 Flash 指出固定夹具数量和两份正则会产生未来假失败；改为逐个随机路径索引断言并复用同一属性规则。
3. Codex 多代理审查指出 Git 二进制被意外变成 source ZIP 的硬依赖；加入仅在 `ENOENT` 时的外部探针 skip，其他 Git 失败继续 fail-closed。
4. StepFun 3.7 Flash 对修正后版本递归复审为 PASS，明确 #42 可关闭；多个独立 Codex 审查也为 PASS。
5. GLM-5.3-Flash 经 Claude Code 两次及原生 Anthropic Messages 接口一次强制请求，均被账户级 429 配额拒绝；没有产生审查结论，因此未计作通过证据。

### 门禁

- `npm run verify`：159/159；`src/**` 四项覆盖率 100%；secret scan；contract 23/23；seed `520628262` fuzz 685,000。
- `npm run test:e2e`：1/1，真实 Chromium 黄金路径和 PPTX 下载解析通过。
- 无 `public/` 修改；未部署、未打 Tag、未重新打包最终 ZIP。

## #43 推理模型耗尽 max_tokens

### 复现与修复

- RED：保持旧请求预算时，StepFun 3.7 Flash 的 PLAN 使用 `max_tokens=2048` 返回 HTTP 200、`finish_reason=length`、2,048 completion tokens，但可见 `content` 为 0 字符，程序无法取得计划 JSON。
- GREEN：PLAN/SYNTHESIZE 默认预算分别提升到 `8192/16384`。同一真实端点使用最终提示词后，两阶段均以 `finish_reason=stop` 返回可解析 JSON；PLAN 生成 7 步，SYNTHESIZE 生成 4 条候选。
- 两阶段预算可由环境变量或 `/api/settings/llm` 独立覆盖，合法范围为 256–32768；无效值在任何外部请求前 fail-closed。API 设置整体优先于环境变量。
- 实际使用的两阶段预算写入 `modelProvenance`；只执行在线 PLAN 的低匹配拒答不会伪造 SYNTHESIZE 预算。
- PLAN 字段、候选正文、证据 ID、假设和证据缺口同时受提示词合同与确定性程序上限约束，防止更大预算把无界模型输出带入持久化。
- `reasoning_content` 只视作思考过程，不会被解析成最终 JSON；#44 的 HTTP 200 空/截断响应重试问题保持独立处理。

完整、脱敏且不含凭据的真实端点记录见 `docs/verification/ABLOOM-43-STEPFUN-LIVE-2026-08-29.md`。

### 不定参数随机反证

新增 `llm-reasoning-budget` seeded fuzz 套件 1,000 例，随机化研究问题、输入、是否覆盖两阶段预算、合法预算边界、候选字段长度/数量和 PLAN 字段长度。判定器使用独立字面量作为 oracle，不复用生产常量；首轮在 `auxiliaryCount=0` 时发现 oracle 对空数组 `.every()` 的错误预期，修正测试自身后固定 seed `2008943002` 全量通过。

### 多模型递归审查

1. StepFun 3.7 Flash 与 DeepSeek V4 Flash 首轮指出默认值测试可能自证、端点输出上限兼容和 fuzz oracle 风险；补入随机 override、真实 StepFun RED/GREEN、可配置预算和独立 oracle。
2. 多个 Codex 审查指出预算需要进入溯源、超长输出需要持久化前拦截、低匹配运行不能声称执行了 SYNTHESIZE；均已修复并测试。
3. 递归复审只重复指出首轮已发现并已修正的空辅助数组 oracle；当前源码已含 `(auxiliaryCount === 0 || auxiliaryLength <= 500)`，固定根 seed 的完整八套 fuzz 通过。
4. “把 `reasoning_content` 当最终答案”的建议与官方接口语义冲突，未采纳；“为所有提供方改用其他 token 字段”超出当前单一 OpenAI-compatible 端点合同，改为明确能力边界并允许预算覆盖。
5. GLM-5.3-Flash 受账户级 429 配额阻断，没有产生可验证审查结论，因此没有把它计作通过证据。

### 门禁

- `npm run verify`：163/163；`src/**` statements/branches/functions/lines 四项 100%；175 文件 secret scan；contract 23/23；seed `520628262` 八套 fuzz 694,100（6,931 行生产 TypeScript，100.14 例/行）。
- `npm run test:e2e`：1/1，真实 Chromium 黄金路径通过，测试体 3.7 s、命令总耗时 7.9 s。
- `npm audit --audit-level=high`：0 vulnerabilities。
- 无 `public/` 修改；未部署、未打 Tag、未重新打包最终 ZIP。
