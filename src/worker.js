import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { AwsClient } from 'aws4fetch'
import INDEX_HTML from '../public/index.html'

// ---------- format helpers ----------
function formatSize(bytes) {
  if (!bytes) return '0 B'
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

// ---------- xml helpers (R2 S3 API 返回 XML) ----------
function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function xmlBlocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1])
}

function xmlPick(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return m ? decodeXml(m[1]) : ''
}

// ---------- crypto (Web Crypto, Workers-compatible) ----------
const enc = new TextEncoder()

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function bufToBase64url(buf) {
  let s = ''
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacSign(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return bufToBase64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)))
}

async function deriveSecret(password) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`r2-explorer:${password}`))
  return bufToHex(digest)
}

const TOKEN_NAME = 'r2x_token'
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000
const PRESIGN_EXPIRES = 7 * 24 * 3600 // R2 SigV4 预签名最长 7 天

// ---------- app ----------
const app = new Hono()

app.use('*', async (c, next) => {
  c._secret = c.env.AUTH_SECRET || (await deriveSecret(c.env.AUTH_PASSWORD || ''))
  c._r2 = new AwsClient({
    accessKeyId: c.env.R2_ACCESS_KEY_ID,
    secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  })
  c._s3Base = `https://${c.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  let map = {}
  try {
    map = JSON.parse(c.env.R2_CDN_MAP || '{}')
  } catch {}
  c._cdnMap = map
  await next()
})

// login / logout
app.post('/api/login', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const input = String(body.password || '')
  if (!input || !timingSafeEqualStr(input, c.env.AUTH_PASSWORD || '')) {
    return c.json({ error: '密码错误' }, 401)
  }
  const exp = String(Date.now() + TOKEN_TTL_MS)
  setCookie(c, TOKEN_NAME, `${exp}.${await hmacSign(exp, c._secret)}`, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: TOKEN_TTL_MS / 1000,
    secure: true,
  })
  return c.json({ ok: true })
})

app.post('/api/logout', (c) => {
  deleteCookie(c, TOKEN_NAME, { path: '/' })
  return c.json({ ok: true })
})

const authGuard = async (c, next) => {
  const token = getCookie(c, TOKEN_NAME) || ''
  const [payload, sig] = token.split('.')
  let ok = false
  if (payload && sig && Number(payload) > Date.now()) {
    ok = timingSafeEqualStr(sig, await hmacSign(payload, c._secret))
  }
  if (!ok) return c.json({ error: 'unauthorized' }, 401)
  await next()
}

app.get('/api/me', authGuard, (c) => c.json({ ok: true }))

// ---------- 桶统计缓存（Cache API，1 小时） ----------
const STATS_TTL = 3600
const statsCacheKey = (bucket) =>
  new Request(`https://r2x-cache.internal/stats/${encodeURIComponent(bucket)}`)

async function getCachedStats(bucket) {
  const cached = await caches.default.match(statsCacheKey(bucket))
  return cached ? cached.json() : null
}

async function putCachedStats(bucket, stats) {
  await caches.default.put(
    statsCacheKey(bucket),
    new Response(JSON.stringify(stats), {
      headers: { 'Cache-Control': `public, max-age=${STATS_TTL}` },
    })
  )
}

// 列出账号下所有 R2 桶（附带缓存的统计信息）
app.get('/api/buckets', authGuard, async (c) => {
  const res = await c._r2.fetch(c._s3Base + '/')
  if (!res.ok) return c.json({ error: `ListBuckets failed: ${res.status}` }, 500)
  const xml = await res.text()
  const names = xmlBlocks(xml, 'Bucket').map((b) => xmlPick(b, 'Name')).filter(Boolean).sort()
  const buckets = await Promise.all(
    names.map(async (name) => ({ name, stats: await getCachedStats(name) }))
  )
  return c.json({ buckets })
})

// 桶统计：分页列举聚合对象数/总大小/最后更新时间
app.get('/api/stats', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  if (!bucket) return c.json({ error: 'missing bucket' }, 400)

  const cached = await getCachedStats(bucket)
  if (cached) return c.json({ bucket, stats: cached, cached: true })

  let objects = 0
  let size = 0
  let lastModified = null
  let token = null
  do {
    const u = new URL(`${c._s3Base}/${bucket}`)
    u.searchParams.set('list-type', '2')
    if (token) u.searchParams.set('continuation-token', token)
    const res = await c._r2.fetch(u)
    if (!res.ok) return c.json({ error: `ListObjects failed: ${res.status}` }, 500)
    const xml = await res.text()
    for (const obj of xmlBlocks(xml, 'Contents')) {
      objects++
      size += Number(xmlPick(obj, 'Size')) || 0
      const lm = xmlPick(obj, 'LastModified')
      if (lm && (!lastModified || lm > lastModified)) lastModified = lm
    }
    token = xmlPick(xml, 'NextContinuationToken') || null
  } while (token)

  const stats = {
    objects,
    size,
    sizeText: formatSize(size),
    lastModified,
    modifiedText: lastModified ? formatTime(lastModified) : null,
    computedAt: new Date().toISOString(),
  }
  await putCachedStats(bucket, stats)
  return c.json({ bucket, stats, cached: false })
})

// 删除单个文件
app.delete('/api/object', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  if (key.endsWith('/')) return c.json({ error: '不支持删除文件夹' }, 400)

  const res = await c._r2.fetch(`${c._s3Base}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'DELETE',
  })
  if (!res.ok && res.status !== 204) return c.json({ error: `DeleteObject failed: ${res.status}` }, 500)

  // 统计缓存失效
  await caches.default.delete(statsCacheKey(bucket))
  return c.json({ ok: true })
})

// file URL：有 CDN 自定义域就用它，否则给 7 天预签名直链
async function fileUrl(c, bucket, key) {
  const encoded = key.split('/').map(encodeURIComponent).join('/')
  const base = c._cdnMap[bucket]
  if (base) return { url: `${base.replace(/\/+$/, '')}/${encoded}`, presigned: false }
  const signed = await c._r2.sign(
    new Request(`${c._s3Base}/${bucket}/${encoded}?X-Amz-Expires=${PRESIGN_EXPIRES}`),
    { aws: { signQuery: true } }
  )
  return { url: signed.url, presigned: true }
}

// list（按桶）
app.get('/api/list', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const prefix = c.req.query('prefix') || ''
  if (!bucket) return c.json({ error: 'missing bucket' }, 400)
  if (prefix && !prefix.endsWith('/')) return c.json({ error: 'bad prefix' }, 400)

  const u = new URL(`${c._s3Base}/${bucket}`)
  u.searchParams.set('list-type', '2')
  u.searchParams.set('delimiter', '/')
  u.searchParams.set('max-keys', '1000')
  if (prefix) u.searchParams.set('prefix', prefix)

  const res = await c._r2.fetch(u)
  if (res.status === 404) return c.json({ error: 'bucket not found' }, 404)
  if (!res.ok) return c.json({ error: `ListObjects failed: ${res.status}` }, 500)
  const xml = await res.text()

  const dirs = xmlBlocks(xml, 'CommonPrefixes')
    .map((b) => xmlPick(b, 'Prefix'))
    .filter(Boolean)
    .map((p) => ({
      type: 'dir',
      name: p.slice(prefix.length).replace(/\/$/, ''),
      path: p,
    }))

  const files = []
  for (const obj of xmlBlocks(xml, 'Contents')) {
    const key = xmlPick(obj, 'Key')
    if (key === prefix) continue
    const size = Number(xmlPick(obj, 'Size')) || 0
    const modified = xmlPick(obj, 'LastModified')
    files.push({
      type: 'file',
      name: key.slice(prefix.length),
      path: key,
      size,
      sizeText: formatSize(size),
      modified,
      modifiedText: formatTime(modified),
      url: '',
      presigned: false,
    })
  }

  // 批量生成直链
  await Promise.all(
    files.map(async (f) => {
      const { url, presigned } = await fileUrl(c, bucket, f.path)
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

  return c.json({ bucket, prefix, crumbs, dirs, files, truncated: xml.includes('<IsTruncated>true</IsTruncated>') })
})

// single file head info
app.get('/api/info', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)

  const res = await c._r2.fetch(`${c._s3Base}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'HEAD',
  })
  if (res.status === 404) return c.json({ error: 'not found' }, 404)
  if (!res.ok) return c.json({ error: `HeadObject failed: ${res.status}` }, 500)

  const size = Number(res.headers.get('content-length')) || 0
  const modified = res.headers.get('last-modified')
  const { url, presigned } = await fileUrl(c, bucket, key)
  return c.json({
    bucket,
    key,
    size,
    sizeText: formatSize(size),
    modified,
    modifiedText: formatTime(modified),
    contentType: res.headers.get('content-type') || '',
    etag: (res.headers.get('etag') || '').replace(/"/g, ''),
    url,
    presigned,
  })
})

// frontend
app.get('/', (c) => c.html(INDEX_HTML))

export default app
