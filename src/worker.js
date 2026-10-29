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

// 批量删除（S3 DeleteObjects，单次最多 500 个）
app.post('/api/delete-batch', authGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const bucket = body.bucket
  const keys = (body.keys || []).filter((k) => typeof k === 'string' && k && !k.endsWith('/'))
  if (!bucket || !keys.length) return c.json({ error: 'missing bucket/keys' }, 400)
  if (keys.length > 500) return c.json({ error: '单次最多删除 500 个文件' }, 400)

  const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${keys
    .map((k) => `<Object><Key>${escXml(k)}</Key></Object>`)
    .join('')}</Delete>`
  const res = await c._r2.fetch(`${c._s3Base}/${bucket}?delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
  })
  if (!res.ok) return c.json({ error: `DeleteObjects failed: ${res.status}` }, 500)
  const rxml = await res.text()
  const errors = xmlBlocks(rxml, 'Error').map((e) => ({
    key: xmlPick(e, 'Key'),
    message: xmlPick(e, 'Message') || xmlPick(e, 'Error'),
  }))
  await caches.default.delete(statsCacheKey(bucket))
  return c.json({ ok: errors.length === 0, deleted: keys.length - errors.length, errors })
})

// 删除文件夹（按前缀递归列出所有对象并分批删除）
app.post('/api/delete-tree', authGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const bucket = body.bucket
  const prefixes = (body.prefixes || []).filter(
    (p) => typeof p === 'string' && p && p.endsWith('/')
  )
  if (!bucket || !prefixes.length) return c.json({ error: 'missing bucket/prefixes' }, 400)

  const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let deleted = 0
  const errors = []
  for (const prefix of prefixes) {
    let token = null
    do {
      // 分页列出该前缀下所有对象（不含 delimiter，递归含子文件夹）
      const u = new URL(`${c._s3Base}/${bucket}`)
      u.searchParams.set('list-type', '2')
      u.searchParams.set('prefix', prefix)
      u.searchParams.set('max-keys', '1000')
      if (token) u.searchParams.set('continuation-token', token)
      const res = await c._r2.fetch(u)
      if (!res.ok) {
        errors.push({ prefix, message: `ListObjects failed: ${res.status}` })
        break
      }
      const xml = await res.text()
      const keys = xmlBlocks(xml, 'Contents').map((o) => xmlPick(o, 'Key')).filter(Boolean)
      // S3 DeleteObjects 单次上限 1000，按 500 一批删
      for (let i = 0; i < keys.length; i += 500) {
        const batch = keys.slice(i, i + 500)
        const delXml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${batch
          .map((k) => `<Object><Key>${escXml(k)}</Key></Object>`)
          .join('')}</Delete>`
        const del = await c._r2.fetch(`${c._s3Base}/${bucket}?delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/xml' },
          body: delXml,
        })
        if (!del.ok) {
          errors.push({ prefix, message: `DeleteObjects failed: ${del.status}` })
          continue
        }
        const rxml = await del.text()
        deleted += batch.length - xmlBlocks(rxml, 'Error').length
        xmlBlocks(rxml, 'Error').forEach((e) =>
          errors.push({ key: xmlPick(e, 'Key'), message: xmlPick(e, 'Message') || xmlPick(e, 'Error') })
        )
      }
      token = xmlPick(xml, 'NextContinuationToken') || null
    } while (token)
  }
  if (deleted > 0) await caches.default.delete(statsCacheKey(bucket))
  return c.json({ ok: errors.length === 0, deleted, errors })
})

// 移动 / 重命名（CopyObject + DeleteObject，单次最多 100 个）
app.post('/api/move', authGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const bucket = body.bucket
  const items = Array.isArray(body.items) ? body.items : []
  if (!bucket || !items.length) return c.json({ error: 'missing bucket/items' }, 400)
  if (items.length > 100) return c.json({ error: '单次最多移动 100 个文件' }, 400)

  const failed = []
  let moved = 0
  for (const it of items) {
    const from = String(it.from || '')
    const to = String(it.to || '')
    if (!from || !to || from.endsWith('/') || to.endsWith('/') || from === to || to.includes('//')) {
      failed.push({ from, to, reason: '参数不合法' })
      continue
    }
    try {
      const res = await c._r2.fetch(objUrl(c, bucket, to), {
        method: 'PUT',
        headers: {
          'x-amz-copy-source': `/${bucket}/${from.split('/').map(encodeURIComponent).join('/')}`,
        },
      })
      if (!res.ok) {
        failed.push({ from, to, reason: `CopyObject failed: ${res.status}` })
        continue
      }
      const del = await c._r2.fetch(objUrl(c, bucket, from), { method: 'DELETE' })
      if (!del.ok && del.status !== 204) {
        failed.push({ from, to, reason: '复制成功但删除源文件失败' })
        continue
      }
      moved++
    } catch (e) {
      failed.push({ from, to, reason: e.message || 'unknown error' })
    }
  }
  await caches.default.delete(statsCacheKey(bucket))
  return c.json({ ok: failed.length === 0, moved, failed })
})

// 移动文件夹（递归：按前缀列举 → 逐个 CopyObject → 批量删除已复制的源对象）
app.post('/api/move-tree', authGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const bucket = body.bucket
  const failed = []
  const valid = []
  for (const raw of Array.isArray(body.items) ? body.items : []) {
    const from = String(raw.from || '')
    const to = String(raw.to || '')
    if (!from.endsWith('/') || !to.endsWith('/') || to.includes('//') || from === to) {
      failed.push({ from, to, reason: '参数不合法' })
    } else if (to.startsWith(from)) {
      failed.push({ from, to, reason: '不能移动到自身子目录' })
    } else {
      valid.push({ from, to })
    }
  }
  if (!bucket) return c.json({ error: 'missing bucket' }, 400)
  if (!valid.length) return c.json({ ok: false, moved: 0, folders: [], failed })

  const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let moved = 0
  const folders = []
  for (const it of valid) {
    let count = 0
    let token = null
    do {
      // 分页列出该前缀下所有对象（递归含子文件夹）
      const u = new URL(`${c._s3Base}/${bucket}`)
      u.searchParams.set('list-type', '2')
      u.searchParams.set('prefix', it.from)
      u.searchParams.set('max-keys', '1000')
      if (token) u.searchParams.set('continuation-token', token)
      const res = await c._r2.fetch(u)
      if (!res.ok) {
        failed.push({ from: it.from, to: it.to, reason: `ListObjects failed: ${res.status}` })
        break
      }
      const xml = await res.text()
      const keys = xmlBlocks(xml, 'Contents').map((o) => xmlPick(o, 'Key')).filter(Boolean)
      const copied = []
      for (const key of keys) {
        const nk = it.to + key.slice(it.from.length)
        try {
          const cp = await c._r2.fetch(objUrl(c, bucket, nk), {
            method: 'PUT',
            headers: {
              'x-amz-copy-source': `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
            },
          })
          if (cp.ok) {
            copied.push(key)
            count++
          } else {
            failed.push({ from: key, to: nk, reason: `CopyObject failed: ${cp.status}` })
          }
        } catch (e) {
          failed.push({ from: key, to: nk, reason: e.message || 'unknown error' })
        }
      }
      // 只删已成功复制的源对象，避免失败时丢数据，分批 500
      for (let i = 0; i < copied.length; i += 500) {
        const batch = copied.slice(i, i + 500)
        const delXml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${batch
          .map((k) => `<Object><Key>${escXml(k)}</Key></Object>`)
          .join('')}</Delete>`
        const del = await c._r2.fetch(`${c._s3Base}/${bucket}?delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/xml' },
          body: delXml,
        })
        if (!del.ok) {
          failed.push({ from: it.from, to: it.to, reason: `DeleteObjects failed: ${del.status}` })
        }
      }
      token = xmlPick(xml, 'NextContinuationToken') || null
    } while (token)
    moved += count
    folders.push({ from: it.from, to: it.to, count })
  }
  await caches.default.delete(statsCacheKey(bucket))
  return c.json({ ok: failed.length === 0, moved, folders, failed })
})

// 上传文件（Worker 代理转发到 R2，单文件上限 100MB）
app.post('/api/upload', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  if (key.endsWith('/')) return c.json({ error: 'bad key' }, 400)
  const len = Number(c.req.header('content-length') || 0)
  if (len > UPLOAD_CAP) return c.json({ error: '单文件最大 100MB' }, 413)

  const body = await c.req.arrayBuffer()
  const res = await c._r2.fetch(objUrl(c, bucket, key), {
    method: 'PUT',
    headers: {
      'Content-Type': c.req.header('content-type') || 'application/octet-stream',
      'Content-Length': String(body.byteLength),
    },
    body,
  })
  if (!res.ok) return c.json({ error: `PutObject failed: ${res.status}` }, 500)
  await caches.default.delete(statsCacheKey(bucket))
  return c.json({ ok: true, key })
})

// ---------- 分片上传（大文件：前端切片，R2 S3 multipart API 合并） ----------
// 初始化
app.post('/api/multipart/init', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  if (key.endsWith('/')) return c.json({ error: 'bad key' }, 400)
  const res = await c._r2.fetch(`${objUrl(c, bucket, key)}?uploads`, {
    method: 'POST',
    headers: { 'Content-Type': mimeFor(key) },
  })
  if (!res.ok) return c.json({ error: `CreateMultipartUpload failed: ${res.status}` }, 500)
  const m = (await res.text()).match(/<UploadId>([^<]+)<\/UploadId>/)
  if (!m) return c.json({ error: 'CreateMultipartUpload: no UploadId' }, 500)
  return c.json({ ok: true, uploadId: m[1] })
})

// 上传单个分片（≤64MB）
app.put('/api/multipart/part', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  const uploadId = c.req.query('uploadId')
  const partNumber = Number(c.req.query('partNumber'))
  if (!bucket || !key || !uploadId) return c.json({ error: 'missing params' }, 400)
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return c.json({ error: 'bad partNumber' }, 400)
  }
  const len = Number(c.req.header('content-length') || 0)
  if (len > 64 * 1024 * 1024) return c.json({ error: '分片最大 64MB' }, 413)

  const body = await c.req.arrayBuffer()
  const res = await c._r2.fetch(
    `${objUrl(c, bucket, key)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`,
    { method: 'PUT', headers: { 'Content-Length': String(body.byteLength) }, body }
  )
  if (!res.ok) return c.json({ error: `UploadPart failed: ${res.status}` }, 500)
  const etag = (res.headers.get('ETag') || '').replace(/"/g, '')
  if (!etag) return c.json({ error: 'UploadPart: no ETag' }, 500)
  return c.json({ ok: true, partNumber, etag })
})

// 完成合并
app.post('/api/multipart/complete', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  const uploadId = c.req.query('uploadId')
  if (!bucket || !key || !uploadId) return c.json({ error: 'missing params' }, 400)
  const body = await c.req.json().catch(() => ({}))
  const parts = Array.isArray(body.parts) ? body.parts : []
  if (!parts.length) return c.json({ error: 'missing parts' }, 400)
  const xml =
    '<CompleteMultipartUpload>' +
    parts
      .map((p) => `<Part><PartNumber>${Number(p.partNumber)}</PartNumber><ETag>"${String(p.etag).replace(/"/g, '')}"</ETag></Part>`)
      .join('') +
    '</CompleteMultipartUpload>'
  const res = await c._r2.fetch(
    `${objUrl(c, bucket, key)}?uploadId=${encodeURIComponent(uploadId)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/xml', 'Content-Length': String(xml.length) }, body: xml }
  )
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    return c.json({ error: `CompleteMultipartUpload failed: ${res.status} ${t.slice(0, 200)}` }, 500)
  }
  await caches.default.delete(statsCacheKey(bucket))
  return c.json({ ok: true, key })
})

// 取消/中止（清理已传分片）
app.post('/api/multipart/abort', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  const uploadId = c.req.query('uploadId')
  if (!bucket || !key || !uploadId) return c.json({ error: 'missing params' }, 400)
  await c._r2.fetch(`${objUrl(c, bucket, key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE' })
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

// ---------- 预览：文本 / zip ----------
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  pdf: 'application/pdf',
}
const TEXT_CAP = 2 * 1024 * 1024       // 文本预览上限 2MB
const ENTRY_CAP = 100 * 1024 * 1024    // zip 条目解压上限 100MB
const UPLOAD_CAP = 100 * 1024 * 1024   // 上传单文件上限 100MB

function mimeFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase()
  return MIME[ext] || 'application/octet-stream'
}

function u16(buf, off) {
  return buf[off] | (buf[off + 1] << 8)
}

function u32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
}

function objUrl(c, bucket, key) {
  return `${c._s3Base}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
}

async function s3GetRange(c, bucket, key, start, end) {
  const res = await c._r2.fetch(objUrl(c, bucket, key), {
    headers: { Range: `bytes=${start}-${end}` },
  })
  if (!res.ok && res.status !== 206) throw new Error(`R2 GET failed: ${res.status}`)
  return res
}

// 文本预览代理（同源，避免 CDN CORS 问题）
app.get('/api/text', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  const head = await c._r2.fetch(objUrl(c, bucket, key), { method: 'HEAD' })
  if (head.status === 404) return c.json({ error: 'not found' }, 404)
  if (!head.ok) return c.json({ error: `HEAD failed: ${head.status}` }, 500)
  if (Number(head.headers.get('content-length')) > TEXT_CAP) {
    return c.json({ error: '文件过大，请下载后查看' }, 413)
  }
  const res = await c._r2.fetch(objUrl(c, bucket, key))
  if (!res.ok) return c.json({ error: `GET failed: ${res.status}` }, 500)
  return new Response(await res.text(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
})

// 列出 zip（apk/ipa/jar 同为 zip 格式）内的文件：Range 读尾部 EOCD + 中央目录
app.get('/api/zip', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)

  const head = await c._r2.fetch(objUrl(c, bucket, key), { method: 'HEAD' })
  if (head.status === 404) return c.json({ error: 'not found' }, 404)
  if (!head.ok) return c.json({ error: `HEAD failed: ${head.status}` }, 500)
  const size = Number(head.headers.get('content-length'))
  if (!size) return c.json({ error: 'not found' }, 404)

  // 尾部 64KB + 注释区，找 EOCD
  const tailLen = Math.min(size, 65536 + 65535)
  const tail = await s3GetRange(c, bucket, key, size - tailLen, size - 1)
  const buf = new Uint8Array(await tail.arrayBuffer())
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return c.json({ error: '不是标准的 ZIP 格式' }, 400)
  const count = u16(buf, eocd + 10)
  const cdSize = u32(buf, eocd + 12)
  const cdOffset = u32(buf, eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) return c.json({ error: '暂不支持 ZIP64 格式' }, 400)

  const cd = await s3GetRange(c, bucket, key, cdOffset, cdOffset + cdSize - 1)
  const cbuf = new Uint8Array(await cd.arrayBuffer())
  const entries = []
  let dirCount = 0
  let p = 0
  while (p + 46 <= cbuf.length && entries.length < Math.min(count, 5000)) {
    if (u32(cbuf, p) !== 0x02014b50) break
    const method = u16(cbuf, p + 10)
    const compSize = u32(cbuf, p + 20)
    const uncompSize = u32(cbuf, p + 24)
    const nameLen = u16(cbuf, p + 28)
    const extraLen = u16(cbuf, p + 30)
    const commentLen = u16(cbuf, p + 32)
    const offset = u32(cbuf, p + 42)
    const name = new TextDecoder().decode(cbuf.subarray(p + 46, p + 46 + nameLen))
    if (!name.endsWith('/')) entries.push({ name, method, compSize, uncompSize, offset })
    else dirCount++
    p += 46 + nameLen + extraLen + commentLen
  }
  const fileTotal = count - dirCount
  return c.json({ bucket, key, total: fileTotal, entries, truncated: entries.length < fileTotal })
})

// 读取 zip 内单个文件（Range 取数据，deflate 用 DecompressionStream 解压）
app.get('/api/zip-entry', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  const name = c.req.query('name')
  const off = Number(c.req.query('off'))
  const csize = Number(c.req.query('csize'))
  const usize = Number(c.req.query('usize'))
  const method = Number(c.req.query('method'))
  const download = c.req.query('download') === '1'
  if (!bucket || !key || !name || ![off, csize, usize, method].every(Number.isFinite)) {
    return c.json({ error: 'missing params' }, 400)
  }
  if (usize > ENTRY_CAP) return c.json({ error: '文件过大，请下载整个压缩包查看' }, 413)

  // 本地文件头 30 字节，确定数据区起点
  const lh = await s3GetRange(c, bucket, key, off, off + 29)
  const lbuf = new Uint8Array(await lh.arrayBuffer())
  if (u32(lbuf, 0) !== 0x04034b50) return c.json({ error: 'ZIP 结构异常' }, 400)
  const dataStart = off + 30 + u16(lbuf, 26) + u16(lbuf, 28)

  const res = await s3GetRange(c, bucket, key, dataStart, dataStart + csize - 1)
  let body = res.body
  if (method === 8) {
    body = body.pipeThrough(new DecompressionStream('deflate-raw'))
  } else if (method !== 0) {
    return c.json({ error: `不支持的压缩算法: ${method}` }, 400)
  }
  const fname = name.split('/').pop()
  return new Response(body, {
    headers: {
      'Content-Type': mimeFor(name),
      'Content-Length': String(usize),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(fname)}`,
      'Cache-Control': 'no-store',
    },
  })
})

export default app
