# R2 Explorer API 说明

> 面向二次开发 / 脚本调用的 HTTP API 参考。MCP 服务端点单独见 [README「MCP 服务」章节](../README.md#mcp-服务外部-agent-接入)与 [docs/mcp-readonly-design.md](mcp-readonly-design.md)。
>
> 除非特别标注，所有接口在 **Node/Docker 版**（`src/server.js`）与 **Cloudflare Workers 版**（`src/worker.js`）行为一致。

## 通用约定

- **鉴权**：除 `/api/login` / `/api/logout` 外全部需要会话。登录成功后种 HttpOnly Cookie `r2x_token`（HMAC 签名，30 天有效），后续请求自动携带
- **请求体**：`POST`/`PUT` 接口均为 `application/json`（`/api/upload` 除外，为原始二进制流）
- **错误格式**：`{ "error": "原因描述" }`，配合对应 HTTP 状态码（400 参数错误 / 401 未登录 / 404 不存在 / 409 冲突 / 413 超限 / 500 内部错误）
- **路径格式**：`bucket` 为桶名；`key` 为对象完整路径（不含桶名）；目录以 `/` 结尾（R2 没有真实目录，目录 = 前缀约定）
- **直链策略**：账号 CDN 映射里配置了的桶返回 CDN 直链，未配置的返回 7 天预签名 URL（响应中 `presigned: true` 标识）

```bash
# 典型调用流程
curl -c cookie.txt -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' -d '{"password":"你的密码"}'
curl -b cookie.txt 'http://localhost:3000/api/list?bucket=demo&prefix='
```

## 认证与会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | `{ password }`，成功种 Cookie |
| POST | `/api/logout` | 清除 Cookie |
| GET | `/api/me` | 会话检查，`{ ok: true }` |

## 账号管理（多账号）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/accounts` | 账号列表（密钥只返回掩码 `keyMask`），含 `activeId` |
| POST | `/api/accounts` | 绑定新账号 `{ name, accountId, accessKeyId, secretAccessKey, apiToken?, cdnMap? }`，保存前真实调 ListBuckets 验证凭证 |
| PUT | `/api/accounts/:id` | 编辑账号（名称 / CDN 映射 / 密钥，字段留空表示不修改） |
| DELETE | `/api/accounts/:id` | 解绑账号（不影响 R2 上数据） |
| POST | `/api/accounts/:id/activate` | 切换为当前使用账号 |
| GET | `/api/accounts/export` | 导出全部账号配置（含明文密钥，注意保管） |
| POST | `/api/accounts/import` | 导入账号配置（与 export 格式对应） |
| GET | `/api/plan` | 当前账号 Cloudflare 计划信息（Free/Paid，带缓存） |

## 存储桶

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/buckets` | 列出当前激活账号下所有桶，附缓存统计 `stats`（无缓存为 `null`） |
| POST | `/api/buckets` | 新建桶 `{ name }`（小写字母/数字/连字符，3–63 字符）；同名返回 409 |
| DELETE | `/api/buckets/:name` | 删除桶（必须为空，否则 409） |
| GET | `/api/stats?bucket=x` | 单桶统计：对象数 / 总大小 / 按类型分布 / 最后更新时间（缓存 1 小时；最多扫描 5 万对象，超出 `truncated: true`） |

## 浏览与读取

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/list?bucket=x&prefix=a/` | 列目录单层：`dirs`（子目录）+ `files`（含 size/modified/url 直链）+ `truncated`（单次 MaxKeys=1000） |
| GET | `/api/search?bucket=x&q=关键词&prefix=a/&limit=100` | 全桶递归搜索，完整路径大小写不敏感子串匹配；limit ≤300，最多扫描 5 万对象，返回 `more`/`scanned` |
| GET | `/api/info?bucket=x&key=a/b` | 单文件详情：size / contentType / etag / modified / url / presigned |
| GET | `/api/text?bucket=x&key=a/b` | 文本预览代理（utf-8，≤2MB，超限 413） |
| GET | `/api/raw?bucket=x&key=a/b` | 对象内容同源代理，支持 `Range` 请求头（图片画布 / 音视频播放用） |

## 写操作

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/upload?bucket=x&key=a/b` | 原始 body 直传（Content-Type 为文件类型），单文件 ≤100MB |
| POST | `/api/multipart/init` / `part` / `complete` / `abort` | 分片上传：`init` `{bucket,key}` → `part?bucket&key&uploadId&partNumber`（原始 body，分片 ≤64MB）→ `complete` `{bucket,key,uploadId,parts:[{PartNumber,ETag}]}`；中断用 `abort`。>50MB 前端自动走此通道 |
| DELETE | `/api/object?bucket=x&key=a/b` | 删除单个文件（不支持目录前缀） |
| POST | `/api/delete-batch` | `{ bucket, keys: [] }` 批量删除（≤500/次） |
| POST | `/api/delete-tree` | `{ bucket, prefixes: ["a/", "b/"] }` 按前缀递归删除整个目录 |
| POST | `/api/move` | `{ bucket, items: [{ from, to }] }` 移动/重命名（≤100，复制+删除语义） |
| POST | `/api/move-tree` | `{ bucket, items: [{ from, to }] }` 整目录移动（from/to 均以 `/` 结尾） |
| POST | `/api/mkdir?bucket=x&key=a/` | 建目录（写入零字节占位对象，key 必须以 `/` 结尾） |

## 压缩包

| 方法 | 路径 | 部署 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/zip?bucket=x&key=a.zip` | 双端 | zip 系（zip/apk/ipa/jar/xapk/epub）条目列表（Range 手工解析中央目录） |
| GET | `/api/zip-entry?bucket=x&key=a.zip&entry=b.txt` | 双端 | 读取包内单个文件（支持 Range） |
| GET | `/api/ar-entry?bucket=x&key=a.rar&entry=b` | 仅 Node | rar/7z/tar 包内文件读取（WASM 解析） |
| POST | `/api/extract` | 仅 Node | 服务端整包解压 `{ bucket, key, dest? }`，后台任务 |
| GET | `/api/extract/status` | 仅 Node | 解压任务进度 |
| POST | `/api/extract/cancel` | 仅 Node | 取消解压任务 |
| POST | `/api/extract-batch` | 仅 Workers | 前端驱动分批解压（免费版 CPU 受限，见 README） |

## 离线下载

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/download/resolve` | `{ url }` 预探测直链的文件名/大小（Content-Disposition 优先） |
| GET | `/api/download/tasks` | 任务列表（实时进度/速率） |
| POST | `/api/download/tasks` | 创建任务 `{ url, bucket, key? }`，后台流式下载直传 R2 |
| POST | `/api/download/tasks/:id/retry` | 重试失败任务 |
| DELETE | `/api/download/tasks/:id` | 删除任务记录 |
| POST | `/api/download/clear` | 清空已完成/失败任务 |

Node/Docker 版支持 multipart 分片（约 80GB 上限，并发 2）；Workers 版单流直传（默认 100MB，`OFFLINE_MAX_SIZE_MB` 可调）。

## 音视频转码（仅 Node/Docker，需镜像含 ffmpeg）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/capabilities` | 能力探测：`{ transcode, offlineDownload, extract }` |
| POST | `/api/transcode/start` | `{ bucket, key }` 后台转 HLS（mkv/avi 等浏览器不能直接播的格式） |
| POST | `/api/transcode/stop` | `{ id }` 停止转码 |
| GET | `/api/transcode/:id/:file` | 取 HLS 分片（index.m3u8 / *.ts） |

## MCP 端点

`POST /mcp` —— MCP 协议（JSON-RPC 2.0 over Streamable HTTP），Bearer `MCP_TOKEN` 鉴权，只读工具集 7 个。启用方式、客户端接入示例与安全边界见 [README「MCP 服务」章节](../README.md#mcp-服务外部-agent-接入)与 [docs/mcp-readonly-design.md](mcp-readonly-design.md)。

## WebDAV

`/dav/` 挂载点（仅 Node/Docker 版），HTTP Basic 认证（用户名任意，密码 = 登录密码）。支持 OPTIONS / PROPFIND / GET / HEAD / PUT / DELETE / MKCOL / COPY / MOVE / PROPPATCH / LOCK / UNLOCK。详见 [docs/webdav-and-offline-download.md](webdav-and-offline-download.md)。
