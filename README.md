# R2 Explorer

基于 Cloudflare R2 的轻量文件管理器：浏览账号下**所有 R2 存储桶**、查看文件大小/时间、一键复制 CDN 直链。

- 后端：Node.js + [Hono](https://hono.dev)
- 前端：单页原生 HTML/CSS/JS，hash 路由（`#/桶名/路径/`），适配手机与 PC
- 鉴权：密码登录，HMAC 签名 HttpOnly Cookie，30 天有效
- 直链策略：`R2_CDN_MAP` 里配置了自定义域的桶用 CDN 链接；未配置的桶自动生成 **7 天预签名直链**
- 部署：Cloudflare Workers（推荐）或 Docker 自托管

## Cloudflare Workers 部署（推荐）

```bash
wrangler deploy
wrangler secret put AUTH_PASSWORD          # 登录密码
wrangler secret put R2_ACCESS_KEY_ID       # R2 API Token 的密钥
wrangler secret put R2_SECRET_ACCESS_KEY
```

`wrangler.toml` 里的 vars：`R2_ACCOUNT_ID`、`R2_CDN_MAP`（JSON，桶名 → CDN 域）。

## 本地开发

```bash
cp .env.example .env   # 填好 R2 凭证与 AUTH_PASSWORD
npm install
npm run dev            # http://localhost:3000
```

## Docker 部署

```bash
docker build -t r2-explorer .

docker run -d --name r2-explorer -p 3000:3000 \
  --env-file .env --restart unless-stopped r2-explorer
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | `{ password }`，成功后种 Cookie |
| POST | `/api/logout` | 清除 Cookie |
| GET | `/api/me` | 会话检查 |
| GET | `/api/buckets` | 列出账号下所有桶 |
| GET | `/api/list?bucket=x&prefix=a/` | 列目录（文件夹 + 文件 + 直链） |
| GET | `/api/info?bucket=x&key=a/b` | 单文件详情（大小/时间/ETag/类型） |
