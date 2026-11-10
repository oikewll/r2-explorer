// 客户端缩略图生成：IndexedDB 缓存（key = 路径+大小+修改时间，文件变了自动重新生成）
// 图片：fetch 原图 → createImageBitmap 缩放 → JPEG blob
// 视频：不用这里（组件直接用 <video preload="metadata"> 抽帧，浏览器按 Range 只拉需要的字节）

const DB_NAME = 'r2x_thumbs'
const STORE = 'thumbs'

let dbPromise = null
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

async function cacheGet(key) {
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

async function cachePut(key, blob) {
  try {
    const db = await openDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(blob, key)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  } catch {}
}

// 能缩略的图片类型（svg 是矢量文本、heic 浏览器普遍不能解码，都不生成）
const THUMBABLE = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'ico'])

export function canThumb(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase()
  return THUMBABLE.has(ext)
}

const RAW_URL = (f) => '/api/raw?bucket=' + encodeURIComponent(f.bucket) + '&key=' + encodeURIComponent(f.path)

// 生成 + 缓存 + 去重
const inflight = new Map()

async function generate(f, cacheKey) {
  const res = await fetch(RAW_URL(f))
  if (!res.ok) throw new Error('fetch failed')
  const blob = await res.blob()
  const bitmap = await createImageBitmap(blob, { resizeWidth: 480, resizeQuality: 'low' })
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  bitmap.close()
  const thumb = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.8)
  )
  cachePut(cacheKey, thumb)
  return URL.createObjectURL(thumb)
}

// 并发队列：同一时刻最多 2 张图在生成，避免整墙图片同时抢带宽
let active = 0
const queue = []
function schedule(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject })
    drain()
  })
}
function drain() {
  while (active < 2 && queue.length) {
    const { job, resolve, reject } = queue.shift()
    active++
    job()
      .then(resolve, reject)
      .finally(() => {
        active--
        drain()
      })
  }
}

// cb(url)：成功给 blob URL，失败给 null（调用方回退到类型图标）。返回取消函数。
export function requestThumb(f, cb) {
  if (!canThumb(f)) return () => {}
  const cacheKey = `t:${f.bucket}:${f.path}:${f.size}:${f.modified}`
  let cancelled = false
  ;(async () => {
    const cached = await cacheGet(cacheKey)
    if (cancelled) return
    if (cached) return cb(URL.createObjectURL(cached))
    let p = inflight.get(cacheKey)
    if (!p) {
      p = schedule(() => generate(f, cacheKey))
      inflight.set(cacheKey, p)
      p.finally(() => inflight.delete(cacheKey))
    }
    const url = await p
    if (!cancelled) cb(url)
  })().catch(() => {
    if (!cancelled) cb(null)
  })
  return () => {
    cancelled = true
  }
}
