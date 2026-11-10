// WebDAV 服务端（仅 Node/Docker 自托管版；Workers 版不支持）
// 挂载点 /dav/：根集合 = 当前激活账号下的所有桶，/dav/{bucket}/{key} 为文件/目录
// 支持 OPTIONS / PROPFIND / GET / HEAD / PUT / DELETE / MKCOL / COPY / MOVE / PROPPATCH / LOCK / UNLOCK
// - 鉴权：HTTP Basic，密码 = 登录密码（AUTH_PASSWORD），用户名任意
// - LOCK 用内存假锁（10 分钟过期）：macOS Finder / Windows 写入前会 LOCK，不做会写入失败
// - R2 没有真目录：目录用 CommonPrefixes 合成 + 零字节「prefix/」标记对象兜底（空目录可见）
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListBucketsCommand,
} from '@aws-sdk/client-s3'
import crypto from 'node:crypto'

const LOCK_TTL = 10 * 60 * 1000
const COPY_CAP = 5000 // 集合级复制/移动的条目上限
const CHUNKED_PUT_CAP = 512 * 1024 * 1024 // 无 Content-Length（chunked）时的缓冲上限

const locks = new Map() // path -> { token, exp }

// ---------- 小工具 ----------

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]))
}

// href 逐段 percent-encode（保留 /）
function hrefEncode(p) {
  return p.split('/').map(encodeURIComponent).join('/')
}

function httpDate(d) {
  return new Date(d).toUTCString()
}

function isoDate(d) {
  return new Date(d || 0).toISOString()
}

// 解析 Basic 认证，返回是否通过（密码固定比对 AUTH_PASSWORD）
function checkBasicAuth(c, AUTH_PASSWORD) {
  const header = c.req.header('Authorization') || ''
  const m = /^Basic\s+(.+)$/i.exec(header)
  if (!m) return false
  let decoded
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf-8')
  } catch {
    return false
  }
  const idx = decoded.indexOf(':')
  const pass = idx >= 0 ? decoded.slice(idx + 1) : ''
  const a = Buffer.from(pass)
  const b = Buffer.from(AUTH_PASSWORD)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function unauthorized(c) {
  return c.body(null, 401, {
    'WWW-Authenticate': 'Basic realm="R2 Explorer", charset="UTF-8"',
  })
}

// /dav/ 之后的路径 → { bucket, key }（key 不含桶，可空）；空桶名 = 根集合
function parsePath(pathname) {
  const raw = decodeURIComponent(pathname.replace(/^\/dav\/?/, ''))
  if (!raw) return { bucket: '', key: '' }
  const slash = raw.indexOf('/')
  if (slash < 0) return { bucket: raw, key: '' }
  return { bucket: raw.slice(0, slash), key: raw.slice(slash + 1) }
}

// Destination 头（可能是绝对 URL 或绝对路径）→ { bucket, key }
function parseDestination(header) {
  if (!header) return null
  let p
  try {
    p = new URL(header, 'http://x').pathname
  } catch {
    return null
  }
  const { bucket, key } = parsePath(p)
  if (!bucket || !key) return null
  return { bucket, key }
}

// 规范化 key：去掉重复斜杠和首尾斜杠（集合语境下尾斜杠单独传 isCol）
function normKey(key) {
  return key.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '')
}

async function listByPrefix(c, bucket, prefix) {
  const res = await c._s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', MaxKeys: 1000 })
  )
  return {
    dirs: (res.CommonPrefixes || []).map((p) => p.Prefix),
    files: (res.Contents || []).filter((o) => o.Key !== prefix), // 排除自身目录标记
    truncated: !!res.IsTruncated,
  }
}

// 列出集合下全部对象（分页），用于集合删除/复制
async function* listAll(c, bucket, prefix) {
  let token
  do {
    const res = await c._s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) })
    )
    for (const o of res.Contents || []) yield o
    token = res.IsTruncated ? res.NextContinuationToken : null
  } while (token)
}

async function headOr404(c, bucket, key) {
  try {
    return await c._s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode
    if (code === 404 || e.name === 'NotFound' || code === 403) return null
    throw e
  }
}

// 文件是否存在（head 404 时再确认是不是目录标记/前缀）
async function stat(c, bucket, key) {
  const head = await headOr404(c, bucket, key)
  if (head) return { type: 'file', head }
  // 目录标记（零字节 key/ 形式）或前缀下有对象/子前缀都视为集合
  const marker = await headOr404(c, bucket, key + '/')
  const sub = await c._s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: key + '/', Delimiter: '/', MaxKeys: 1 })
  )
  if (marker || (sub.Contents || []).length || (sub.CommonPrefixes || []).length) {
    return { type: 'collection', head: marker }
  }
  return null
}

// ---------- XML 响应 ----------

function propXml({ isCol, name, href, size, mtime, etag, mime }) {
  const lastModified = httpDate(mtime || 0)
  const creation = isoDate(mtime || 0)
  return `<D:response>
<D:href>${xmlEscape(href)}</D:href>
<D:propstat><D:prop>
<D:displayname>${xmlEscape(name)}</D:displayname>
<D:resourcetype>${isCol ? '<D:collection/>' : ''}</D:resourcetype>
${isCol ? '' : `<D:getcontentlength>${size || 0}</D:getcontentlength>
<D:getcontenttype>${xmlEscape(mime)}</D:getcontenttype>
<D:getetag>${xmlEscape(etag || '')}</D:getetag>`}
<D:getlastmodified>${xmlEscape(lastModified)}</D:getlastmodified>
<D:creationdate>${creation}</D:creationdate>
<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>`
}

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${responses.join('\n')}</D:multistatus>`
}

function fileEntry(c, bucket, key, head) {
  const name = key.split('/').pop()
  return {
    isCol: false,
    name,
    href: `/dav/${hrefEncode(bucket)}/${hrefEncode(key)}`,
    // HeadObject 返回 ContentLength，ListObjectsV2 的对象返回 Size
    size: head.ContentLength ?? head.Size ?? 0,
    mtime: head.LastModified,
    etag: head.ETag,
    mime: mimeOf(name),
  }
}

function dirEntry(bucket, prefix /* 含尾斜杠或空 */) {
  const name = prefix ? prefix.replace(/\/$/, '').split('/').pop() : bucket
  const key = prefix || ''
  return {
    isCol: true,
    name,
    href: `/dav/${hrefEncode(bucket)}/${hrefEncode(key)}`,
    mtime: 0,
  }
}

function mimeOf(name) {
  // 与 server.js 的 MIME 表保持独立小集合（WebDAV 场景够用），缺省 octet-stream
  const ext = (name.split('.').pop() || '').toLowerCase()
  const m = {
    txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html', css: 'text/css',
    js: 'text/javascript', json: 'application/json', xml: 'application/xml', pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
    m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus',
    zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
    gz: 'application/gzip', tar: 'application/x-tar', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return m[ext] || 'application/octet-stream'
}

// ---------- 方法处理 ----------

async function handlePropfind(c, { bucket, key }) {
  const depthHeader = (c.req.header('Depth') || 'infinity').toLowerCase()
  const depth = depthHeader === '0' ? 0 : 1 // infinity 按 1 处理（够用且防深扫）
  const out = []

  if (!bucket) {
    // 根集合：Depth 1 列出所有桶
    const res = await c._s3.send(new ListBucketsCommand({}))
    out.push(propXml({ isCol: true, name: 'dav', href: '/dav/', mtime: 0 }))
    if (depth === 1) {
      for (const b of res.Buckets || []) {
        out.push(propXml({ isCol: true, name: b.Name, href: `/dav/${hrefEncode(b.Name)}/`, mtime: b.CreationDate }))
      }
    }
    return c.body(multistatus(out), 207, { 'Content-Type': 'application/xml; charset=utf-8' })
  }

  const isColPath = key === '' || pathnameEndsWithSlash(c)
  const norm = normKey(key)
  // 桶根（key 为空）直接视为集合，不做 stat（HeadObject 不接受空 key）
  const st = norm ? await stat(c, bucket, norm) : { type: 'collection', head: null }
  if (!st) return c.body(null, 404)

  if (st.type === 'collection' || isColPath) {
    const colHref = norm ? `/dav/${hrefEncode(bucket)}/${hrefEncode(norm)}/` : `/dav/${hrefEncode(bucket)}/`
    out.push(propXml({ isCol: true, name: norm ? norm.split('/').pop() : bucket, href: colHref, mtime: st.head?.LastModified }))
    if (depth === 1) {
      const { dirs, files, truncated } = await listByPrefix(c, bucket, norm ? norm + '/' : '')
      for (const d of dirs) out.push(propXml(dirEntry(bucket, d)))
      for (const f of files) out.push(propXml(fileEntry(c, bucket, f.Key, f)))
      if (truncated) c.header('X-R2-Truncated', '1') // 超 1000 条的目录少见，客户端翻页需求低
    }
  } else {
    out.push(propXml(fileEntry(c, bucket, norm, st.head)))
  }
  return c.body(multistatus(out), 207, { 'Content-Type': 'application/xml; charset=utf-8' })
}

function pathnameEndsWithSlash(c) {
  return c.req.path.endsWith('/')
}

async function handleGetHead(c, { bucket, key }, isHead) {
  if (!bucket || key === '' || pathnameEndsWithSlash(c)) {
    if (isHead) return c.body(null, 200)
    // 集合 GET：简单 HTML 列表（浏览器直接访问用）
    const norm = normKey(key)
    const { dirs, files } = bucket ? await listByPrefix(c, bucket, norm ? norm + '/' : '') : { dirs: [], files: [] }
    let rows = ''
    if (!bucket) {
      const res = await c._s3.send(new ListBucketsCommand({}))
      rows = (res.Buckets || []).map((b) => `<li><a href="/dav/${hrefEncode(b.Name)}/">${xmlEscape(b.Name)}/</a></li>`).join('')
    } else {
      const base = `/dav/${hrefEncode(bucket)}/${hrefEncode(norm)}`
      rows =
        dirs.map((d) => `<li><a href="${base.replace(/\/$/, '')}/${hrefEncode(d.replace(/\/$/, '').split('/').pop())}/">${xmlEscape(d.split('/').slice(-2, -1)[0])}/</a></li>`).join('') +
        files.map((f) => `<li><a href="${base.replace(/\/$/, '')}/${hrefEncode(f.Key.split('/').pop())}">${xmlEscape(f.Key.split('/').pop())}</a></li>`).join('')
    }
    return c.html(`<html><body><h1>R2 Explorer WebDAV</h1><ul>${rows || '<li>（空）</li>'}</ul></body></html>`)
  }

  const head = await headOr404(c, bucket, normKey(key))
  if (!head) return c.body(null, 404)

  const headers = {
    'Content-Type': mimeOf(key),
    ETag: head.ETag || '',
    'Last-Modified': httpDate(head.LastModified),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': contentDispositionInline(key),
    'Cache-Control': 'no-store',
  }
  if (head.ContentLength != null) headers['Content-Length'] = String(head.ContentLength)

  // HEAD：只回元信息，不拉内容
  if (isHead) return c.body(null, 200, headers)

  const rangeHeader = c.req.header('Range')
  if (rangeHeader) {
    let obj
    try {
      obj = await c._s3.send(new GetObjectCommand({ Bucket: bucket, Key: normKey(key), Range: rangeHeader }))
    } catch (e) {
      const code = e?.$metadata?.httpStatusCode
      return c.body(null, code === 404 ? 404 : 500)
    }
    if (obj.ContentRange) headers['Content-Range'] = obj.ContentRange
    if (obj.ContentLength != null) headers['Content-Length'] = String(obj.ContentLength)
    return c.body(obj.Body.transformToWebStream(), 206, headers)
  }

  let obj
  try {
    obj = await c._s3.send(new GetObjectCommand({ Bucket: bucket, Key: normKey(key) }))
  } catch (e) {
    const code = e?.$metadata?.httpStatusCode
    return c.body(null, code === 404 ? 404 : 500)
  }
  if (obj.ContentLength != null) headers['Content-Length'] = String(obj.ContentLength)
  return c.body(obj.Body.transformToWebStream(), 200, headers)
}

function contentDispositionInline(key) {
  const fname = key.split('/').pop()
  return `inline; filename*=UTF-8''${encodeURIComponent(fname)}`
}

async function handlePut(c, { bucket, key }) {
  if (!bucket || !key || pathnameEndsWithSlash(c)) return c.body(null, 409)
  const norm = normKey(key)
  // 不能覆盖目录标记
  const existing = await stat(c, bucket, norm)
  if (existing?.type === 'collection') return c.body(null, 409)

  const lenHeader = Number(c.req.header('content-length') || 0)
  let body
  let contentLength
  if (lenHeader > 0) {
    body = c.env.incoming // Node 原生流直通 S3，不吃内存
    contentLength = lenHeader
  } else {
    const buf = Buffer.from(await c.req.raw.arrayBuffer())
    if (buf.length > CHUNKED_PUT_CAP) return c.body(null, 413)
    body = buf
    contentLength = buf.length
  }
  try {
    await c._s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: norm,
        Body: body,
        ...(contentLength ? { ContentLength: contentLength } : {}),
        ContentType: mimeOf(norm),
      })
    )
  } catch (e) {
    return c.body(null, 500)
  }
  return c.body(null, 201)
}

async function handleMkcol(c, { bucket, key }) {
  if (!bucket) return c.body(null, 403)
  const norm = normKey(key)
  if (!norm) return c.body(null, 405)
  const st = await stat(c, bucket, norm)
  if (st) return c.body(null, 405) // 已存在
  // 父目录必须存在（WebDAV 语义）
  const parent = norm.split('/').slice(0, -1).join('/')
  if (parent && !(await stat(c, bucket, parent))) return c.body(null, 409)
  try {
    await c._s3.send(new PutObjectCommand({ Bucket: bucket, Key: norm + '/', Body: new Uint8Array(0), ContentLength: 0 }))
  } catch {
    return c.body(null, 500)
  }
  return c.body(null, 201)
}

async function handleDelete(c, { bucket, key }) {
  if (!bucket) return c.body(null, 403)
  const norm = normKey(key)
  if (!norm) return c.body(null, 403) // 禁止删桶
  const st = await stat(c, bucket, norm)
  if (!st) return c.body(null, 404)

  if (st.type === 'file') {
    await c._s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: norm }))
    return c.body(null, 204)
  }

  // 集合删除：清空前缀下全部对象 + 目录标记
  const prefix = norm + '/'
  const objects = []
  for await (const o of listAll(c, bucket, prefix)) objects.push({ Key: o.Key })
  // 目录标记本身（norm/ 形式在上面 prefix 内已含）；无标记则补删 key（保险）
  for (let i = 0; i < objects.length; i += 1000) {
    await c._s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.slice(i, i + 1000) } }))
  }
  await c._s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: norm })).catch(() => {})
  return c.body(null, 204)
}

async function copyOne(c, srcBucket, srcKey, dstBucket, dstKey) {
  await c._s3.send(
    new CopyObjectCommand({ Bucket: dstBucket, Key: dstKey, CopySource: `/${encodeURIComponent(srcBucket)}/${srcKey.split('/').map(encodeURIComponent).join('/')}` })
  )
}

async function handleCopyMove(c, target, move) {
  const dst = parseDestination(c.req.header('Destination'))
  if (!dst) return c.body(null, 400)
  const { bucket, key } = target
  if (!bucket) return c.body(null, 403)
  const norm = normKey(key)
  if (!norm) return c.body(null, 403)
  const st = await stat(c, bucket, norm)
  if (!st) return c.body(null, 404)
  const dstNorm = normKey(dst.key)
  if (bucket === dst.bucket && norm === dstNorm) return c.body(null, 403)

  if (st.type === 'file') {
    try {
      await copyOne(c, bucket, norm, dst.bucket, dstNorm)
    } catch {
      return c.body(null, 500)
    }
    if (move) await c._s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: norm }))
    return c.body(null, move ? 201 : 204)
  }

  // 集合：逐条复制（引用同一账号内任意桶）
  const prefix = norm + '/'
  let count = 0
  for await (const o of listAll(c, bucket, prefix)) {
    if (++count > COPY_CAP) return c.body(null, 507)
    const rel = o.Key.slice(prefix.length)
    try {
      await copyOne(c, bucket, o.Key, dst.bucket, dstNorm + '/' + rel)
    } catch {
      return c.body(null, 500)
    }
  }
  if (move) {
    const objects = []
    for await (const o of listAll(c, bucket, prefix)) objects.push({ Key: o.Key })
    for (let i = 0; i < objects.length; i += 1000) {
      await c._s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.slice(i, i + 1000) } }))
    }
    await c._s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: norm })).catch(() => {})
  }
  return c.body(null, move ? 201 : 204)
}

function handleLock(c, target) {
  const { bucket, key } = target
  const path = `/dav/${bucket}/${normKey(key || '')}`
  const token = `opaquelocktoken:${crypto.randomUUID()}`
  locks.set(path, { token, exp: Date.now() + LOCK_TTL })
  // 过期清理
  for (const [p, l] of locks) if (l.exp < Date.now()) locks.delete(p)
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>
<D:locktype><D:write/></D:locktype>
<D:lockscope><D:exclusive/></D:lockscope>
<D:depth>0</D:depth>
<D:timeout>Second-${Math.round(LOCK_TTL / 1000)}</D:timeout>
<D:locktoken><D:href>${token}</D:href></D:locktoken>
<D:lockroot><D:href>${xmlEscape(path)}</D:href></D:lockroot>
</D:activelock></D:lockdiscovery></D:prop>`
  return c.body(body, 200, { 'Content-Type': 'application/xml; charset=utf-8' })
}

function handleUnlock(c, target) {
  const path = `/dav/${target.bucket}/${normKey(target.key || '')}`
  locks.delete(path)
  return c.body(null, 204)
}

// ---------- 注册入口 ----------

export function registerWebDAV(app, { AUTH_PASSWORD }) {
  if (!AUTH_PASSWORD) {
    console.warn('[webdav] AUTH_PASSWORD 未配置，WebDAV 已禁用')
    return
  }

  app.all('/dav/*', async (c) => {
    if (!checkBasicAuth(c, AUTH_PASSWORD)) return unauthorized(c)
    const target = parsePath(c.req.path)
    const method = c.req.method.toUpperCase()

    try {
      switch (method) {
        case 'OPTIONS':
          return c.body(null, 200, {
            DAV: '1, 2',
            'MS-Author-Via': 'DAV',
            Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK',
          })
        case 'PROPFIND':
          return handlePropfind(c, target)
        case 'GET':
          return handleGetHead(c, target, false)
        case 'HEAD':
          return handleGetHead(c, target, true)
        case 'PUT':
          return handlePut(c, target)
        case 'MKCOL':
          return handleMkcol(c, target)
        case 'DELETE':
          return handleDelete(c, target)
        case 'COPY':
          return handleCopyMove(c, target, false)
        case 'MOVE':
          return handleCopyMove(c, target, true)
        case 'PROPPATCH':
          // 假装成功（Finder 会设置修改时间等）
          return c.body(
            `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${xmlEscape(c.req.path)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
            207,
            { 'Content-Type': 'application/xml; charset=utf-8' }
          )
        case 'LOCK':
          return handleLock(c, target)
        case 'UNLOCK':
          return handleUnlock(c, target)
        default:
          return c.body(null, 405)
      }
    } catch (e) {
      const code = e?.$metadata?.httpStatusCode
      if (code === 404 || e.name === 'NotFound' || e.name === 'NoSuchBucket') return c.body(null, 404)
      console.error('[webdav]', method, c.req.path, e.message || e)
      return c.body(null, 500)
    }
  })

  // /dav 本身（无尾斜杠）重定向
  app.get('/dav', (c) => c.redirect('/dav/', 301))
  console.log('[webdav] WebDAV 已启用：/dav/（Basic 认证，密码 = 登录密码）')
}
