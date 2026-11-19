import { api } from './api'
import { useStore } from './store'

const MULTIPART_THRESHOLD = 50 * 1024 * 1024 // 超过 50MB 走分片
const CHUNK_SIZE = 16 * 1024 * 1024 // 分片 16MB
const PART_RETRIES = 3 // 单个分片网络失败自动重试次数（1s/2s/4s 退避）

let seq = 0
const activeXhrs = new Map() // taskId -> 当前 xhr（用于取消）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isCancelled(id) {
  const t = useStore.getState().uploads.find((x) => x.id === id)
  return !t || !!t.cancelRequested
}

function xhrSend(id, method, url, blob, onProgress, contentType) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    activeXhrs.set(id, xhr)
    xhr.open(method, url)
    if (contentType) xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total)
    }
    xhr.onload = () => {
      activeXhrs.delete(id)
      if (xhr.status < 400) {
        let data = null
        try {
          data = JSON.parse(xhr.responseText)
        } catch {}
        resolve(data)
      } else {
        let msg = `请求失败 (${xhr.status})`
        try {
          msg = JSON.parse(xhr.responseText).error || msg
        } catch {}
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => {
      activeXhrs.delete(id)
      reject(new Error('网络错误'))
    }
    xhr.onabort = () => {
      activeXhrs.delete(id)
      reject(new Error('已取消'))
    }
    xhr.send(blob)
  })
}

// 网络类失败自动重试；用户取消不重试
async function xhrSendRetry(id, method, url, blob, onProgress, contentType) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await xhrSend(id, method, url, blob, onProgress, contentType)
    } catch (e) {
      if (e.message === '已取消' || isCancelled(id) || attempt >= PART_RETRIES) throw e
      await sleep(1000 * 2 ** attempt)
    }
  }
}

async function uploadOne(task, bucket) {
  const { patchUpload } = useStore.getState()
  const id = task.id
  const setPct = (loaded, total) => patchUpload(id, { pct: Math.round((loaded / total) * 100) })

  // 小文件：整体直传（失败自动重试）
  if (task.size <= MULTIPART_THRESHOLD) {
    await xhrSendRetry(
      id,
      'POST',
      `/api/upload?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(task.key)}`,
      task.file,
      setPct,
      task.file.type || 'application/octet-stream'
    )
    return
  }

  // 分片上传 + 断点续传：失败时保留 uploadId 与已传分片，重试时只补未传的分片
  let uploadId = task.uploadId || null
  let parts = task.parts || []
  if (!uploadId) {
    const init = await api(
      `/api/multipart/init?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(task.key)}`,
      { method: 'POST' }
    )
    uploadId = init.uploadId
    parts = []
    patchUpload(id, { uploadId, parts, partTag: '分片' })
  }
  const partCount = Math.ceil(task.size / CHUNK_SIZE)
  let uploadedBytes = parts.length * CHUNK_SIZE
  try {
    for (let i = parts.length + 1; i <= partCount; i++) {
      if (isCancelled(id)) throw new Error('已取消')
      const start = (i - 1) * CHUNK_SIZE
      const blob = task.file.slice(start, Math.min(start + CHUNK_SIZE, task.size))
      const base = uploadedBytes
      const res = await xhrSendRetry(
        id,
        'PUT',
        `/api/multipart/part?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(task.key)}` +
          `&uploadId=${encodeURIComponent(uploadId)}&partNumber=${i}`,
        blob,
        (loaded, total) => setPct(base + loaded, task.size),
        'application/octet-stream'
      )
      parts = [...parts, { partNumber: i, etag: res.etag }]
      uploadedBytes += blob.size
      patchUpload(id, { parts })
    }
    if (isCancelled(id)) throw new Error('已取消')
    await api(
      `/api/multipart/complete?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(task.key)}` +
        `&uploadId=${encodeURIComponent(uploadId)}`,
      { method: 'POST', body: JSON.stringify({ parts }) }
    )
    patchUpload(id, { uploadId: null, parts: null })
  } catch (e) {
    // 仅用户主动取消才中止分片任务；失败保留断点，等待重试
    if (e.message === '已取消') {
      api(
        `/api/multipart/abort?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(task.key)}` +
          `&uploadId=${encodeURIComponent(uploadId)}`,
        { method: 'POST' }
      ).catch(() => {})
      patchUpload(id, { uploadId: null, parts: null })
    }
    throw e
  }
}

// 批量上传：串行执行，全部结束后 resolve（调用方刷新列表）
export async function startUpload(files, bucket, prefix) {
  if (!bucket) {
    useStore.getState().toast('请先进入某个存储桶', 'error')
    return false
  }
  const fresh = [...files].filter((f) => f.size > 0)
  if (!fresh.length) {
    useStore.getState().toast('没有可上传的文件', 'error')
    return false
  }
  const tasks = fresh.map((file) => ({
    id: 'up' + ++seq,
    file,
    name: file.name,
    key: prefix + file.name,
    size: file.size,
    bucket,
    pct: 0,
    status: 'pending', // pending | uploading | done | fail | cancelled
    error: '',
    partTag: file.size > MULTIPART_THRESHOLD ? '分片' : '',
    cancelRequested: false,
    uploadId: null,
    parts: null,
  }))
  useStore.getState().pushUploads(tasks)
  useStore.getState().setUploadPanelOpen(true)

  const { patchUpload } = useStore.getState()
  for (const task of tasks) {
    if (task.status !== 'pending') continue
    patchUpload(task.id, { status: 'uploading' })
    try {
      await uploadOne(task, bucket)
      patchUpload(task.id, { status: 'done', pct: 100 })
    } catch (e) {
      patchUpload(task.id, { status: e.message === '已取消' ? 'cancelled' : 'fail', error: e.message })
    }
  }
  const all = useStore.getState().uploads.filter((t) => tasks.some((x) => x.id === t.id))
  const ok = all.filter((t) => t.status === 'done').length
  const fail = all.filter((t) => t.status === 'fail').length
  const cancel = all.filter((t) => t.status === 'cancelled').length
  let msg = `上传完成：${ok} 成功`
  if (fail) msg += `，${fail} 失败`
  if (cancel) msg += `，${cancel} 已取消`
  useStore.getState().toast(msg, fail ? 'error' : 'info')
  return fail === 0 && cancel === 0
}

// 手动重试失败/已取消的任务：小文件整体重传，大文件从已传分片续传
export async function retryUpload(task) {
  const { patchUpload, toast } = useStore.getState()
  const cur = useStore.getState().uploads.find((t) => t.id === task.id)
  if (!cur || (cur.status !== 'fail' && cur.status !== 'cancelled')) return
  patchUpload(task.id, { status: 'uploading', error: '', cancelRequested: false })
  try {
    await uploadOne(cur, cur.bucket)
    patchUpload(task.id, { status: 'done', pct: 100 })
    useStore.getState().bumpUploadsVersion()
    toast(`「${cur.name}」上传完成`, 'info')
  } catch (e) {
    patchUpload(task.id, { status: e.message === '已取消' ? 'cancelled' : 'fail', error: e.message })
  }
}

// 清空已结束任务：顺带中止仍持有断点的失败分片任务，避免 R2 侧残留分片
export function clearFinishedUploads() {
  const { uploads, clearFinishedUploads: clear } = useStore.getState()
  for (const t of uploads) {
    if (t.status === 'fail' && t.uploadId) {
      api(
        `/api/multipart/abort?bucket=${encodeURIComponent(t.bucket)}&key=${encodeURIComponent(t.key)}` +
          `&uploadId=${encodeURIComponent(t.uploadId)}`,
        { method: 'POST' }
      ).catch(() => {})
    }
  }
  clear()
}

export function cancelUpload(task) {
  useStore.getState().patchUpload(task.id, { cancelRequested: true })
  activeXhrs.get(task.id)?.abort()
  useStore.getState().patchUpload(task.id, { status: 'cancelled', error: '已取消' })
}

// 离开/刷新页面时清理失败任务保留的断点，避免 R2 上残留未完成的分片上传。
// 刷新后 File 对象已不可用，断点本身也无法续传，清空后重试会重新 init（行为正确）。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    const { uploads, patchUpload } = useStore.getState()
    for (const t of uploads) {
      if (t.status === 'fail' && t.uploadId) {
        fetch(
          `/api/multipart/abort?bucket=${encodeURIComponent(t.bucket)}&key=${encodeURIComponent(t.key)}` +
            `&uploadId=${encodeURIComponent(t.uploadId)}`,
          { method: 'POST', keepalive: true }
        ).catch(() => {})
        patchUpload(t.id, { uploadId: null, parts: null })
      }
    }
  })
}
