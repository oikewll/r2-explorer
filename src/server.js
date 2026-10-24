import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import crypto from 'node:crypto'

// ---------- env ----------
const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_PUBLIC_URL,
  R2_CDN_MAP,
  AUTH_PASSWORD,
  AUTH_SECRET,
  PORT = 3000,
} = process.env

for (const [k, v] of Object.entries({
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  AUTH_PASSWORD,
})) {
  if (!v) {
    console.error(`[fatal] missing env: ${k}`)
    process.exit(1)
  }
}

const SECRET = AUTH_SECRET || crypto.createHash('sha256').update(`r2-explorer:${AUTH_PASSWORD}`).digest('hex')
const S3_BASE = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`

let CDN_MAP = {}
try {
  CDN_MAP = R2_CDN_MAP ? JSON.parse(R2_CDN_MAP) : R2_PUBLIC_URL ? { '*': R2_PUBLIC_URL } : {}
} catch {
  CDN_MAP = {}
}

// ---------- s3 client ----------
const s3 = new S3Client({
  region: 'auto',
  endpoint: S3_BASE,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
})

// ---------- auth helpers ----------
const TOKEN_NAME = 'r2x_token'

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
}

function makeToken(ttlMs = 30 * 24 * 3600 * 1000) {
  const exp = Date.now() + ttlMs
  const payload = String(exp)
  return `${payload}.${sign(payload)}`
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return false
  const expect = sign(payload)
  if (sig.length !== expect.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false
  return Number(payload) > Date.now()
}

// ---------- format helpers ----------
function formatSize(bytes) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const n = bytes / Math.pow(1024, i)
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

function formatTime(date) {
  const d = new Date(date)
  const pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function encodedKey(key) {
  return key.split('/').map(encodeURIComponent).join('/')
}

// 有 CDN 自定义域就用它，否则给 7 天预签名直链
async function fileUrl(bucket, key) {
  const mapped = CDN_MAP[bucket] || CDN_MAP['*']
  if (mapped) {
    return { url: `${mapped.replace(/\/+$/, '')}/${encodedKey(key)}`, presigned: false }
  }
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 7 * 24 * 3600 }
  )
  return { url, presigned: true }
}

// ---------- app ----------
const app = new Hono()

const authGuard = async (c, next) => {
  if (verifyToken(getCookie(c, TOKEN_NAME))) return next()
  return c.json({ error: 'unauthorized' }, 401)
}

// login / logout
app.post('/api/login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const a = Buffer.from(String(body.password || ''))
  const b = Buffer.from(AUTH_PASSWORD)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return c.json({ error: '密码错误' }, 401)
  }
  setCookie(c, TOKEN_NAME, makeToken(), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 3600,
  })
  return c.json({ ok: true })
})

app.post('/api/logout', (c) => {
  deleteCookie(c, TOKEN_NAME, { path: '/' })
  return c.json({ ok: true })
})

app.get('/api/me', authGuard, (c) => c.json({ ok: true }))

// ---------- 桶统计（内存缓存 1 小时） ----------
const STATS_TTL_MS = 3600 * 1000
const statsCache = new Map() // bucket -> { stats, expires }

function getCachedStats(bucket) {
  const hit = statsCache.get(bucket)
  if (hit && hit.expires > Date.now()) return hit.stats
  if (hit) statsCache.delete(bucket)
  return null
}

// 列出账号下所有 R2 桶（附带缓存的统计信息）
app.get('/api/buckets', authGuard, async (c) => {
  const res = await s3.send(new ListBucketsCommand({}))
  const names = (res.Buckets || []).map((b) => b.Name).filter(Boolean).sort()
  const buckets = names.map((name) => ({ name, stats: getCachedStats(name) }))
  return c.json({ buckets })
})

// 桶统计：分页列举聚合对象数/总大小/最后更新时间
app.get('/api/stats', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  if (!bucket) return c.json({ error: 'missing bucket' }, 400)

  const cached = getCachedStats(bucket)
  if (cached) return c.json({ bucket, stats: cached, cached: true })

  let objects = 0
  let size = 0
  let lastModified = null
  let token
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: 1000,
        ContinuationToken: token,
      })
    )
    for (const o of res.Contents || []) {
      objects++
      size += o.Size || 0
      const lm = o.LastModified ? new Date(o.LastModified).toISOString() : null
      if (lm && (!lastModified || lm > lastModified)) lastModified = lm
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)

  const stats = {
    objects,
    size,
    sizeText: formatSize(size),
    lastModified,
    modifiedText: lastModified ? formatTime(lastModified) : null,
    computedAt: new Date().toISOString(),
  }
  statsCache.set(bucket, { stats, expires: Date.now() + STATS_TTL_MS })
  return c.json({ bucket, stats, cached: false })
})

// 删除单个文件
app.delete('/api/object', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  if (key.endsWith('/')) return c.json({ error: '不支持删除文件夹' }, 400)

  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  statsCache.delete(bucket)
  return c.json({ ok: true })
})

// list（按桶）
app.get('/api/list', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const prefix = c.req.query('prefix') || ''
  if (!bucket) return c.json({ error: 'missing bucket' }, 400)
  if (prefix && !prefix.endsWith('/')) return c.json({ error: 'bad prefix' }, 400)

  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      Delimiter: '/',
      MaxKeys: 1000,
    })
  )

  const dirs = (res.CommonPrefixes || []).map((p) => ({
    type: 'dir',
    name: p.Prefix.slice(prefix.length).replace(/\/$/, ''),
    path: p.Prefix,
  }))

  const files = []
  for (const o of res.Contents || []) {
    if (o.Key === prefix) continue
    files.push({
      type: 'file',
      name: o.Key.slice(prefix.length),
      path: o.Key,
      size: o.Size,
      sizeText: formatSize(o.Size),
      modified: o.LastModified,
      modifiedText: formatTime(o.LastModified),
      url: '',
      presigned: false,
    })
  }

  await Promise.all(
    files.map(async (f) => {
      const { url, presigned } = await fileUrl(bucket, f.path)
      f.url = url
      f.presigned = presigned
    })
  )

  dirs.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))

  const crumbs = [{ name: '根目录', path: '' }]
  let acc = ''
  for (const seg of prefix.split('/').filter(Boolean)) {
    acc += seg + '/'
    crumbs.push({ name: seg, path: acc })
  }

  return c.json({ bucket, prefix, crumbs, dirs, files, truncated: res.IsTruncated || false })
})

// single file head info
app.get('/api/info', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  let res
  try {
    res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode
    if (code === 404 || e.name === 'NotFound') return c.json({ error: 'not found' }, 404)
    return c.json({ error: `HeadObject failed: ${code || e.message}` }, 500)
  }
  const { url, presigned } = await fileUrl(bucket, key)
  return c.json({
    bucket,
    key,
    size: res.ContentLength,
    sizeText: formatSize(res.ContentLength),
    modified: res.LastModified,
    modifiedText: formatTime(res.LastModified),
    contentType: res.ContentType || '',
    etag: (res.ETag || '').replace(/"/g, ''),
    url,
    presigned,
  })
})

// static frontend (public/index.html serves at /)
app.use('/*', serveStatic({ root: './public' }))

serve({ fetch: app.fetch, port: Number(PORT) }, (info) => {
  console.log(`[r2-explorer] listening on http://localhost:${info.port}`)
})
