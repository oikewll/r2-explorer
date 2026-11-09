// ---------- 离线下载（仅 Node/Docker 版；Workers 有子请求/时长限制跑不了后台下载） ----------
// 流式下载 HTTP(S) 直链 → 分块直传 R2 multipart，全程不落盘
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PART_SIZE = 8 * 1024 * 1024 // 分片大小 8MB（R2 除最后一片外最小 5MB）
const MAX_CONCURRENT = 2 // 同时下载任务数，其余排队
const MAX_TASKS = 200 // 历史任务保留上限
const PART_CAP = 10000 // S3 分片数上限 → 8MB × 10000 = 80GB

export function registerOfflineDownload(app, { dataFile, resolveAccount, mimeFor, invalidateStats, authGuard }) {
  const STORE_PATH = dataFile

  let tasks = []

  function persist() {
    try {
      fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true })
      fs.writeFileSync(
        STORE_PATH,
        JSON.stringify(
          tasks.slice(-MAX_TASKS).map(({ _ctrl, ...t }) => t),
          null,
          2
        )
      )
    } catch (e) {
      console.warn('[offline] persist failed:', e.message)
    }
  }

  function load() {
    try {
      const list = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
      if (Array.isArray(list)) tasks = list
    } catch {}
    // 重启恢复：进行中/排队的任务无法续传，标记失败可重试
    for (const t of tasks) {
      if (t.status === 'queued' || t.status === 'running') {
        t.status = 'failed'
        t.error = '服务重启导致任务中断，可重试'
        t.speed = 0
        t.uploadId = undefined
      }
      delete t._ctrl
    }
  }
  load()

  function sanitize(t) {
    return {
      id: t.id,
      url: t.url,
      bucket: t.bucket,
      key: t.key,
      accountId: t.accountId,
      status: t.status,
      name: t.name,
      size: t.size,
      downloaded: t.downloaded,
      speed: t.speed,
      error: t.error || '',
      createdAt: t.createdAt,
      finishedAt: t.finishedAt || null,
    }
  }

  function fail(t, msg) {
    t.status = 'failed'
    t.error = msg
    t.speed = 0
    t.finishedAt = Date.now()
    persist()
  }

  // ---------- 任务执行 ----------
  async function runTask(t) {
    t.status = 'running'
    t.error = ''
    t.downloaded = 0
    t.speed = 0
    t.finishedAt = null
    persist()

    const acc = resolveAccount(t.accountId)
    if (!acc) {
      fail(t, '任务绑定的 R2 账号已被移除，无法执行')
      return
    }
    const client = acc.client
    const ctrl = new AbortController()
    t._ctrl = ctrl
    let uploadId = null

    // 速率采样（每秒）
    let lastTick = Date.now()
    let lastBytes = 0
    let persistTick = 0
    const speedTimer = setInterval(() => {
      const now = Date.now()
      const dt = now - lastTick
      if (dt > 200) {
        t.speed = Math.round(((t.downloaded - lastBytes) * 1000) / dt)
        lastBytes = t.downloaded
        lastTick = now
      }
      if (now - persistTick > 5000) {
        persistTick = now
        persist()
      }
    }, 1000)

    try {
      const dl = await fetch(t.url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'r2-explorer (+offline-download)' },
      })
      if (!dl.ok) throw new Error(`下载失败：HTTP ${dl.status} ${dl.statusText || ''}`.trim())
      if (!dl.body) throw new Error('下载失败：响应没有内容')

      const lenHeader = Number(dl.headers.get('content-length') || '')
      t.size = Number.isFinite(lenHeader) && lenHeader >= 0 ? lenHeader : -1
      const ctype = (dl.headers.get('content-type') || '').split(';')[0].trim()

      // 建立分片上传会话
      const mp = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: t.bucket,
          Key: t.key,
          ContentType: ctype && ctype !== 'application/octet-stream' ? ctype : mimeFor(t.key),
        })
      )
      uploadId = mp.UploadId

      const reader = dl.body.getReader()
      const parts = []
      let pending = [] // 已读但未凑满一片的 chunk 队列
      let pendingLen = 0
      let partNo = 0

      // 从 pending 队列头部精确取出 want 字节（R2 要求除最后一片外分片长度必须一致）
      const takeExact = (want) => {
        const first = pending[0]
        if (first.length === want) {
          pending.shift()
          pendingLen -= want
          return first
        }
        if (first.length > want) {
          pending[0] = first.subarray(want)
          pendingLen -= want
          return first.subarray(0, want)
        }
        const body = Buffer.alloc(want)
        let off = 0
        while (off < want) {
          const c = pending[0]
          const remain = want - off
          if (c.length <= remain) {
            body.set(c, off)
            off += c.length
            pending.shift()
          } else {
            body.set(c.subarray(0, remain), off)
            pending[0] = c.subarray(remain)
            off = want
          }
        }
        pendingLen -= want
        return body
      }

      const uploadOne = async (body, isLast) => {
        if (partNo >= PART_CAP) throw new Error(`文件超过分片上限（约 ${Math.round((PART_CAP * PART_SIZE) / 1024 / 1024 / 1024)}GB），不支持`)
        partNo++
        const r = await client.send(
          new UploadPartCommand({
            Bucket: t.bucket,
            Key: t.key,
            UploadId: uploadId,
            PartNumber: partNo,
            Body: body.length ? body : new Uint8Array(0),
          })
        )
        parts.push({ PartNumber: partNo, ETag: r.ETag })
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // fetch 的 chunk 是 Uint8Array，转成 Buffer 保证后续 concat/subarray 语义一致
        pending.push(Buffer.from(value))
        pendingLen += value.length
        t.downloaded += value.length
        // 凑满一片就精确切出 PART_SIZE 上传，剩余字节留给下一片
        while (pendingLen >= PART_SIZE) await uploadOne(takeExact(PART_SIZE), false)
      }
      if (pendingLen > 0 || partNo === 0) await uploadOne(Buffer.concat(pending), true)
      pending = []
      pendingLen = 0

      if (t.downloaded === 0) {
        // 空文件：分片上传不收 0 字节，改用 PutObject
        await client.send(new AbortMultipartUploadCommand({ Bucket: t.bucket, Key: t.key, UploadId: uploadId }))
        uploadId = null
        await client.send(new PutObjectCommand({ Bucket: t.bucket, Key: t.key, Body: new Uint8Array(0) }))
      } else {
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: t.bucket,
            Key: t.key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          })
        )
        uploadId = null
      }
      if (t.size === -1) t.size = t.downloaded
      t.status = 'completed'
      t.speed = 0
      t.finishedAt = Date.now()
      invalidateStats(t.accountId, t.bucket)
      persist()
    } catch (e) {
      if (uploadId) {
        try {
          await client.send(new AbortMultipartUploadCommand({ Bucket: t.bucket, Key: t.key, UploadId: uploadId }))
        } catch {}
        uploadId = null
      }
      if (ctrl.signal.aborted) {
        t.status = 'cancelled'
        t.speed = 0
        t.finishedAt = Date.now()
        persist()
      } else {
        fail(t, e?.message ? String(e.message).slice(0, 300) : String(e))
      }
    } finally {
      clearInterval(speedTimer)
      t._ctrl = undefined
      pump()
    }
  }

  function pump() {
    let running = tasks.filter((t) => t.status === 'running').length
    while (running < MAX_CONCURRENT) {
      const next = tasks.find((t) => t.status === 'queued')
      if (!next) break
      running++
      runTask(next) // 不 await：串行调度由 runTask finally 里的 pump 接力
    }
  }

  // ---------- 文件名工具 ----------
  function nameFromUrl(u) {
    try {
      const p = new URL(u)
      const seg = p.pathname.split('/').filter(Boolean).pop()
      if (!seg) return ''
      const decoded = decodeURIComponent(seg).trim()
      return decoded && !decoded.endsWith('/') ? decoded : ''
    } catch {
      return ''
    }
  }

  function nameFromDisposition(disposition) {
    if (!disposition) return ''
    const star = /filename\*\s*=\s*(?:utf-8|UTF-8)''([^;]+)/.exec(disposition)
    if (star) {
      try { return decodeURIComponent(star[1]).trim() } catch {}
    }
    const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/.exec(disposition)
    if (plain) return (plain[1] || plain[2] || '').trim()
    return ''
  }

  function sanitizeName(name) {
    let n = String(name || '')
      .replace(/[/\\:\*\?"<>|\x00-\x1f]/g, '_')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 200)
    return n
  }

  function defaultName() {
    const d = new Date()
    const pad = (x) => String(x).padStart(2, '0')
    return `download-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  }

  // ---------- API ----------
  // 探测直链：取文件名 / 大小 / 类型，用于创建任务前预填
  app.post('/api/download/resolve', authGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const url = String(body.url || '').trim()
    if (!/^https?:\/\//i.test(url)) return c.json({ error: '仅支持 http/https 直链' }, 400)
    try {
      let res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': 'r2-explorer (+offline-download)' } })
      if (!res.ok) {
        // 部分服务器不支持 HEAD，退回 Range GET
        res = await fetch(url, { headers: { range: 'bytes=0-0', 'user-agent': 'r2-explorer (+offline-download)' }, redirect: 'follow' })
        try { await res.body?.cancel() } catch {}
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
      } else {
        try { await res.body?.cancel() } catch {}
      }
      let name = nameFromDisposition(res.headers.get('content-disposition')) || nameFromUrl(url)
      const sizeHeader = Number(res.headers.get('content-length') || '')
      // Range 探测时 content-length 是分片长度，取 content-range 总长
      let total = Number.isFinite(sizeHeader) && sizeHeader >= 0 ? sizeHeader : -1
      const crange = /bytes\s+\d+-\d+\/(\d+|\*)/.exec(res.headers.get('content-range') || '')
      if (crange && crange[1] !== '*') total = Number(crange[1])
      return c.json({
        name: name || '',
        size: total,
        contentType: (res.headers.get('content-type') || '').split(';')[0].trim(),
        acceptsRange: !!(res.headers.get('accept-ranges') || '').match(/bytes/),
      })
    } catch (e) {
      return c.json({ error: `无法访问该链接：${e?.message || e}` }, 400)
    }
  })

  // 任务列表
  app.get('/api/download/tasks', authGuard, (c) => {
    return c.json({ tasks: tasks.map(sanitize).reverse() }) // 新任务在前
  })

  // 创建任务
  app.post('/api/download/tasks', authGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const url = String(body.url || '').trim()
    const bucket = String(body.bucket || '')
    const prefix = String(body.prefix || '')
    const name = sanitizeName(body.name) || sanitizeName(nameFromUrl(url)) || defaultName()
    if (!/^https?:\/\//i.test(url)) return c.json({ error: '仅支持 http/https 直链' }, 400)
    if (!bucket) return c.json({ error: 'missing bucket' }, 400)
    if (prefix && !prefix.endsWith('/')) return c.json({ error: 'bad prefix' }, 400)
    const key = prefix + name
    if (key.endsWith('/') || key.includes('//')) return c.json({ error: '目标路径不合法' }, 400)
    if (!c._account) return c.json({ error: '未配置 R2 凭证' }, 500)

    const dup = tasks.find(
      (t) => t.bucket === bucket && t.key === key && (t.status === 'queued' || t.status === 'running')
    )
    if (dup) return c.json({ error: '相同目标文件的任务正在进行中' }, 409)
    if (tasks.length >= MAX_TASKS) tasks = tasks.slice(-Math.floor(MAX_TASKS / 2))

    const t = {
      id: crypto.randomUUID().slice(0, 8),
      url,
      bucket,
      key,
      accountId: c._account.id,
      status: 'queued',
      name,
      size: -1,
      downloaded: 0,
      speed: 0,
      error: '',
      createdAt: Date.now(),
    }
    tasks.push(t)
    persist()
    pump()
    return c.json({ ok: true, task: sanitize(t) })
  })

  // 重试
  app.post('/api/download/tasks/:id/retry', authGuard, (c) => {
    const t = tasks.find((x) => x.id === c.req.param('id'))
    if (!t) return c.json({ error: '任务不存在' }, 404)
    if (t.status !== 'failed' && t.status !== 'cancelled') return c.json({ error: '该状态不可重试' }, 400)
    t.status = 'queued'
    t.downloaded = 0
    t.speed = 0
    t.error = ''
    t.finishedAt = null
    persist()
    pump()
    return c.json({ ok: true })
  })

  // 删除任务（进行中的先取消再移除）
  app.delete('/api/download/tasks/:id', authGuard, async (c) => {
    const idx = tasks.findIndex((x) => x.id === c.req.param('id'))
    if (idx < 0) return c.json({ error: '任务不存在' }, 404)
    const t = tasks[idx]
    if (t._ctrl) {
      t._ctrl.abort() // runTask 里会中止分片上传并标记 cancelled
    }
    tasks.splice(idx, 1)
    persist()
    return c.json({ ok: true })
  })

  // 清理已结束的任务（完成/失败/取消）
  app.post('/api/download/clear', authGuard, (c) => {
    const before = tasks.length
    tasks = tasks.filter((t) => t.status === 'queued' || t.status === 'running')
    persist()
    return c.json({ ok: true, removed: before - tasks.length })
  })
}
