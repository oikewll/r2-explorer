import { api } from './api'
import { useStore } from './store'

const MULTIPART_THRESHOLD = 50 * 1024 * 1024 // 超过 50MB 走分片
const CHUNK_SIZE = 16 * 1024 * 1024 // 分片 16MB

let seq = 0

function xhrSend(task, method, url, blob, onProgress, contentType) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    task._xhr = xhr
    xhr.open(method, url)
    if (contentType) xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total)
    }
    xhr.onload = () => {
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
    xhr.onerror = () => reject(new Error('网络错误'))
    xhr.onabort = () => reject(new Error('已取消'))
    xhr.send(blob)
  })
}

async function uploadOne(task, bucket) {
  const { patchUpload } = useStore.getState()
  const setPct = (loaded, total) => patchUpload(task.id, { pct: Math.round((loaded / total) * 100) })

  if (task.size <= MULTIPART_THRESHOLD) {
    await xhrSend(
      task,
      'POST',
      `/api/upload?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(task.key)}`,
      task.file,
      setPct,
      task.file.type || 'application/octet-stream'
    )
    return
  }

  // 分片上传
  const init = await api(
    `/api/multipart/init?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(task.key)}`,
    { method: 'POST' }
  )
  task.uploadId = init.uploadId
  patchUpload(task.id, { partTag: '分片' })
  const partCount = Math.ceil(task.size / CHUNK_SIZE)
  const parts = []
  let uploadedBytes = 0
  try {
    for (let i = 1; i <= partCount; i++) {
      if (task.cancelRequested) throw new Error('已取消')
      const start = (i - 1) * CHUNK_SIZE
      const blob = task.file.slice(start, Math.min(start + CHUNK_SIZE, task.size))
      const base = uploadedBytes
      const res = await xhrSend(
        task,
        'PUT',
        `/api/multipart/part?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(task.key)}` +
          `&uploadId=${encodeURIComponent(init.uploadId)}&partNumber=${i}`,
        blob,
        (loaded, total) => setPct(base + loaded, task.size),
        'application/octet-stream'
      )
      parts.push({ partNumber: i, etag: res.etag })
      uploadedBytes += blob.size
    }
    if (task.cancelRequested) throw new Error('已取消')
    await api(
      `/api/multipart/complete?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(task.key)}` +
        `&uploadId=${encodeURIComponent(init.uploadId)}`,
      { method: 'POST', body: JSON.stringify({ parts }) }
    )
  } catch (e) {
    api(
      `/api/multipart/abort?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(task.key)}` +
        `&uploadId=${encodeURIComponent(init.uploadId)}`,
      { method: 'POST' }
    ).catch(() => {})
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
    pct: 0,
    status: 'pending', // pending | uploading | done | fail | cancelled
    error: '',
    partTag: file.size > MULTIPART_THRESHOLD ? '分片' : '',
    cancelRequested: false,
    _xhr: null,
    uploadId: null,
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

export function cancelUpload(task) {
  task.cancelRequested = true
  task._xhr?.abort()
  useStore.getState().patchUpload(task.id, { status: 'cancelled', error: '已取消' })
}
