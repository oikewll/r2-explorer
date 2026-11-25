# R2 Explorer MCP 服务设计（只读版 v1）

> 状态：已评审，随 v2.18.1 实施（2026-11-25）
> 变更记录：端点路径由设计时的 `/mcp` 调整为 `/file/mcp`——r2.quputech.com 域名上已部署的 `quputech-mcp` Worker（官网服务）占用了 `/mcp` 路由，本服务避开冲突。
> 范围：为外部 Agent（WorkBuddy / Claude / Cursor 等）暴露只读 MCP 端点，覆盖「查看存储情况、浏览/搜索文件、读取文本内容、获取下载直链」场景。写操作不在本版范围。

## 1. 背景与目标

R2 Explorer 已有完整的 Web UI + REST API，但 API 依赖 Cookie 登录流程，外部 Agent 无法直接使用。MCP（Model Context Protocol）是当前主流的 Agent 工具接入协议，提供一个 `/file/mcp` 端点后，任意 MCP 客户端配一个 URL + Token 即可让 Agent 管理/查询 R2 存储。

**目标**
- 双部署可用：Node/Docker（`server.js`）与 Cloudflare Workers（`worker.js`）都暴露相同工具集
- 只读工具集 7 个，覆盖存储概览 → 定位文件 → 读内容/拿直链的完整链路
- 独立 Token 鉴权，未配置时端点完全关闭
- MCP 层是薄封装，不引入新业务逻辑，不改现有任何路由

**非目标（v1 明确不做）**
- 上传、删除、移动、建桶、账号管理等任何写操作（v2 再议，见 §9）
- stdio 传输（只有本地 Docker 能用，Workers 场景无意义）
- MCP resources / prompts / sampling 能力（只做 tools）
- Web UI 里的 MCP 配置面板

## 2. 总体架构

```
外部 Agent (MCP Client)
   │  JSON-RPC 2.0 over HTTP POST /file/mcp
   │  Authorization: Bearer <MCP_TOKEN>
   ▼
src/mcp-core.js  ← 协议处理 + 工具 schema + 参数校验（部署无关）
   │  注入 backend 函数（每个部署各自实现，包装已有 S3 访问逻辑）
   ├─ server.js backend：@aws-sdk/client-s3（getClient / ListBucketsCommand ...）
   └─ worker.js  backend：aws4fetch（手工签 V4 + XML 解析）
   ▼
Cloudflare R2 S3 API
```

**代码组织**（遵循仓库现状：server/worker 本就是两套平行实现）

| 文件 | 改动 | 内容 |
|---|---|---|
| `src/mcp-core.js` | 新增 ~300 行 | JSON-RPC 分发、`initialize`/`tools/list`/`tools/call`、7 个工具的 inputSchema 与结果序列化。纯函数式，不 import 任何 S3 库 |
| `src/server.js` | 新增 ~60 行 | `registerMcp(app, makeServerBackend())`；backend 用现成的 `getClient(acc)` / `fileUrl` / SDK Command |
| `src/worker.js` | 新增 ~60 行 | 同上；backend 用 aws4fetch 签名请求（照抄本文件现有 list/search/info 的写法） |

不抽公共 backend 的理由：worker 与 server 的 S3 访问层（SDK vs aws4fetch）无法共用，现有代码也是整段平行复制；MCP backend 每个部署只有几十行，强行抽象反而增加耦合。

## 3. 鉴权方案

### Token 设计
- 新增环境变量 `MCP_TOKEN`：
  - Node：env 变量（docker-compose / systemd 注入）
  - Workers：`wrangler secret put MCP_TOKEN`（不进 wrangler.prod.toml）
- **未设置 `MCP_TOKEN` 时，`/file/mcp` 返回 404**（连端点存在性都不暴露，而不是 401）
- 验证：`Authorization: Bearer <token>`，常量时间比较（Node 用 `crypto.timingSafeEqual`；Workers 复用现有 `timingSafeEqualStr`）
- 不复用 `AUTH_PASSWORD`：token 会明文写进各客户端配置文件，必须与主密码隔离，泄露时可单独吊销轮换

### 不走 Cookie 的原因
MCP 客户端只会透传静态 header，不会执行登录表单流程。静态 Bearer Token 是各客户端（WorkBuddy 自定义连接器、Claude、Cursor）唯一通用方式。

### 与 Web 鉴权的关系
`/file/mcp` 路由**不挂**现有 `authGuard`（Cookie 中间件），自带独立 Bearer 校验；也不要求先登录 Web。Token 权限 = 「当前激活账号」的只读视角，与 Web 登录后看到的范围一致（多账号切换仍以 Web 端激活的账号为准）。

## 4. 协议实现（手写，零新依赖）

只实现 Streamable HTTP 的最小合规子集，`POST /file/mcp` 单一端点：

| JSON-RPC method | 行为 |
|---|---|
| `initialize` | 返回 `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "r2-explorer", version } }`。protocolVersion 回显客户端请求值（不认识则回 `"2025-06-18"`） |
| `notifications/initialized` 等 notification | 无 id 的消息，直接回 `204` |
| `tools/list` | 返回 7 个工具的 name/description/inputSchema |
| `tools/call` | 参数校验 → 调 backend → `content: [{ type: "text", text: "<JSON 结果>" }]`；出错时返回 `isError: true` + 错误文本（不用 JSON-RPC error，工具级错误走工具结果更利于 Agent 自纠错） |
| `ping` | 回 `{}` |

- 响应用普通 JSON（Streamable HTTP 允许，无需 SSE——本服务无服务端主动推送需求）
- 无会话状态：不签发 `Mcp-Session-Id`，每次请求独立处理，天然支持无状态部署/多实例
- HTTP 层：非 POST 或缺 Bearer → 404（同「未启用」处理，见 §3）；JSON 解析失败 → `-32700`
- Workers 兼容性：全程 Web Crypto / 纯 JS，无 Node API

## 5. 工具集（7 个，全只读）

通用约定：
- `bucket` 参数：桶名；`key`：完整对象路径（不含桶名）；`prefix`：目录前缀，必须以 `/` 结尾或为空串（与 `/api/list` 行为一致）
- 所有列表结果附带 `url` 字段（复用 `fileUrl` 逻辑：配了 CDN 映射的桶给 CDN 直链，否则给 7 天预签名 URL）

### 5.1 `list_buckets`
列出当前激活账号下所有桶。
- 输入：`{}`
- 输出：`{ buckets: [{ name, objects?, sizeText? }], account: "<账号备注名>" }`
- 统计部分复用内存缓存（`getCachedStats`），无缓存时不现算（避免 Agent 随手一调就全桶遍历），只返回 `null`

### 5.2 `bucket_stats`
单桶统计。
- 输入：`{ bucket: string }`
- 输出：`{ objects, size, sizeText, lastModified, byType: { image/video/audio/document/other: { count, size } } }`
- 复用现有缓存（1 小时 TTL）；未命中时现算（遍历最多 5 万对象后截断，返回 `truncated: true` 警示）——对超大桶做上限保护，`/api/stats` 现版本是无上限遍历，MCP backend 里加 `MAX_SCAN = 50000`

### 5.3 `list_objects`
列单层目录（Delimiter=/）。
- 输入：`{ bucket: string, prefix?: string }`
- 输出：`{ bucket, prefix, dirs: [{ name, path }], files: [{ name, path, size, sizeText, modified, url }], truncated }`
- 单次 `MaxKeys=1000`，与 `/api/list` 相同；`truncated=true` 时提示 Agent 进入子目录或加前缀

### 5.4 `search_objects`
全桶递归搜索。
- 输入：`{ bucket: string, q: string, prefix?: string, limit?: number (默认 50, 上限 200) }`
- 输出：`{ files: [{ name, path, dir, size, sizeText, url }], more, scanned }`
- 逻辑同 `/api/search`（大小写不敏感子串匹配，MAX_SCAN 5 万）

### 5.5 `get_file_info`
单文件元信息。
- 输入：`{ bucket: string, key: string }`
- 输出：`{ size, sizeText, contentType, etag, modified, url, presigned }`

### 5.6 `read_text_file`
读取文本内容。
- 输入：`{ bucket: string, key: string, maxChars?: number (默认 65536, 上限 262144) }`
- 行为：
  - HEAD 检查大小 > 2MB（`TEXT_CAP`）→ 报错建议用 `get_file_url`
  - 按 utf-8 读取，超过 `maxChars` 截断并在结果里标 `truncated: true, totalSize`
  - 结果含疑似二进制检测（前 8KB 出现 NUL 字节则拒绝，提示用 `get_file_url`）
- 输出：`{ text, truncated, totalSize, url }`（url 兜底给 Agent 拿直链）

### 5.7 `get_file_url`
获取下载直链。
- 输入：`{ bucket: string, key: string, expiresIn?: number }`（`expiresIn` 仅对预签名桶生效，3600–604800 秒，默认 7 天；CDN 桶忽略）
- 输出：`{ url, presigned, expiresAt? }`

### 工具 description 写法要求
每个工具 description 里写明：路径格式（`bucket/key`，目录以 `/` 结尾）、R2 无真实目录的概念、truncated 时怎么办。这是 Agent 正确使用的关键，比 schema 本身更重要。

## 6. 输出体积控制（保护 Agent context）

- 列表类工具单层最多 1000 条、搜索默认 50 条，文本默认 64K 字符——上限都在合理 context 范围内
- 结果统一 `JSON.stringify` 后放 text content，字段名用短名（不重复给 `sizeText` 这类冗余字段以外的人读格式……保留 `sizeText/modified` 各一份，够用即可）
- 不返回 base64 内容（v1 没有二进制读取工具，`get_file_url` 承接）

## 7. 部署与配置

### Node / Docker
```env
MCP_TOKEN=<openssl rand -hex 32 生成>
```
docker-compose 加一行 env 即可。

### Cloudflare Workers（生产路径）
```bash
wrangler secret put MCP_TOKEN   # 本地不落盘，CI 从 secret 还原
```
`wrangler.prod.toml` 不新增 vars。部署流程不变：打 tag → CI 还原 secrets → `wrangler deploy`。

### 客户端接入示例
WorkBuddy 自定义连接器 / Claude / Cursor 通用配置：
```json
{
  "mcpServers": {
    "r2-explorer": {
      "url": "https://r2.quputech.com/file/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

### 本地验证
```bash
# initialize
curl -s http://localhost:3000/file/mcp -H 'Authorization: Bearer xxx' \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# tools/list / tools/call 同理
```
再用 MCP Inspector 交叉验证：`npx @modelcontextprotocol/inspector`（connect 类型选 Streamable HTTP）。

## 8. 安全评估

| 风险 | 处置 |
|---|---|
| Token 泄露 | 只读权限 + 独立于主密码，可随时 `wrangler secret put` 轮换；建议 90 天轮换习惯 |
| 端点探测 | 未配 token / 鉴权失败一律 404，不泄露端点存在性 |
| 超大桶统计打爆 | `bucket_stats` 现算上限 5 万对象 + 1h 缓存；搜索同样有 MAX_SCAN |
| context 爆炸 | 5.6/§6 的截断策略 |
| CDN 直链外泄 | CDN 桶直链本来就是公开 URL 语义；预签名 URL 最长 7 天（R2 上限），与 Web 端现状一致 |
| 多账号越权 | MCP 只看「当前激活账号」，绑定/切换账号仍需走 Web UI（有登录密码），MCP 面天然收窄 |

## 9. v2 展望（本次不实现）

- 写操作工具：`put_object`（≤2MB base64）、`delete_objects`（必须 `confirm: true`）、`move`、`mkdir`；删除树/删桶永不进 MCP
- 独立写 token（`MCP_TOKEN_WRITE`）或 token scope，与读 token 分离
- 大文件上传：返回分片上传指引或引导走 WebDAV（Basic 认证已现成）

## 10. 实施清单

1. `src/mcp-core.js`：协议分发 + 7 个工具 schema/序列化（部署无关，纯 JS）
2. `src/server.js`：`registerMcp` + server backend（复用 `getClient`/`fileUrl`/Command）
3. `src/worker.js`：`registerMcp` + worker backend（aws4fetch，照抄现有 list/search 写法）
4. README 增补「MCP 服务」章节（配置、接入示例、安全说明）
5. 本地 Docker 验证 7 个工具 + Inspector 交叉验证
6. 发版：minor 升版（动手前先 `git fetch origin --tags --prune` 确认下一个版本号），tag 触发 CI 部署，`wrangler secret put MCP_TOKEN` 配置生产 token
