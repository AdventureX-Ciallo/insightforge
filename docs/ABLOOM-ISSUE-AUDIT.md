# ABloom25 Issue 逐项解决审计

> 状态：`IN PROGRESS — 2026-08-29`。范围只含 GitHub 用户 `abloom25` 提出的 Issue；`minc-nice-100` 的 Issue 按所有者要求不在本轮处理范围。每项必须完成复现、TDD、多模型递归对抗、不定参数随机测试、完整门禁和 GitHub 证据闭环后才标记完成。

## 当前清单

| Issue | 状态 | 当前证据 |
|---:|---|---|
| #42 Windows autocrlf 破坏 fixtures | 已通过本地终审，待提交并关闭 | `.gitattributes`、真实 autocrlf clone、source ZIP 摘要复算、159/159、fuzz、E2E |
| #43 推理模型耗尽 max_tokens | 待处理 | — |
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
