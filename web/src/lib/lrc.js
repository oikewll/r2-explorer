import { api } from './api'

// ---------- LRC 解析 ----------
// 支持：多个时间标签一行 [00:12.5][01:02.30]重复段、[offset:±ms] 全局偏移、
// 元信息 [ti:][ar:][al:]、CRLF、两位/三位毫秒
export function parseLrc(text) {
  const meta = {}
  const offsetTag = text.match(/\[offset:\s*([+-]?\d+)\s*\]/i)
  // 按通用约定：正值 offset 表示歌词提前出现 → 有效时间 = 标签时间 - offset
  const offset = offsetTag ? -Number(offsetTag[1]) / 1000 : 0
  const lines = []
  const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    re.lastIndex = 0
    const times = []
    let m
    while ((m = re.exec(raw))) {
      const min = +m[1]
      const sec = +m[2]
      // ".5" → 500ms，".52" → 520ms，"523" → 523ms
      const frac = m[3] ? +m[3].padEnd(3, '0').slice(0, 3) / 1000 : 0
      times.push(min * 60 + sec + frac)
    }
    if (times.length) {
      const txt = raw.replace(re, '').trim()
      for (const t of times) lines.push({ time: Math.max(0, t + offset), text: txt })
    } else {
      const mm = raw.match(/^\[(ti|ar|al|by|length):(.*)\]\s*$/i)
      if (mm) meta[mm[1].toLowerCase()] = mm[2].trim()
    }
  }
  lines.sort((a, b) => a.time - b.time)
  return { meta, lines, times: lines.map((l) => l.time) }
}

// 游标法查当前行：缓存上次 index，均摊 O(1)；seek 后自动回退
export function findLine(times, t, cursorRef) {
  let i = cursorRef.current
  if (i >= times.length) i = times.length - 1
  if (i < -1) i = -1
  while (i + 1 < times.length && times[i + 1] <= t) i++
  while (i >= 0 && times[i] > t) i--
  cursorRef.current = i
  return i
}

// ---------- LRC 获取 ----------
// 约定：与音频同目录同名 .lrc（foo.mp3 → foo.lrc），走 /api/text 同源代理
const cache = new Map() // "bucket/path" → parsed | null（含未命中缓存，避免反复请求）

export async function fetchLrc(track) {
  const key = `${track.bucket}/${track.path}`
  if (cache.has(key)) return cache.get(key)
  const lrcKey = track.path.replace(/\.[^.]+$/, '') + '.lrc'
  try {
    const text = await api(
      `/api/text?bucket=${encodeURIComponent(track.bucket)}&key=${encodeURIComponent(lrcKey)}`
    )
    const parsed = parseLrc(text)
    const result = parsed.lines.length ? parsed : null
    cache.set(key, result)
    return result
  } catch {
    cache.set(key, null)
    return null
  }
}
