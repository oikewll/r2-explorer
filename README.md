# R2 Explorer

基于 Cloudflare R2 的轻量文件管理器：绑定**多个 Cloudflare 账号**并随时切换、浏览账号下**所有 R2 存储桶**、查看文件大小/时间、一键复制 CDN 直链。

- 后端：Node.js + [Hono](https://hono.dev)（API 不变，Workers 与 Docker 双部署）
- 前端：[Vite](https://vite.dev) + [React](https://react.dev) + [Tailwind CSS v4](https://tailwindcss.com) + zustand，hash 路由（`#/桶名/路径/`），适配手机与 PC
- 鉴权：密码登录，HMAC 签名 HttpOnly Cookie，30 天有效
- 多账号：界面里绑定/编辑/解绑多个 R2 账号，顶栏一键切换，绑定前自动验证凭证
- 新建桶：首页（桶总览）一键新建存储桶，无需去 Cloudflare 控制台
- 直链策略：各账号的 `CDN 映射` 里配置了自定义域的桶用 CDN 链接；未配置的桶自动生成 **7 天预签名直链**
- 部署：Cloudflare Workers（推荐，静态资产托管）或 Docker 自托管

## 多账号管理

登录后点击顶栏 **齿轮图标** 进入「R2 账号管理」：

- **绑定**：填备注名称、Account ID、Access Key ID / Secret Access Key（Cloudflare 控制台「R2 → 管理 R2 API 令牌」创建），保存前会用凭证真实调一次 ListBuckets 验证
- **切换**：顶栏下拉框直接切换当前使用的账号，或 在管理弹窗里点「使用」
- **编辑**：改备注名、CDN 映射、换密钥（密钥留空表示不修改）
- **解绑**：只解除工具与账号的关联，存储桶和文件不受影响

账号配置存放在：

| 部署方式 | 存储 | 说明 |
| --- | --- | --- |
| Cloudflare Workers | KV namespace `ACCOUNTS_KV` | 需在 `wrangler.toml` 取消注释 KV 配置并填入 id：`wrangler kv namespace create ACCOUNTS_KV` |
| Docker / Node | `data/accounts.json` | Docker 部署建议挂载卷持久化：`-v ./data:/app/data` |

未配置多账号存储时，自动回退为单账号模式：使用 `R2_ACCOUNT_ID` + `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` 环境变量（界面里标记为「内置」账号，不可编辑删除）。若手动绑定了与内置相同 Account ID 的账号，内置项会自动隐藏去重。

## Cloudflare Workers 部署（推荐）

前端（`web/`）构建产物在 `web/dist`，通过 **Workers Static Assets** 托管（`wrangler.toml` 的 `[assets]` 配置），Worker 只处理 `/api/*`。**如果你使用自定义 `wrangler.prod.toml`，必须包含同样的 `[assets]` 段**：

```toml
[assets]
directory = "./web/dist"
not_found_handling = "single-page-application"
```

```bash
npm run build:web       # 先构建前端（CI 也会自动构建）
wrangler deploy
wrangler secret put AUTH_PASSWORD          # 登录密码
wrangler secret put R2_ACCESS_KEY_ID       # R2 API Token 的密钥
wrangler secret put R2_SECRET_ACCESS_KEY
```

`wrangler.toml` 里的 vars：`R2_ACCOUNT_ID`、`R2_CDN_MAP`（JSON，桶名 → CDN 域）。这两个作为「内置默认账号」，登录后可在界面里绑定更多账号（存 KV，见「多账号管理」）。

## CI/CD（GitHub Actions）

打 `v*` tag 推送即自动部署 Worker（CI 会先构建前端再部署），成功/失败都会推 Telegram 通知：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

需要两个仓库 Actions secrets：

| Secret | 说明 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID（仪表盘右侧栏可查） |
| `CLOUDFLARE_API_TOKEN` | API Token，用 Cloudflare 预设模板「编辑 Cloudflare Workers」，需包含 Workers Scripts:Edit、Workers Routes:Edit |

可选配置：

| 变量 | 类型 | 说明 |
| --- | --- | --- |
| `TELEGRAM_WEBHOOK_URL` | secret | 部署成功/失败推送通知到自己的 webhook（请求体为 `{ fields: [{ label, value }] }` JSON） |
| `WRANGLER_CONFIG` | variable | 指定自己的 wrangler 配置文件（如 `wrangler.prod.toml`，可放真实自定义域/KV id），默认用仓库内 `wrangler.toml` |
| `DEPLOY_URL` | variable | 通知消息里展示的线上地址 |

## 本地开发

后端（Node）与前端（Vite dev server）两个进程，前端已配置 `/api` 代理：

```bash
cp .env.example .env   # 填好 R2 凭证与 AUTH_PASSWORD
npm install
npm run dev            # 后端 http://localhost:3000
npm run dev:web        # 前端 http://localhost:5173（开发时访问这个）
```

## Docker 部署

```bash
docker build -t r2-explorer .    # 多段构建：先构建前端，再打运行镜像

docker run -d --name r2-explorer -p 3000:3000 \
  -v ./data:/app/data \
  --env-file .env --restart unless-stopped r2-explorer
```

挂载 `./data` 卷用于持久化界面里绑定的多账号配置（`data/accounts.json`）。

## WebDAV（Docker/Node 版）

自托管版内置 WebDAV 服务，挂载点 `/dav/`：根集合 = 当前激活账号的所有桶，`/dav/桶名/路径` 即文件。认证为 HTTP Basic：**用户名任意，密码 = 登录密码**（`AUTH_PASSWORD`）。

```bash
# rclone 挂载为本地磁盘
rclone mount :webdav: --webdav-url=http://localhost:3000/dav/ --webdav-user=any \
  --webdav-pass=$(rclone obscure 你的登录密码) /mnt/r2

# rclone 直接读写
rclone ls :webdav, url=http://localhost:3000/dav/, user=any, pass=$(rclone obscure 你的密码):桶名

# macOS Finder：前往 → 连接服务器 → http://主机:3000/dav/
# Windows 资源管理器：映射网络驱动器 → http://主机:3000/dav/
```

支持 OPTIONS / PROPFIND / GET / HEAD / PUT（流式直传，大文件不吃内存）/ DELETE / MKCOL / COPY / MOVE / LOCK / UNLOCK。注意：目录为 R2 前缀合成（空目录用零字节标记兜底）；桶本身不能通过 WebDAV 删除；Workers 版无此功能。

## 离线下载（Docker/Node 版）

文件列表工具栏的「离线下载」：粘贴 http/https 直链，服务器在后台流式下载并**分块直传 R2（不落盘）**，支持 GB 级大文件。链接粘贴后自动探测文件名与大小（优先读 Content-Disposition），可手动改名。任务并发 2 个，超出排队；任务列表实时显示进度与速率，失败可重试，服务重启后未完成任务标记失败可手动重试。Workers 版无此功能。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | `{ password }`，成功后种 Cookie |
| POST | `/api/logout` | 清除 Cookie |
| GET | `/api/me` | 会话检查 |
| GET | `/api/accounts` | 账号列表（密钥只返回掩码） |
| POST | `/api/accounts` | 绑定新账号（先验证凭证再保存） |
| PUT | `/api/accounts/:id` | 编辑账号（名称/CDN 映射/密钥，密钥留空不改） |
| DELETE | `/api/accounts/:id` | 解绑账号 |
| POST | `/api/accounts/:id/activate` | 切换为当前使用账号 |
| GET | `/api/buckets` | 列出当前账号下所有桶 |
| POST | `/api/buckets` | 新建存储桶 `{ name }`（当前账号下，名称仅小写字母/数字/连字符） |
| GET | `/api/list?bucket=x&prefix=a/` | 列目录（文件夹 + 文件 + 直链） |
| GET | `/api/info?bucket=x&key=a/b` | 单文件详情（大小/时间/ETag/类型） |
| DELETE | `/api/object?bucket=x&key=a/b` | 删除单个文件 |
| POST | `/api/delete-batch` | `{ bucket, keys: [] }` 批量删除（≤500） |
| POST | `/api/move` | `{ bucket, items: [{ from, to }] }` 移动/重命名（≤100） |
| GET | `/api/text?bucket=x&key=a/b` | 文本预览代理（≤2MB） |
| GET | `/api/zip` / `/api/zip-entry` | 压缩包目录 / 包内文件读取 |
| POST | `/api/upload` | 原始 body 直传，单文件 ≤100MB |
| POST | `/api/multipart/init` / `part` / `complete` / `abort` | 分片上传（>50MB 自动走此通道，分片 ≤64MB，数量不限） |
