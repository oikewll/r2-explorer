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
  DeleteBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { detectArchiveKind, getArchiveBuffer, listRar, list7z, listTar, extractRar, extract7z, extractTar, extractAllRar, extractAll7z, extractAllTar } from './archives.js'
import { registerWebDAV } from './webdav.js'
import { registerOfflineDownload } from './offline.js'
import { registerMcp, TEXT_HEAD_PROBE } from './mcp-core.js'

// ---------- env ----------
const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_API_TOKEN,
  R2_PUBLIC_URL,
  R2_CDN_MAP,
  AUTH_PASSWORD,
  AUTH_SECRET,
  ACCOUNTS_FILE,
  MCP_TOKEN,
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
    apiToken: R2_API_TOKEN || '',
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
    hasApiToken: !!a.apiToken,
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
    apiToken: String(body.apiToken || '').trim(),
    cdnMap: map.value,
    createdAt: new Date().toISOString(),
  }
  store.accounts.push(acc)
  saveStore()
  return c.json({ ok: true, id: acc.id })
})

// 编辑账号（名称 / CDN 映射 / 密钥 / API Token；密钥和 Token 留空表示不修改）
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
  if (body.apiToken !== undefined && String(body.apiToken).trim()) {
    acc.apiToken = String(body.apiToken).trim()
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

// 导出账号备份（含完整凭证的 JSON 文件，用于迁移/恢复；内置 env 账号一并导出并标记 builtin）
app.get('/api/accounts/export', authGuard, (c) => {
  const list = [...store.accounts]
  const envAcc = envAccount()
  if (envAcc && !list.some((a) => a.accountId === envAcc.accountId)) list.push(envAcc)
  if (!list.length) return c.json({ error: '没有可导出的账号（未绑定账号且未配置 R2_* 环境变量）' }, 400)
  const accounts = list.map((a) => ({
    name: a.name,
    accountId: a.accountId,
    accessKeyId: a.accessKeyId,
    secretAccessKey: a.secretAccessKey,
    apiToken: a.apiToken || '',
    cdnMap: a.cdnMap || {},
    ...(a.builtin ? { builtin: true } : {}),
  }))
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const body = JSON.stringify(
    { app: 'r2-explorer', version: 1, exportedAt: new Date().toISOString(), accounts },
    null,
    2
  )
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="r2-explorer-accounts-${date}.json"`,
    },
  })
})

// 导入账号备份（逐个验证凭证；已绑定的 Account ID 自动跳过）
app.post('/api/accounts/import', authGuard, async (c) => {
  const body = await c.req.json().catch(() => null)
  const list = Array.isArray(body?.accounts) ? body.accounts : Array.isArray(body) ? body : null
  if (!list || !list.length) return c.json({ error: '备份文件格式不正确（缺少 accounts 数组）' }, 400)

  const added = []
  const skipped = []
  const failed = []
  for (const item of list) {
    const name = String(item?.name || '').trim() || '导入账号'
    const accountId = String(item?.accountId || '').trim()
    const accessKeyId = String(item?.accessKeyId || '').trim()
    const secretAccessKey = String(item?.secretAccessKey || '').trim()
    if (!accountId || !accessKeyId || !secretAccessKey) {
      failed.push({ name, error: '字段不完整（缺 Account ID 或密钥）' })
      continue
    }
    if (!/^[a-f0-9]{32}$/i.test(accountId)) {
      failed.push({ name, error: 'Account ID 格式不正确' })
      continue
    }
    if (store.accounts.some((a) => a.accountId === accountId)) {
      skipped.push(name)
      continue
    }
    // 备份里的内置账号：当前环境已提供同 accountId 时跳过，避免恢复到自己时重复绑定
    if (item?.builtin && envAccount()?.accountId === accountId) {
      skipped.push(name)
      continue
    }
    const err = await validateCreds(accountId, accessKeyId, secretAccessKey)
    if (err) {
      failed.push({ name, error: err })
      continue
    }
    store.accounts.push({
      id: crypto.randomUUID().slice(0, 8),
      name,
      accountId,
      accessKeyId,
      secretAccessKey,
      apiToken: String(item?.apiToken || '').trim(),
      cdnMap: item?.cdnMap && typeof item.cdnMap === 'object' && !Array.isArray(item.cdnMap) ? item.cdnMap : {},
      createdAt: new Date().toISOString(),
    })
    added.push(name)
  }
  if (added.length) saveStore()
  return c.json({ ok: true, added: added.length, skipped: skipped.length, failed })
})

// ---------- 套餐识别（免费版 / 付费版，需账号配置了 CF API Token） ----------
// R2 免费额度：10 GB 存储/月（官方定价）；付费版同样含 10 GB 免费额度，超出按量计费无硬上限
const R2_FREE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024
const PLAN_TTL_MS = 10 * 60 * 1000
const planCache = new Map() // accountId -> { plan, subs, expires }

// 用 CF API Token 查询账号订阅，判断免费/付费
async function fetchPlan(acc) {
  const cached = planCache.get(acc.accountId)
  if (cached && cached.expires > Date.now()) return cached.data

  let data
  if (!acc.apiToken) {
    data = { plan: 'unknown', reason: 'no-token' }
  } else {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/subscriptions`, {
        headers: { Authorization: `Bearer ${acc.apiToken}` },
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) {
        const msg = json?.errors?.[0]?.message || `HTTP ${res.status}`
        data = { plan: 'unknown', reason: 'api-error', error: `查询订阅失败：${msg}` }
      } else {
        const subs = (json.result || []).map((s) => ({
          id: s.id || '',
          name: s.product?.name || s.product_id || (typeof s.rate_plan === 'string' ? s.rate_plan : s.rate_plan?.id) || '',
        }))
        // 有付费订阅（如 Workers Paid，R2 付费用量挂在其下）即付费版
        const paid = subs.some((s) => /paid/i.test(s.name))
        data = { plan: paid ? 'paid' : 'free', subs, freeQuota: R2_FREE_QUOTA_BYTES }
      }
    } catch (e) {
      data = { plan: 'unknown', reason: 'api-error', error: `查询订阅失败：${e.message || e}` }
    }
  }
  // 失败结果缓存 1 分钟，避免每次请求都打 CF API；成功缓存 10 分钟
  const ttl = data.plan === 'unknown' ? 60 * 1000 : PLAN_TTL_MS
  planCache.set(acc.accountId, { data, expires: Date.now() + ttl })
  return data
}

app.get('/api/plan', authGuard, async (c) => {
  return c.json(await fetchPlan(c._account))
})

// ---------- 桶统计（内存缓存 1 小时，按账号隔离） ----------
const STATS_TTL_MS = 3600 * 1000
const MAX_STATS_SCAN = 50000 // 超大桶保护：统计/搜索最多扫描的对象数
const statsCache = new Map() // `${accountId}:${bucket}` -> { stats, expires }

function getCachedStats(c, bucket) {
  const key = `${c._account?.id || 'env'}:${bucket}`
  const hit = statsCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.stats
  if (hit) statsCache.delete(key)
  return null
}

function invalidateStats(c, bucket) {
  statsCache.delete(`${c._account?.id || 'env'}:${bucket}:v2`)
}

// 按扩展名粗分类，供首页存储统计面板使用
const TYPE_EXTS = {
  image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'tif', 'tiff']),
  video: new Set(['mp4', 'webm', 'm4v', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', '3gp', 'ts', 'ogv', 'm2ts']),
  audio: new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'wma', 'ape', 'amr']),
  document: new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'epub', 'mobi', 'azw3', 'log', 'json', 'xml', 'yml', 'yaml', 'html', 'htm']),
}
function typeOfKey(key) {
  const ext = (key.split('.').pop() || '').toLowerCase()
  if (TYPE_EXTS.image.has(ext)) return 'image'
  if (TYPE_EXTS.video.has(ext)) return 'video'
  if (TYPE_EXTS.audio.has(ext)) return 'audio'
  if (TYPE_EXTS.document.has(ext)) return 'document'
  return 'other'
}
function newByType() {
  return { image: { count: 0, size: 0 }, video: { count: 0, size: 0 }, audio: { count: 0, size: 0 }, document: { count: 0, size: 0 }, other: { count: 0, size: 0 } }
}

// 列出账号下所有 R2 桶（附带缓存的统计信息）
app.get('/api/buckets', authGuard, async (c) => {
  const res = await c._s3.send(new ListBucketsCommand({}))
  const names = (res.Buckets || []).map((b) => b.Name).filter(Boolean).sort()
  const buckets = names.map((name) => ({ name, stats: getCachedStats(c, name) }))
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

// 删除存储桶（桶必须为空；前端需输入完整桶名二次确认）
app.delete('/api/buckets/:name', authGuard, async (c) => {
  const name = c.req.param('name')
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
    return c.json({ error: '桶名称格式不正确' }, 400)
  }
  try {
    await c._s3.send(new DeleteBucketCommand({ Bucket: name }))
    statsCache.delete(`${c._account?.id || 'env'}:${name}`)
    return c.json({ ok: true })
  } catch (e) {
    if (e.name === 'BucketNotEmpty' || e?.$metadata?.httpStatusCode === 409) {
      return c.json({ error: '存储桶不为空，请先清空桶内所有文件（含文件夹）后再删除' }, 409)
    }
    if (e.name === 'NoSuchBucket' || e?.$metadata?.httpStatusCode === 404) {
      return c.json({ error: '存储桶不存在' }, 404)
    }
    return c.json({ error: `DeleteBucket failed: ${e.message || e}` }, 500)
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
  let scanned = 0
  let truncated = false
  const byType = newByType()
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
      scanned++
      const sz = o.Size || 0
      size += sz
      const t = typeOfKey(o.Key || '')
      byType[t].count++
      byType[t].size += sz
      const lm = o.LastModified ? new Date(o.LastModified).toISOString() : null
      if (lm && (!lastModified || lm > lastModified)) lastModified = lm
    }
    // 超大桶保护：最多扫描 MAX_SCAN 个对象，超出后统计标记 truncated（数字为下限估计）
    if (res.IsTruncated && scanned >= MAX_STATS_SCAN) {
      truncated = true
      break
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)

  const stats = {
    objects,
    size,
    sizeText: formatSize(size),
    lastModified,
    modifiedText: lastModified ? formatTime(lastModified) : null,
    byType,
    truncated,
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

// 新建文件夹：R2 目录是 key 以 / 结尾的零字节对象
app.post('/api/mkdir', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  if (!key.endsWith('/') || key.includes('..') || key.slice(0, -1).includes('//')) {
    return c.json({ error: 'bad key' }, 400)
  }
  await c._s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: new Uint8Array(0), ContentLength: 0 })
  )
  invalidateStats(c, bucket)
  return c.json({ ok: true, key })
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

// 全局搜索：递归遍历桶内对象，按关键字（大小写不敏感）匹配完整路径
app.get('/api/search', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const q = (c.req.query('q') || '').trim().toLowerCase()
  const scope = c.req.query('prefix') || ''
  if (!bucket) return c.json({ error: 'missing bucket' }, 400)
  if (!q) return c.json({ files: [], more: false })
  const limit = Math.min(Number(c.req.query('limit')) || 100, 300)
  const MAX_SCAN = 50000 // 最多扫描的对象数，防止超大桶长时间遍历

  const files = []
  let token
  let more = false
  let scanned = 0
  while (true) {
    const res = await c._s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: scope || undefined,
        MaxKeys: 1000,
        ContinuationToken: token,
      })
    )
    for (const o of res.Contents || []) {
      scanned++
      if (o.Key.endsWith('/')) continue // 目录占位对象跳过
      if (!o.Key.toLowerCase().includes(q)) continue
      const name = o.Key.split('/').pop()
      const { url, presigned } = await fileUrl(c, bucket, o.Key)
      files.push({
        type: 'file',
        name,
        path: o.Key,
        dir: o.Key.slice(0, o.Key.length - name.length),
        size: o.Size,
        sizeText: formatSize(o.Size),
        modified: o.LastModified,
        modifiedText: formatTime(o.LastModified),
        url,
        presigned,
      })
      if (files.length >= limit) break
    }
    if (files.length >= limit) {
      more = !!res.IsTruncated
      break
    }
    if (!res.IsTruncated || scanned >= MAX_SCAN) {
      more = !!res.IsTruncated && scanned >= MAX_SCAN
      break
    }
    token = res.NextContinuationToken
  }
  return c.json({ files, more, scanned })
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

// static frontend (Vite 构建产物 web/dist)
app.use('/*', serveStatic({ root: './web/dist' }))

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

// 对象内容同源代理（图片画布类操作需要同源，避免预签名/CDN 直链无 CORS 导致画布污染；Range 透传供 EXIF 局部拉取）
app.get('/api/raw', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  const range = c.req.header('range')
  let obj
  try {
    obj = await c._s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, ...(range ? { Range: range } : {}) })
    )
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode
    if (code === 404 || e.name === 'NotFound') return c.json({ error: 'not found' }, 404)
    return c.json({ error: `GetObject failed: ${code || e.message}` }, 500)
  }
  // Range 命中时必须回 206——回 200 但带 Content-Range 属于畸形响应，会让浏览器 <video> 卡死
  const partial = range && obj.ContentRange
  const headers = {
    'Content-Type': obj.ContentType || 'application/octet-stream',
    ...(obj.ContentLength != null ? { 'Content-Length': String(obj.ContentLength) } : {}),
    ...(partial ? { 'Content-Range': obj.ContentRange } : {}),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  }
  return c.body(obj.Body.transformToWebStream(), partial ? 206 : 200, headers)
})

// 列出压缩包内文件（zip 用 Range 手工解析；rar/7z/tar.gz 走 archives.js 整包 WASM 解析）
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

  // 读文件头识别格式（tar 的 magic 在偏移 257 处，得读 512 字节）
  let kind = null
  try {
    const head = await s3GetRange(c, bucket, key, 0, Math.min(size, 512) - 1)
    kind = detectArchiveKind(head)
  } catch {}

  if (kind === 'rar' || kind === '7z' || kind === 'tar' || kind === 'gzip') {
    try {
      const { buf, kind: resolved } = await getArchiveBuffer(c._s3, bucket, key, size)
      const entries = resolved === 'rar' ? await listRar(buf) : resolved === '7z' ? await list7z(buf) : await listTar(buf)
      return c.json({ bucket, key, kind: resolved, total: entries.length, entries, truncated: entries.length >= 5000 })
    } catch (e) {
      return c.json({ error: e.message }, e.status || 500)
    }
  }

  const tailLen = Math.min(size, 65536 + 65535)
  const buf = await s3GetRange(c, bucket, key, size - tailLen, size - 1)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return c.json({ error: kind === 'zip' ? '不是标准的 ZIP 格式' : '暂不支持该压缩包格式（支持 zip/rar/7z/tar.gz，其他请下载查看）' }, 400)
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
  return c.json({ bucket, key, kind: 'zip', total: fileTotal, entries, truncated: entries.length < fileTotal })
})

// 读取 rar/7z/tar.gz 内单个文件（zip 走上面的 /api/zip-entry）
app.get('/api/ar-entry', authGuard, async (c) => {
  const bucket = c.req.query('bucket')
  const key = c.req.query('key')
  const name = c.req.query('name')
  const download = c.req.query('download') === '1'
  if (!bucket || !key || !name) return c.json({ error: 'missing params' }, 400)
  let size
  try {
    const head = await c._s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    size = head.ContentLength
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode
    if (code === 404 || e.name === 'NotFound') return c.json({ error: 'not found' }, 404)
    return c.json({ error: `HEAD failed: ${code || e.message}` }, 500)
  }
  try {
    const { buf, kind } = await getArchiveBuffer(c._s3, bucket, key, size)
    if (kind === 'zip') return c.json({ error: 'zip 请使用 /api/zip-entry' }, 400)
    const data = kind === 'rar' ? await extractRar(buf, name) : kind === '7z' ? await extract7z(buf, name) : await extractTar(buf, name)
    if (!data) return c.json({ error: '压缩包内未找到该文件' }, 404)
    return c.body(data, 200, {
      'Content-Type': mimeFor(name),
      'Content-Length': String(data.length),
      'Content-Disposition': contentDisposition(name, download),
      'Cache-Control': 'no-store',
    })
  } catch (e) {
    return c.json({ error: e.message }, e.status || 500)
  }
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

// ---------- 在线解压（压缩包整包解到 R2 目录；仅 Node/Docker 版） ----------
// 后台任务模式：POST /api/extract 创建任务，前端轮询 /api/extract/status。
// zip 走 Range 流式逐条解（整包不进内存，无 256MB 上限）；rar/7z/tar.gz 复用 archives.js 整包解析。
const EXTRACT_MAX_JOBS = 2 // 同时进行的解压任务数
const EXTRACT_UPLOAD_CONC = 3 // zip 分支逐条「Range 读取 + 上传」的并发
const EXTRACT_ENTRY_MAX = 1024 * 1024 * 1024 // 单文件解压上限 1GB
const EXTRACT_TOTAL_MAX = 8 * 1024 * 1024 * 1024 // 总解压量上限 8GB
const EXTRACT_MAX_ENTRIES = 5000 // 条目数上限（与预览一致）
const EXTRACT_ERRORS_MAX = 50 // 失败明细最多记录条数
const EXTRACT_TTL = 30 * 60 * 1000 // 任务结果保留时长
const extracts = new Map() // id -> job

setInterval(() => {
  const now = Date.now()
  for (const [id, j] of extracts) {
    if ((j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') && now - j.updatedAt > EXTRACT_TTL) {
      extracts.delete(id)
    }
  }
}, 60 * 1000).unref?.()

function extractErr(status, message) {
  return Object.assign(new Error(message), { status })
}

// 不依赖 Hono context 的 Range 读取（任务在响应返回后继续跑，不能持有 c）
async function s3RangeRead(s3, bucket, key, start, end) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end}` }))
  return Buffer.from(await obj.Body.transformToByteArray())
}

// 压缩包内路径消毒：反斜杠归一、去掉空段与 .、遇 .. 直接判不安全（防目录穿越写出桶外前缀）
function sanitizeEntryName(name) {
  const parts = String(name).replace(/\\/g, '/').split('/')
  const out = []
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') return null
    out.push(p)
  }
  return out.length ? out.join('/') : null
}

// zip 中央目录解析（逻辑与 /api/zip 尾部一致，此处独立实现避免动预览链路）
async function zipCentralForExtract(s3, bucket, key, size) {
  const tailLen = Math.min(size, 65536 + 65535)
  const buf = await s3RangeRead(s3, bucket, key, size - tailLen, size - 1)
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw extractErr(400, '不是标准的 ZIP 格式')
  const count = u16(buf, eocd + 10)
  const cdSize = u32(buf, eocd + 12)
  const cdOffset = u32(buf, eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw extractErr(400, '暂不支持 ZIP64 格式')
  const cbuf = await s3RangeRead(s3, bucket, key, cdOffset, cdOffset + cdSize - 1)
  const entries = []
  let dirCount = 0
  let p = 0
  while (p + 46 <= cbuf.length && entries.length < Math.min(count, EXTRACT_MAX_ENTRIES)) {
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
  return { entries, fileTotal: count - dirCount }
}

async function runExtract(job, s3) {
  const addError = (name, msg) => {
    if (job.errors.length < EXTRACT_ERRORS_MAX) job.errors.push(`${name}: ${String(msg).slice(0, 120)}`)
  }
  const record = async (name, data) => {
    if (job.status !== 'running') return // 任务被取消
    const clean = sanitizeEntryName(name)
    if (!clean) {
      job.failed++
      addError(name, '路径不安全，已跳过')
      return
    }
    if (data.length > EXTRACT_ENTRY_MAX) {
      job.failed++
      addError(name, '单文件超过 1GB，已跳过')
      return
    }
    try {
      await s3.send(
        new PutObjectCommand({ Bucket: job.bucket, Key: job.target + clean, Body: data, ContentLength: data.length })
      )
      job.done++
    } catch (e) {
      job.failed++
      addError(name, e?.message || e)
    }
    job.updatedAt = Date.now()
  }

  try {
    const head = await s3RangeRead(s3, job.bucket, job.key, 0, Math.min(job.size, 512) - 1)
    const kind0 = detectArchiveKind(head)

    if (kind0 === 'rar' || kind0 === '7z' || kind0 === 'tar' || kind0 === 'gzip') {
      // 整包型：先列条目做量级校验，再一次解出全部逐条上传（串行即可，瓶颈在上传）
      const { buf, kind } = await getArchiveBuffer(s3, job.bucket, job.key, job.size)
      const list = kind === 'rar' ? await listRar(buf) : kind === '7z' ? await list7z(buf) : listTar(buf)
      if (list.length > EXTRACT_MAX_ENTRIES) throw extractErr(400, `压缩包内文件超过 ${EXTRACT_MAX_ENTRIES} 个，请下载后本地解压`)
      const totalBytes = list.reduce((s, e) => s + (e.uncompSize || 0), 0)
      if (totalBytes > EXTRACT_TOTAL_MAX) {
        throw extractErr(400, `解压总量超过 ${Math.round(EXTRACT_TOTAL_MAX / 1024 / 1024 / 1024)}GB，请下载后本地解压`)
      }
      job.total = list.length
      if (kind === 'rar') {
        await extractAllRar(buf, async (name, data) => record(name, data))
      } else if (kind === 'tar') {
        for (const e of extractAllTar(buf)) await record(e.name, e.data)
      } else {
        const all = await extractAll7z(buf, list.map((e) => e.name))
        for (const e of all) await record(e.name, e.data)
      }
    } else {
      // zip：流式逐条 Range 读取 + 解压 + 上传，3 路并发
      const { entries, fileTotal } = await zipCentralForExtract(s3, job.bucket, job.key, job.size)
      if (fileTotal > EXTRACT_MAX_ENTRIES) throw extractErr(400, `压缩包内文件超过 ${EXTRACT_MAX_ENTRIES} 个，请下载后本地解压`)
      const totalBytes = entries.reduce((s, e) => s + (e.uncompSize || 0), 0)
      if (totalBytes > EXTRACT_TOTAL_MAX) {
        throw extractErr(400, `解压总量超过 ${Math.round(EXTRACT_TOTAL_MAX / 1024 / 1024 / 1024)}GB，请下载后本地解压`)
      }
      job.total = entries.length
      let idx = 0
      const worker = async () => {
        while (idx < entries.length && job.status === 'running') {
          const e = entries[idx++]
          try {
            let data
            if (e.compSize === 0) {
              data = Buffer.alloc(0) // 空文件：没有数据区，Range 读 end<start 会报错
            } else {
              const lbuf = await s3RangeRead(s3, job.bucket, job.key, e.offset, e.offset + 29)
              if (u32(lbuf, 0) !== 0x04034b50) throw extractErr(400, 'ZIP 结构异常')
              const dataStart = e.offset + 30 + u16(lbuf, 26) + u16(lbuf, 28)
              data = await s3RangeRead(s3, job.bucket, job.key, dataStart, dataStart + e.compSize - 1)
              if (e.method === 8) data = zlib.inflateRawSync(data)
              else if (e.method !== 0) throw extractErr(400, `不支持的压缩算法: ${e.method}`)
            }
            await record(e.name, data)
          } catch (err2) {
            job.failed++
            addError(e.name, err2?.message || err2)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(EXTRACT_UPLOAD_CONC, entries.length) || 1 }, worker))
    }
    if (job.status === 'running') {
      job.status = job.failed && !job.done ? 'failed' : 'done'
      job.message = job.failed ? `${job.failed} 个文件解压失败，其余已完成` : ''
    }
  } catch (e) {
    job.status = 'failed'
    job.error = String(e?.message || e).slice(0, 300)
  }
  job.updatedAt = Date.now()
}

app.post('/api/extract', authGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { bucket, key } = body
  const target = String(body.target || '')
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  const segs = target.endsWith('/') ? target.slice(0, -1).split('/') : []
  if (
    !target.endsWith('/') ||
    target.startsWith('/') ||
    !segs.length ||
    segs.some((p) => !p || p === '.' || p === '..')
  ) {
    return c.json({ error: '目标目录格式不正确' }, 400)
  }
  let size
  try {
    const head = await c._s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    size = head.ContentLength
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode
    if (code === 404 || e.name === 'NotFound') return c.json({ error: 'not found' }, 404)
    return c.json({ error: `HEAD failed: ${code || e.message}` }, 500)
  }
  let running = 0
  for (const j of extracts.values()) if (j.status === 'running') running++
  if (running >= EXTRACT_MAX_JOBS) return c.json({ error: '服务器已有解压任务在进行，请稍后再试' }, 429)

  const id = crypto.randomUUID()
  const job = {
    id,
    bucket,
    key,
    target,
    size,
    status: 'running',
    total: 0,
    done: 0,
    failed: 0,
    errors: [],
    message: '',
    error: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  extracts.set(id, job)
  // s3 client 在任务启动前取出：响应返回后 Hono context 不可再依赖
  const s3 = c._s3
  runExtract(job, s3).catch((e) => {
    job.status = 'failed'
    job.error = String(e?.message || e).slice(0, 300)
    job.updatedAt = Date.now()
  })
  return c.json({ id })
})

app.get('/api/extract/status', authGuard, (c) => {
  const id = c.req.query('id')
  const job = extracts.get(id)
  if (!job) return c.json({ error: '任务不存在或已过期' }, 404)
  const { status, total, done, failed, message, error, errors, target } = job
  return c.json({ status, total, done, failed, message, error, errors, target })
})

app.post('/api/extract/cancel', authGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const job = extracts.get(String(body.id || ''))
  if (job && job.status === 'running') {
    job.status = 'cancelled'
    job.updatedAt = Date.now()
    return c.json({ ok: true })
  }
  return c.json({ ok: false })
})

// ---------- 视频转码（仅 Node/Docker 版支持；Workers 无法运行 ffmpeg） ----------
// mkv/avi 等浏览器不能直放的格式 → ffmpeg 转 HLS，边转边播（event 模式）
let ffmpegOk = null
function hasFFmpeg() {
  if (ffmpegOk !== null) return ffmpegOk
  try {
    ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0
  } catch {
    ffmpegOk = false
  }
  if (!ffmpegOk) console.warn('[warn] 未检测到 ffmpeg，mkv/avi 等格式将无法在线播放')
  return ffmpegOk
}

const TRANSCODE_IDLE_MS = 15 * 60 * 1000
const TRANSCODE_MAX = 2 // 并发上限，超出杀最旧的
const transcodes = new Map() // id -> { proc, dir, bucket, key, ss, lastTouch, failed }

function killTranscode(id) {
  const s = transcodes.get(id)
  if (!s) return
  try {
    s.proc.kill('SIGKILL')
  } catch {}
  try {
    fs.rmSync(s.dir, { recursive: true, force: true })
  } catch {}
  transcodes.delete(id)
}

function transcodeGC() {
  const now = Date.now()
  for (const [id, s] of transcodes) {
    if (now - s.lastTouch > TRANSCODE_IDLE_MS) killTranscode(id)
  }
  while (transcodes.size > TRANSCODE_MAX) {
    const oldest = [...transcodes.entries()].sort((a, b) => a[1].lastTouch - b[1].lastTouch)[0]
    killTranscode(oldest[0])
  }
}
setInterval(transcodeGC, 60 * 1000).unref?.()

app.get('/api/capabilities', authGuard, (c) => c.json({ transcode: hasFFmpeg(), offlineDownload: true, extract: true }))

app.post('/api/transcode/start', authGuard, async (c) => {
  if (!hasFFmpeg()) return c.json({ error: '服务器未安装 ffmpeg，无法转码在线播放' }, 501)
  const body = await c.req.json().catch(() => ({}))
  const { bucket, key } = body
  const ss = Math.max(0, Number(body.ss) || 0)
  if (!bucket || !key) return c.json({ error: 'missing bucket/key' }, 400)
  // 相同文件 + 相同起点：复用进行中的会话
  for (const [id, s] of transcodes) {
    if (s.bucket === bucket && s.key === key && s.ss === ss) {
      s.lastTouch = Date.now()
      return c.json({ id, ss })
    }
  }
  const { url } = await fileUrl(c, bucket, key)
  const id = crypto.randomUUID()
  const dir = path.join(os.tmpdir(), 'r2x-transcode', id)
  fs.mkdirSync(dir, { recursive: true })
  // ss 作为 ffmpeg 输入的快速 seek：转码时间线从 ss 开始，前端播放位置 = ss + 播放器时间
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...(ss > 0 ? ['-ss', String(ss)] : []),
    '-i', url,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments',
    '-hls_list_size', '0', '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8'),
  ]
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let errMsg = ''
  proc.stderr.on('data', (d) => {
    errMsg = (errMsg + d).slice(-500)
  })
  proc.on('error', () => killTranscode(id))
  proc.on('close', (code) => {
    const s = transcodes.get(id)
    if (s && code !== 0) s.failed = (errMsg || `ffmpeg exited ${code}`).trim()
  })
  transcodes.set(id, { proc, dir, bucket, key, ss, lastTouch: Date.now() })
  transcodeGC()
  return c.json({ id, ss })
})

app.post('/api/transcode/stop', authGuard, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (body.id) killTranscode(body.id)
  return c.json({ ok: true })
})

app.get('/api/transcode/:id/:file', authGuard, (c) => {
  const { id, file } = c.req.param()
  const s = transcodes.get(id)
  if (!s) return c.json({ error: 'transcode session not found' }, 404)
  s.lastTouch = Date.now()
  if (!/^[\w][\w.-]*$/.test(file)) return c.json({ error: 'bad file' }, 400)
  if (file === 'index.m3u8' && s.failed) return c.json({ error: '转码失败：' + s.failed }, 500)
  const fp = path.join(s.dir, file)
  if (!fs.existsSync(fp)) return c.json({ error: 'segment not ready' }, 404)
  c.header('Content-Type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t')
  c.header('Cache-Control', 'no-store')
  // HLS 分片（4s 一片）体积小，直接整读
  return c.body(fs.readFileSync(fp))
})

// ---------- 离线下载（URL 直链 → 后台流式下载直传 R2；仅 Node/Docker 版） ----------
registerOfflineDownload(app, {
  dataFile: path.join(path.dirname(ACCOUNTS_PATH), 'downloads.json'),
  authGuard,
  resolveAccount: (accountId) => {
    const acc = effectiveAccounts().find((a) => a.id === accountId)
    return acc ? { client: getClient(acc) } : null
  },
  mimeFor,
  invalidateStats: (accountId, bucket) => statsCache.delete(`${accountId}:${bucket}`),
})

// ---------- WebDAV（/dav/，Basic 认证，密码 = 登录密码；仅 Node/Docker 版） ----------
registerWebDAV(app, { AUTH_PASSWORD })

// ---------- MCP 只读服务（/mcp，Bearer MCP_TOKEN；未配置则端点关闭） ----------
// 工具集与协议见 src/mcp-core.js；安全设计见 docs/mcp-readonly-design.md
function mcpBackend(c) {
  if (!c._account || !c._s3) return null
  const s3 = c._s3
  const notFound = (e, op) => {
    const code = e?.$metadata?.httpStatusCode
    return new Error(`${op} failed: ${code || e.message}（文件不存在？可用 list_objects/search_objects 确认路径）`)
  }
  return {
    async listBuckets() {
      const res = await s3.send(new ListBucketsCommand({}))
      const names = (res.Buckets || []).map((b) => b.Name).filter(Boolean).sort()
      return {
        account: c._account.name || c._account.id,
        buckets: names.map((name) => {
          const st = getCachedStats(c, name)
          return st ? { name, objects: st.objects, sizeText: st.sizeText } : { name }
        }),
      }
    },
    async bucketStats(bucket) {
      const cached = getCachedStats(c, bucket)
      if (cached) return { ...cached, cached: true }
      let objects = 0
      let size = 0
      let lastModified = null
      let scanned = 0
      let truncated = false
      const byType = newByType()
      let token
      do {
        const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ContinuationToken: token }))
        for (const o of res.Contents || []) {
          objects++
          scanned++
          const sz = o.Size || 0
          size += sz
          const t = typeOfKey(o.Key || '')
          byType[t].count++
          byType[t].size += sz
          const lm = o.LastModified ? new Date(o.LastModified).toISOString() : null
          if (lm && (!lastModified || lm > lastModified)) lastModified = lm
        }
        if (res.IsTruncated && scanned >= MAX_STATS_SCAN) {
          truncated = true
          break
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token)
      const stats = {
        bucket,
        objects,
        size,
        sizeText: formatSize(size),
        lastModified,
        byType,
        truncated,
      }
      statsCache.set(`${c._account?.id || 'env'}:${bucket}`, { stats, expires: Date.now() + STATS_TTL_MS })
      return stats
    },
    async listObjects(bucket, prefix) {
      const res = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, Delimiter: '/', MaxKeys: 1000 })
      )
      const dirs = (res.CommonPrefixes || [])
        .map((p) => ({ name: p.Prefix.slice(prefix.length).replace(/\/$/, ''), path: p.Prefix }))
        .filter((d) => d.name)
        .sort((a, b) => a.name.localeCompare(b.name))
      const files = []
      for (const o of res.Contents || []) {
        if (o.Key === prefix) continue
        const { url, presigned } = await fileUrl(c, bucket, o.Key)
        files.push({
          name: o.Key.slice(prefix.length),
          path: o.Key,
          size: o.Size,
          sizeText: formatSize(o.Size),
          modified: o.LastModified ? new Date(o.LastModified).toISOString() : null,
          url,
          presigned,
        })
      }
      files.sort((a, b) => a.name.localeCompare(b.name))
      return { bucket, prefix, dirs, files, truncated: !!res.IsTruncated }
    },
    async searchObjects(bucket, q, prefix, limit) {
      const needle = q.toLowerCase()
      const files = []
      let token
      let more = false
      let scanned = 0
      while (true) {
        const res = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix || undefined,
            MaxKeys: 1000,
            ContinuationToken: token,
          })
        )
        for (const o of res.Contents || []) {
          scanned++
          const key = o.Key || ''
          if (key.endsWith('/')) continue
          if (!key.toLowerCase().includes(needle)) continue
          const name = key.split('/').pop()
          const { url, presigned } = await fileUrl(c, bucket, key)
          files.push({
            name,
            path: key,
            dir: key.slice(0, key.length - name.length),
            size: o.Size,
            sizeText: formatSize(o.Size),
            url,
            presigned,
          })
          if (files.length >= limit) break
        }
        if (files.length >= limit) {
          more = !!res.IsTruncated
          break
        }
        if (!res.IsTruncated || scanned >= MAX_STATS_SCAN) {
          more = !!res.IsTruncated && scanned >= MAX_STATS_SCAN
          break
        }
        token = res.NextContinuationToken
      }
      return { files, more, scanned }
    },
    async getFileInfo(bucket, key) {
      let res
      try {
        res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      } catch (e) {
        throw notFound(e, 'HeadObject')
      }
      const { url, presigned } = await fileUrl(c, bucket, key)
      return {
        bucket,
        key,
        size: res.ContentLength,
        sizeText: formatSize(res.ContentLength),
        contentType: res.ContentType || '',
        etag: (res.ETag || '').replace(/"/g, ''),
        modified: res.LastModified ? new Date(res.LastModified).toISOString() : null,
        url,
        presigned,
      }
    },
    async readTextFile(bucket, key, maxChars) {
      let head
      try {
        head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      } catch (e) {
        throw notFound(e, 'HeadObject')
      }
      if ((head.ContentLength || 0) > TEXT_CAP) {
        throw new Error(`文件 ${formatSize(head.ContentLength)} 超过 2MB 文本读取上限，请用 get_file_url 获取下载直链`)
      }
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      const text = await obj.Body.transformToString('utf-8')
      if (text.slice(0, TEXT_HEAD_PROBE).includes('\u0000')) {
        throw new Error('内容疑似二进制文件，请用 get_file_info / get_file_url 获取下载直链')
      }
      const truncated = text.length > maxChars
      const { url, presigned } = await fileUrl(c, bucket, key)
      return {
        text: truncated ? text.slice(0, maxChars) : text,
        truncated,
        totalChars: text.length,
        totalSize: head.ContentLength,
        url,
        presigned,
      }
    },
    async getFileUrl(bucket, key, expiresIn) {
      const mapped = c._cdnMap[bucket] || c._cdnMap['*']
      if (mapped) {
        return { url: `${mapped.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`, presigned: false }
      }
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn })
      return { url, presigned: true, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
    },
  }
}

registerMcp(app, {
  version: '2.18.0', // 与 package.json version 保持同步
  getToken: () => MCP_TOKEN,
  makeBackend: mcpBackend,
})

serve({ fetch: app.fetch, port: Number(PORT) }, (info) => {
  console.log(`[r2-explorer] listening on http://localhost:${info.port}`)
})
