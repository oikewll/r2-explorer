import { api } from './api'

// ---------- 能力探测（Node/Docker 版支持 ffmpeg 转码，Workers 不支持） ----------
let capsPromise = null
export function capabilities() {
  if (!capsPromise) {
    capsPromise = api('/api/capabilities').catch(() => ({ transcode: false }))
  }
  return capsPromise
}

// ---------- 播放位置记忆（key: bucket/path → 秒） ----------
const POS_KEY = 'r2x_video_pos'

function posMap() {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) || '{}')
  } catch {
    return {}
  }
}

export function getSavedPos(bucket, path) {
  return posMap()[`${bucket}/${path}`] || 0
}

export function savePos(bucket, path, t) {
  if (!isFinite(t) || t <= 0) return
  try {
    const m = posMap()
    m[`${bucket}/${path}`] = Math.floor(t)
    localStorage.setItem(POS_KEY, JSON.stringify(m))
  } catch {}
}

export function clearPos(bucket, path) {
  try {
    const m = posMap()
    delete m[`${bucket}/${path}`]
    localStorage.setItem(POS_KEY, JSON.stringify(m))
  } catch {}
}

// ---------- 转码会话 ----------
export async function startTranscode(bucket, path, ss) {
  return api('/api/transcode/start', {
    method: 'POST',
    body: JSON.stringify({ bucket, key: path, ss }),
  })
}

export function stopTranscode(id) {
  if (!id) return
  api('/api/transcode/stop', { method: 'POST', body: JSON.stringify({ id }) }).catch(() => {})
}

// ---------- 连续剧：按文件名自然排序找下一集 ----------
export function nextVideoOf(files, current) {
  if (!files?.length) return null
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const i = sorted.findIndex((x) => x.path === current.path)
  if (i < 0 || i >= sorted.length - 1) return null
  return sorted[i + 1]
}
