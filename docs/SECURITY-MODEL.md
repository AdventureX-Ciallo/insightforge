# 安全与租户模型（审计基线）

本文档定义 InsightForge 的信任模型与安全边界，供安全审计与评审对照。所有断言均可在源码中逐条定位。

## 租户模型：单租户 / 单用户 / 单会话

- **网络边界**：服务仅接受 loopback 监听（`127.0.0.1`、`::1`、`localhost`）。绑定任何非回环地址直接抛错，错误信息明示 "single-user software"（`src/server.ts:21,610-612`；`tests/server.test.ts` 断言拒绝 `0.0.0.0`）。
- **用户体系**：不存在登录、会话、角色、令牌。全代码库中唯一的鉴权字符串是出站调用模型端点的 `Authorization: Bearer` 头（`src/llm.ts`）。
- **状态模型**：单 `currentRun` + 进程内 `jobs` Map（`src/server.ts:241,247`）——一个进程一份世界，进程即租户；无数据库，持久化为 `.insightforge/` 下的文件 JSON。
- **设计依据**：任务书 P0-08 明文要求"不实现用户系统、角色权限或多人协作；单用户、单会话即可"。单租户是规格要求，非实现捷径。

**审计基线**：本产品应按"本地桌面软件"信任模型审计，而非 Web 多租户标准。

## 信任模型内的暴露面（如实列出）

| 暴露面 | 现状 | 处置 |
|---|---|---|
| 同机进程可访问 4399 端口（无认证） | 属单用户桌面威胁模型内 | 演示机不运行不可信软件；勿在共享机器常驻 |
| `.insightforge/settings.json` 明文保存模型 key | 文件权限 0600，仅本用户可读 | 演示后删除该文件或轮换 key；GET /api/settings/llm 永远返回掩码，不回显明文 |
| 上传目录按文件名+SHA-256 隔离（非按用户） | 单租户下无隔离语义 | 若未来多租户化需重设计存储命名空间 |

## 已实现的安全控制（含证据锚点）

- **出站请求（SSRF 三重拦截）**：仅 http/https；请求前 DNS 解析并对全部 v4/v6 保留段/环回/私有网段做 BlockList 校验；搜索引擎目标额外限引擎域名白名单。fake-IP 代理保留段（198.18.0.0/15）命中时明确报错并保持 fail-closed（`src/tools/search-engines.ts`；fuzz ssrf-prefetch 套 100,000 例不变量：**零出站 fetch**）。
- **上传校验**：扩展名/MIME/字节内容三层校验，5 MiB 上限，路径穿越拒绝，落盘 0600 + 随机名 + SHA-256 回执（`src/tools/upload-validator.ts`、`src/upload-store.ts`；fuzz upload-whitelist 165,000 例）。
- **提示词注入惰性化**：来源文本在前端仅以 `textContent` 渲染；黄金 PDF 内置注入诱饵，测试断言其不改变计划、不触发额外工具、不成为确认结论、不读取环境变量（`tests/security.test.ts`）。
- **DOM 与响应头**：CSP `default-src 'self'`、`referrer-policy: no-referrer`（测试断言）。
- **并发写完整性**：同一 runId 的人工决定与来源更新按队列串行化，防丢失更新（`src/server.ts:255` serializeRunMutation；并发测试证明 EDIT+update 双保留）。
- **凭据卫生**：key 仅从环境变量或本地设置文件读取，源码/示例/测试零凭据字面量；仓库密钥扫描纳入 `npm run verify` 门禁（当前 236 文件通过）。
- **产物边界**：所有交付文件路径校验必须位于工作区目录内（`assertInsideWorkspace`）。

## 随机化验证

安全相关不变量由 `npm run fuzz` 持续验证（seed 可复现）：SSRF 100,000 例零出站、上传 165,000 例白名单外全拒、API 5,000 例真实 HTTP 永不 5xx、结构模糊 150,000 例非法输入全被 Zod 拒绝。

## 已知未验证边界（诚实声明）

- 真实搜索引擎访问在本机被 fake-IP 代理 DNS 阻断（正确 fail-closed）；演示场地需直连网络。
- 线上模型调用的最终代码态未在无 key 环境实测；机制与早前通过端到端验证的版本同源。
- Windows 桌面版 PowerPoint 未验证（macOS 真机已通过打开/编辑/保存/重开验证）。
