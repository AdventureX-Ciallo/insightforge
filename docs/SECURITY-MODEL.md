# 安全与租户模型（审计基线）

本文档定义 InsightForge 的信任模型与安全边界，供安全审计与评审对照。所有断言均可在源码中逐条定位。

## 租户模型：单租户 / 单用户 / 单会话

- **网络边界**：服务仅绑定 loopback 字面地址（`127.0.0.1`、`::1`）。配置 `localhost` 时先验证全部 DNS 答案都是回环地址，再绑定一个已验证的字面 IP；绑定任何非回环地址直接拒绝。
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

- **出站请求（SSRF 三重拦截）**：仅 http/https；请求前按固定 HTTPS DoH → 宿主机 DNS → 固定 `1.1.1.1:53` 的可配置链解析，并对每个解析器返回的全部 v4/v6 保留段/环回/私有网段做 BlockList 校验；搜索引擎目标额外限引擎域名白名单。三跳可分别通过严格的 `0/1` 环境开关禁用，链路与失败尝试进入 `dnsResolution`；任一解析器返回危险地址即停止，不再回退。fake-IP 代理保留段（198.18.0.0/15）命中时明确报错并保持 fail-closed（`src/tools/search-engines.ts`；fuzz ssrf-prefetch 套 125,000 例不变量：**零出站 fetch**）。该链减少单解析器故障并提供可观测性，不固定后续 `fetch` 使用的 IP，因此不声称消除 DNS TOCTOU。
- **出站响应内存上限**：搜索引擎、单一实时搜索提供方、权威来源校验和 DoH 响应均先校验声明长度，再逐块累计实际字节；缺失或伪造 `Content-Length` 时仍会在达到各自上限的第一个超限块立即取消响应流，禁止先完整缓冲再检查（`src/tools/limited-response.ts`）。
- **上传校验与配额**：扩展名/MIME/字节内容三层校验，5 MiB 单文件、20 个对象和 32 MiB 聚合上限，路径穿越拒绝，落盘 0600 + 随机名 + SHA-256 回执（`src/tools/upload-validator.ts`、`src/upload-store.ts`；fuzz upload-whitelist 165,000 例）。同工作区并发上传在存储层串行检查配额；文件、记录、孤儿和坏元数据都计入占用。24 小时 TTL 到期后记录与文件成对清理，访问已过期 ID 返回 410。XLSX 在解压任何条目前还会校验中央目录：最多 10,000 条、单条最多 16 MiB、全包解压后最多 50 MiB；上传校验和实际读取共用同一不变量（`src/tools/xlsx-container.ts`）。
- **提示词注入惰性化**：来源文本在前端仅以 `textContent` 渲染；在线 PLAN/SYNTHESIZE 把问题、来源、摘录、数据和公式封装为转义后的未受信任 JSON 数据，system 消息明确禁止服从材料指令，程序再拒绝明显的“忽略任务/读取凭据”输出回声。黄金 PDF 与在线 mock 均内置注入诱饵，测试断言其不改变工具边界、不进入可执行计划或有效候选、不读取环境变量（`tests/security.test.ts`、`tests/llm-branches.test.ts`）。这不是通用语义级注入检测；普通错误候选仍依赖 Evidence ID、Audit 和人工确认边界。
- **DOM 与响应头**：CSP `default-src 'self'`、`referrer-policy: no-referrer`（测试断言）。
- **成果文本转义**：交互界面继续使用 `textContent`；可下载 Markdown 对包括 `<`、`>` 在内的 Markdown/HTML 标点逐字符转义，来源中的 `<script>`、`<img onerror>` 只能作为文字保留，不能形成 raw HTML 标签。
- **并发写完整性**：同一 runId 的人工决定与来源更新按队列串行化，防丢失更新（`src/server.ts:255` serializeRunMutation；并发测试证明 EDIT+update 双保留）。
- **凭据卫生**：key 仅从环境变量或本地设置文件读取，源码/示例/测试零凭据字面量；仓库密钥扫描纳入 `npm run verify` 门禁（当前 170 个 tracked/untracked 且未忽略的文件通过）。
- **回环服务请求边界**：写请求必须携带进程内随机 request key；浏览器请求同时校验 loopback `Origin` 与 `Sec-Fetch-Site`，JSON 端点拒绝 safelisted `text/plain`。首页通过 CSP nonce 引导脚本为同源写请求自动加头，`GET /api/request-key` 不开放 CORS。`INSIGHTFORGE_DISABLE_REQUEST_KEY=1` 仅是明确标注为不安全的本地调试开关。
- **运行资源边界**：同时最多两个五状态任务，超限 fail-closed 为 429；最近十个任务之外的 progress 与 run/artifact 目录成对淘汰，当前与执行中任务受保护。上传的 20 对象/32 MiB/24 小时边界独立执行，不能靠运行淘汰替代。
- **SSE 资源边界**：每个 run 最多 4 个订阅、全局最多 6 个，超限返回 `429 SSE_CAPACITY_EXCEEDED`；60 秒没有新的 step/tool 业务事件即发送可重连的 `stream-end` 并清除 socket、心跳和 idle timer，不取消后台任务。
- **DNS rebinding 防护**：每个请求在路由前校验 `Host`，只接受 `127.0.0.1` 或 `[::1]` 与当前实际监听端口的组合；未验证的 `localhost`、缺失、重复、畸形、非回环或端口失配均 fail-closed。
- **产物边界**：所有交付文件路径校验必须位于工作区目录内（`assertInsideWorkspace`）。

## 随机化验证

安全与状态相关不变量由 `npm run fuzz` 持续验证（seed 可复现）：引擎 30 例、ResearchRun 结构 284,970 例、人工决定幂等性 1,000 例、真实 HTTP API 5,000 例、Audit 104,000 例、上传 165,000 例、SSRF 125,000 例；合计 685,000 例，对 6,840 行生产 TypeScript 达到 100.15 例/行。SSRF 套件断言危险输入的出站 fetch 始终为零。

## 已知未验证边界（诚实声明）

- 真实搜索引擎访问在本机被 fake-IP 代理 DNS 阻断（正确 fail-closed）；演示场地需直连网络。
- 线上模型调用的最终代码态未在无 key 环境实测；机制与早前通过端到端验证的版本同源。
- Windows 桌面版 PowerPoint 未验证（macOS 真机已通过打开/编辑/保存/重开验证）。
