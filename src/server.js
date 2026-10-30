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
  DeleteObjectsCommand,
  CopyObjectCommand,
  PutObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

// ---------- env ----------
const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_PUBLIC_URL,
  R2_CDN_MAP,
  AUTH_PASSWORD,
  AUTH_SECRET,
  ACCOUNTS_FILE,
  PORT = 3000,
} = process.env

if (!AUTH_PASSWORD) {
  console.error('[fatal] missing env: AUTH_PASSWORD')
  process.exit(1)
}
// R2_* 凭证不再是启动必填：没配时仍可在界面里绑定账号（存 data/accounts.json）
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.warn('[warn] 未配置 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY，请在网页「账号管理」里绑定 R2 账号')
}

const SECRET = AUTH_SECRET || crypto.createHash('sha256').update(`r2-explorer:${AUTH_PASSWORD}`).digest('hex')

// ---------- 多账号管理（Node 端存 data/accounts.json） ----------
const ACCOUNTS_PATH = path.resolve(ACCOUNTS_FILE || './data/accounts.json')

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'))
    if (s && Array.isArray(s.accounts)) return { accounts: s.accounts, activeId: s.activeId || '' }
  } catch {}
  return { accounts: [], activeId: '' }
}

const store = loadStore()

function saveStore() {
  fs.mkdirSync(path.dirname(ACCOUNTS_PATH), { recursive: true })
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(store, null, 2))
}

function envAccount() {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null
  let map = {}
  try { map = R2_CDN_MAP ? JSON.parse(R2_CDN_MAP) : R2_PUBLIC_URL ? { '*': R2_PUBLIC_URL } : {} } catch {}
  return {
    id: 'env',
    name: '默认账号',
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    cdnMap: map,
    builtin: true,
  }
}

// 生效账号 = 用户绑定的账号 + env 内置账号（同 accountId 自动去重，隐藏内置）
function effectiveAccounts() {
  const list = [...store.accounts]
  const envAcc = envAccount()
  if (envAcc && !list.some((a) => a.accountId === envAcc.accountId)) list.push(envAcc)
  return list
}

function sanitizeAccount(a) {
  const key = a.accessKeyId || ''
  return {
    id: a.id,
    name: a.name,
    accountId: a.accountId,
    keyMask: key ? key.slice(0, 4) + '****' + key.slice(-2) : '',
    cdnMap: a.cdnMap || {},
    builtin: !!a.builtin,
    createdAt: a.createdAt,
  }
}

// S3Client 按账号缓存复用
const s3Clients = new Map()
function getClient(acc) {
  let client = s3Clients.get(acc.id)
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${acc.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: acc.accessKeyId,
        secretAccessKey: acc.secretAccessKey,
      },
    })
    s3Clients.set(acc.id, client)
  }
  return client
}

// 绑定/改密钥前先真实调一次 ListBuckets 验证凭证
async function validateCreds(accountId, accessKeyId, secretAccessKey) {
  const probe = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  try {
    await probe.send(new ListBucketsCommand({}))
    return null
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode
    if (code === 401 || code === 403 || e.name === 'InvalidAccessKeyId' || e.name === 'SignatureDoesNotMatch') {
      return '凭证验证失败：请检查 Access Key ID / Secret Access Key（需 R2 权限的 API Token）'
    }
    return `凭证验证失败（HTTP ${code || '未知'}）：${e.message || e}`
  }
}

// 解析 CDN 映射字段：接受对象或 JSON 字符串，缺省/空视为 {}，非法返回 { error }
function parseCdnMap(input) {
  let m = input
  if (m === undefined || m === null) return { value: {} }
  if (typeof m === 'string') {
    if (!m.trim()) return { value: {} }
    try { m = JSON.parse(m) } catch { return { error: 'CDN 映射不是合法 JSON' } }
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: 'CDN 映射格式不正确（应为 { "桶名": "https://域名" }）' }
  return { value: m }
}

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
async function fileUrl(c, bucket, key) {
  const mapped = c._cdnMap[bucket] || c._cdnMap['*']
  if (mapped) {
    return { url: `${mapped.replace(/\/+$/, '')}/${encodedKey(key)}`, presigned: false }
  }
  const url = await getSignedUrl(
    c._s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 7 * 24 * 3600 }
  )
  return { url, presigned: true }
}

// ---------- app ----------
const app = new Hono()

// 每个请求按「当前激活账号」绑定 S3 客户端与 CDN 映射
app.use('*', async (c, next) => {
  const list = effectiveAccounts()
  const acc = list.find((a) => a.id === store.activeId) || list[0] || null
  c._account = acc
  // 登录/账号管理接口要能在「一个账号都没有」时工作，其余 /api 接口必须有可用凭证
  const isNonR2Api = /^\/api\/(login|logout|me|accounts)/.test(c.req.path)
  if (!acc && !isNonR2Api && c.req.path.startsWith('/api/')) {
    return c.json({ error: '未配置 R2 凭证（请在账号管理里绑定，或设置 R2_* 环境变量）' }, 500)
  }
  if (acc) {
    c._s3 = getClient(acc)
    c._cdnMap = acc.cdnMap || {}
  }
  await next()
})

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

// ---------- R2 账号管理 ----------
// 列出账号（密钥只返回掩码）
app.get('/api/accounts', authGuard, (c) => {
  return c.json({
    accounts: effectiveAccounts().map(sanitizeAccount),
    activeId: c._account?.id || '',
    canManage: true,
  })
})

// 绑定新账号（保存前先验证凭证）
app.post('/api/accounts', authGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const name = String(body.name || '').trim()
  const accountId = String(body.accountId || '').trim()
  const accessKeyId = String(body.accessKeyId || '').trim()
  const secretAccessKey = String(body.secretAccessKey || '').trim()
  if (!name || !accountId || !accessKeyId || !secretAccessKey) return c.json({ error: '请填写完整的名称、Account ID、Access Key ID 和 Secret Access Key' }, 400)
  if (!/^[a-f0-9]{32}$/i.test(accountId)) return c.json({ error: 'Account ID 格式不正确（应为 32 位十六进制）' }, 400)
  const map = parseCdnMap(body.cdnMap)
  if (map.error) return c.json({ error: map.error }, 400)

  const err = await validateCreds(accountId, accessKeyId, secretAccessKey)
  if (err) return c.json({ error: err }, 400)

  if (store.accounts.some((a) => a.accountId === accountId)) return c.json({ error: '该 Cloudflare 账号已绑定' }, 400)
  const acc = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    accountId,
    accessKeyId,
    secretAccessKey,
    cdnMap: map.value,
    createdAt: new Date().toISOString(),
  }
  store.accounts.push(acc)
  saveStore()
  return c.json({ ok: true, id: acc.id })
})

// 编辑账号（名称 / CDN 映射 / 密钥；密钥留空表示不修改）
app.put('/api/accounts/:id', authGuard, async (c) => {
  const acc = store.accounts.find((a) => a.id === c.req.param('id'))
  if (!acc) return c.json({ error: '账号不存在' }, 404)
  const body = await c.req.json().catch(() => ({}))

  if (body.name !== undefined) {
    const n = String(body.name).trim()
    if (!n) return c.json({ error: '名称不能为空' }, 400)
    acc.name = n
  }
  if (body.cdnMap !== undefined) {
    const map = parseCdnMap(body.cdnMap)
    if (map.error) return c.json({ error: map.error }, 400)
    acc.cdnMap = map.value
  }
  const ak = String(body.accessKeyId || '').trim()
  const sk = String(body.secretAccessKey || '').trim()
  if (ak || sk) {
    const nAk = ak || acc.accessKeyId
    const nSk = sk || acc.secretAccessKey
    const err = await validateCreds(acc.accountId, nAk, nSk)
    if (err) return c.json({ error: err }, 400)
    if (ak) acc.accessKeyId = ak
    if (sk) acc.secretAccessKey = sk
    s3Clients.delete(acc.id) // 旧客户端作废
  }
  saveStore()
  return c.json({ ok: true })
})

// 解绑账号（删的是当前账号则自动切回第一个）
app.delete('/api/accounts/:id', authGuard, async (c) => {
  const id = c.req.param('id')
  const idx = store.accounts.findIndex((a) => a.id === id)
  if (idx < 0) return c.json({ error: '账号不存在' }, 404)
  store.accounts.splice(idx, 1)
  if (store.activeId === id) store.activeId = ''
  s3Clients.delete(id)
  saveStore()
  return c.json({ ok: true })
})

// 切换当前使用的账号
app.post('/api/accounts/:id/activate', authGuard, async (c) => {
  const id = c.req.param('id')
  if (!effectiveAccounts().some((a) => a.id === id)) return c.json({ error: '账号不存在' }, 404)
  store.activeId = id
  saveStore()
  return c.json({ ok: true })
})

// ---------- 桶统计（内存缓存 1 小时，按账号隔离） ----------
const STATS_TTL_MS = 3600 * 1000
const statsCache = new Map() // `${accountId}:${bucket}` -> { stats, expires }

function getCachedStats(c, bucket) {
  const key = `${c._account?.id || 'env'}:${bucket}`
  const hit = statsCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.stats
  if (hit) statsCache.delete(key)
  return null
}

function invalidateStats(c, bucket) {
  statsCache.delete(`${c._account?.id || 'env'}:${bucket}`)
}

// 列出账号下所有 R2 桶（附带缓存的统计信息）
app.get('/api/buckets', authGuard, async (c) => {
  const res = await c._s3.send(new ListBucketsCommand({}))
  const names = (res.Buckets || []).map((b) => b.Name).filter(Boolean).sort()
  const buckets = names.map((name) => ({ name, stats: getCachedStats(name) }))
  return c.json({ buckets })
})

// 新建存储桶（在当前使用的账号下）
app.post('/api/buckets', authGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const name = String(body.name || '').trim()
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
    return c.json({ error: '桶名称仅支持小写字母、数字和连字符（-），3–63 个字符，且以字母或数字开头结尾' }, 400)
  }
  try {
    await c._s3.send(new CreateBucketCommand({ Bucket: name }))
    return c.json({ ok: true, name })
  } catch (e) {
    if (e.name === 'BucketAlreadyExists' || e.name === 'BucketAlreadyOwnedByYou' || e?.$metadata?.httpStatusCode === 409) {
      return c.json({ error: '同名存储桶已存在' }, 409)
    }
    return c.json({ error: `CreateBucket failed: ${e.message || e}` }, 500)
  }
})

// 桶统计：分页列举聚合对象数/总大小/最后更新时间
app.get('/api/stats', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  if (!bucket) return c.json({ error: 'missing bucket' }, 400)

  const cached = getCachedStats(c, bucket)
  if (cached) return c.json({ bucket, stats: cached, cached: true })

  let objects = 0
  let size = 0
  let lastModified = null
  let token
  do {
    const res = await c._s3.send(
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
  statsCache.set(`${c._account?.id || 'env'}:${bucket}`, { stats, expires: Date.now() + STATS_TTL_MS })
  return c.json({ bucket, stats, cached: false })
})

// 删除单个文件
app.delete('/api/object', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  if (key.endsWith('/')) return c.json({ error: '不支持删除文件夹' }, 400)

  await c._s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  invalidateStats(c, bucket)
  return c.json({ ok: true })
})

// 批量删除（DeleteObjects，单次最多 500 个）
app.post('/api/delete-batch', authGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const bucket = body.bucket
  const keys = (body.keys || []).filter((k) => typeof k === 'string' && k && !k.endsWith('/'))
  if (!bucket || !keys.length) return c.json({ error: 'missing bucket/keys' }, 400)
  if (keys.length > 500) return c.json({ error: '单次最多删除 500 个文件' }, 400)

  const res = await c._s3.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((k) => ({ Key: k })), Quiet: true },
    })
  )
  const errors = (res.Errors || []).map((e) => ({ key: e.Key, message: e.Message }))
  invalidateStats(c, bucket)
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

  let deleted = 0
  const errors = []
  for (const prefix of prefixes) {
    let token
    let list
    do {
      try {
        list = await c._s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 1000,
            ContinuationToken: token,
          })
        )
      } catch (e) {
        errors.push({ prefix, message: 'ListObjects failed: ' + (e.message || e) })
        break
      }
      const keys = (list.Contents || []).map((o) => o.Key).filter(Boolean)
      // DeleteObjects 单次上限 1000，按 500 一批删
      for (let i = 0; i < keys.length; i += 500) {
        const batch = keys.slice(i, i + 500)
        try {
          const res = await c._s3.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: batch.map((k) => ({ Key: k })), Quiet: true },
            })
          )
          const errs = res.Errors || []
          deleted += batch.length - errs.length
          errs.forEach((e) => errors.push({ key: e.Key, message: e.Message }))
        } catch (e) {
          errors.push({ prefix, message: 'DeleteObjects failed: ' + (e.message || e) })
        }
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined
    } while (token)
  }
  if (deleted > 0) invalidateStats(c, bucket)
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
      await c._s3.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `/${bucket}/${from.split('/').map(encodeURIComponent).join('/')}`,
          Key: to,
        })
      )
      await c._s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: from }))
      moved++
    } catch (e) {
      failed.push({ from, to, reason: e.message || 'unknown error' })
    }
  }
  invalidateStats(c, bucket)
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

  let moved = 0
  const folders = []
  for (const it of valid) {
    let count = 0
    let token
    let list
    do {
      try {
        list = await c._s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: it.from,
            MaxKeys: 1000,
            ContinuationToken: token,
          })
        )
      } catch (e) {
        failed.push({ from: it.from, to: it.to, reason: 'ListObjects failed: ' + (e.message || e) })
        break
      }
      const keys = (list.Contents || []).map((o) => o.Key).filter(Boolean)
      const copied = []
      for (const key of keys) {
        const nk = it.to + key.slice(it.from.length)
        try {
          await c._s3.send(
            new CopyObjectCommand({
              Bucket: bucket,
              CopySource: `/${bucket}/${encodedKey(key)}`,
              Key: nk,
            })
          )
          copied.push(key)
          count++
        } catch (e) {
          failed.push({ from: key, to: nk, reason: 'CopyObject failed: ' + (e.message || e) })
        }
      }
      // 只删已成功复制的源对象，避免失败时丢数据，分批 500
      for (let i = 0; i < copied.length; i += 500) {
        const batch = copied.slice(i, i + 500)
        try {
          await c._s3.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: batch.map((k) => ({ Key: k })), Quiet: true },
            })
          )
        } catch (e) {
          failed.push({ from: it.from, to: it.to, reason: 'DeleteObjects failed: ' + (e.message || e) })
        }
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined
    } while (token)
    moved += count
    folders.push({ from: it.from, to: it.to, count })
  }
  invalidateStats(c, bucket)
  return c.json({ ok: failed.length === 0, moved, folders, failed })
})

// 上传文件（单文件上限 100MB）
app.post('/api/upload', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  if (key.endsWith('/')) return c.json({ error: 'bad key' }, 400)
  const len = Number(c.req.header('content-length') || 0)
  if (len > 100 * 1024 * 1024) return c.json({ error: '单文件最大 100MB' }, 413)

  const body = await c.req.arrayBuffer()
  await c._s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(body),
      ContentType: c.req.header('content-type') || 'application/octet-stream',
    })
  )
  invalidateStats(c, bucket)
  return c.json({ ok: true, key })
})

// ---------- 分片上传（大文件：前端切片，R2 S3 multipart API 合并） ----------
// 初始化
app.post('/api/multipart/init', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  if (key.endsWith('/')) return c.json({ error: 'bad key' }, 400)
  try {
    const res = await c._s3.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: mimeFor(key) })
    )
    return c.json({ ok: true, uploadId: res.UploadId })
  } catch (e) {
    return c.json({ error: 'CreateMultipartUpload failed: ' + (e.message || e) }, 500)
  }
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

  const body = Buffer.from(await c.req.arrayBuffer())
  try {
    const res = await c._s3.send(
      new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body })
    )
    return c.json({ ok: true, partNumber, etag: (res.ETag || '').replace(/"/g, '') })
  } catch (e) {
    return c.json({ error: 'UploadPart failed: ' + (e.message || e) }, 500)
  }
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
  try {
    await c._s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: Number(p.partNumber), ETag: `"${String(p.etag).replace(/"/g, '')}"` })),
        },
      })
    )
    invalidateStats(c, bucket)
    return c.json({ ok: true, key })
  } catch (e) {
    return c.json({ error: 'CompleteMultipartUpload failed: ' + (e.message || e) }, 500)
  }
})

// 取消/中止（清理已传分片）
app.post('/api/multipart/abort', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  const uploadId = c.req.query('uploadId')
  if (!bucket || !key || !uploadId) return c.json({ error: 'missing params' }, 400)
  try {
    await c._s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
  } catch {}
  return c.json({ ok: true })
})

// list（按桶）
app.get('/api/list', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const prefix = c.req.query('prefix') || ''
  if (!bucket) return c.json({ error: 'missing bucket' }, 400)
  if (prefix && !prefix.endsWith('/')) return c.json({ error: 'bad prefix' }, 400)

  const res = await c._s3.send(
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

  return c.json({ bucket, prefix, crumbs, dirs, files, truncated: res.IsTruncated || false })
})

// single file head info
app.get('/api/info', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  let res
  try {
    res = await c._s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode
    if (code === 404 || e.name === 'NotFound') return c.json({ error: 'not found' }, 404)
    return c.json({ error: `HeadObject failed: ${code || e.message}` }, 500)
  }
  const { url, presigned } = await fileUrl(c, bucket, key)
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

// ---------- 预览：文本 / zip ----------
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  pdf: 'application/pdf',
}
const TEXT_CAP = 2 * 1024 * 1024
const ENTRY_CAP = 100 * 1024 * 1024

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

async function s3GetRange(c, bucket, key, start, end) {
  const obj = await c._s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` })
  )
  return Buffer.from(await obj.Body.transformToByteArray())
}

function contentDisposition(name, download) {
  const fname = name.split('/').pop()
  return `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(fname)}`
}

// 文本预览代理
app.get('/api/text', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  let res
  try {
    res = await c._s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode
    if (code === 404 || e.name === 'NotFound') return c.json({ error: 'not found' }, 404)
    return c.json({ error: `HEAD failed: ${code || e.message}` }, 500)
  }
  if ((res.ContentLength || 0) > TEXT_CAP) return c.json({ error: '文件过大，请下载后查看' }, 413)
  const obj = await c._s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const text = await obj.Body.transformToString('utf-8')
  return c.body(text, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
})

// 列出 zip 内文件
app.get('/api/zip', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  let size
  try {
    const head = await c._s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    size = head.ContentLength
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode
    if (code === 404 || e.name === 'NotFound') return c.json({ error: 'not found' }, 404)
    return c.json({ error: `HEAD failed: ${code || e.message}` }, 500)
  }

  const tailLen = Math.min(size, 65536 + 65535)
  const buf = await s3GetRange(c, bucket, key, size - tailLen, size - 1)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return c.json({ error: '不是标准的 ZIP 格式' }, 400)
  const count = u16(buf, eocd + 10)
  const cdSize = u32(buf, eocd + 12)
  const cdOffset = u32(buf, eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) return c.json({ error: '暂不支持 ZIP64 格式' }, 400)

  const cbuf = await s3GetRange(c, bucket, key, cdOffset, cdOffset + cdSize - 1)
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
    const name = cbuf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (!name.endsWith('/')) entries.push({ name, method, compSize, uncompSize, offset })
    else dirCount++
    p += 46 + nameLen + extraLen + commentLen
  }
  const fileTotal = count - dirCount
  return c.json({ bucket, key, total: fileTotal, entries, truncated: entries.length < fileTotal })
})

// 读取 zip 内单个文件
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

  const lbuf = await s3GetRange(c, bucket, key, off, off + 29)
  if (u32(lbuf, 0) !== 0x04034b50) return c.json({ error: 'ZIP 结构异常' }, 400)
  const dataStart = off + 30 + u16(lbuf, 26) + u16(lbuf, 28)

  let data = await s3GetRange(c, bucket, key, dataStart, dataStart + csize - 1)
  if (method === 8) {
    data = zlib.inflateRawSync(data)
  } else if (method !== 0) {
    return c.json({ error: `不支持的压缩算法: ${method}` }, 400)
  }
  return c.body(data, 200, {
    'Content-Type': mimeFor(name),
    'Content-Length': String(data.length),
    'Content-Disposition': contentDisposition(name, download),
    'Cache-Control': 'no-store',
  })
})

serve({ fetch: app.fetch, port: Number(PORT) }, (info) => {
  console.log(`[r2-explorer] listening on http://localhost:${info.port}`)
})
