import { api } from './api'
import { useStore } from './store'

const SAVE_KEY = 'r2x_player_v1'
const SAVE_INTERVAL_MS = 5000

// 全局唯一的 audio 元素——挂在模块作用域，与路由/组件生命周期完全解耦，
// 这是「切路由不断播」的关键
let audio = null
let initialized = false
let lastSave = 0
let failStreak = 0 // 连续播放失败计数，防止全部失效时死循环
let seekingBar = false

function patchPlayer(patch) {
  useStore.getState().patchPlayer(patch)
}

function currentTrack() {
  const p = useStore.getState().player
  return p.queue[p.index] || null
}

function ensureAudio() {
  if (audio) return audio
  audio = new Audio()
  audio.preload = 'metadata'

  audio.addEventListener('timeupdate', () => {
    if (seekingBar) return
    patchPlayer({ currentTime: audio.currentTime })
    const now = Date.now()
    if (now - lastSave > SAVE_INTERVAL_MS) saveState()
  })
  audio.addEventListener('durationchange', () => {
    patchPlayer({ duration: isFinite(audio.duration) ? audio.duration : 0 })
    updatePositionState()
  })
  audio.addEventListener('playing', () => {
    failStreak = 0
    patchPlayer({ playing: true, restored: false })
    updateMediaSession()
  })
  audio.addEventListener('pause', () => {
    patchPlayer({ playing: false })
    saveState()
    updateMediaSession()
  })
  audio.addEventListener('ended', () => {
    const { mode } = useStore.getState().player
    if (mode === 'one') {
      audio.currentTime = 0
      audio.play().catch(() => {})
    } else {
      next(true)
    }
  })
  // 预签名 URL 过期（7 天）或文件被移动：重新取直链重试一次
  audio.addEventListener('error', () => {
    const track = currentTrack()
    if (!track || !audio.src) return
    if (failStreak >= 2) {
      useStore.getState().toast('播放失败：' + track.name, 'error')
      failStreak = 0
      return
    }
    failStreak++
    reSignAndRetry(track)
  })
  return audio
}

async function reSignAndRetry(track) {
  try {
    const info = await api(
      `/api/info?bucket=${encodeURIComponent(track.bucket)}&key=${encodeURIComponent(track.path)}`
    )
    const p = useStore.getState().player
    const queue = p.queue.map((t) => (t.path === track.path && t.bucket === track.bucket ? { ...t, url: info.url, presigned: info.presigned } : t))
    patchPlayer({ queue })
    const pos = audio.currentTime
    audio.src = info.url
    audio.currentTime = pos
    audio.play().catch(() => {})
  } catch {
    // 重签失败（可能切了账号），自动跳下一首
    next(true)
  }
}

// ---------- 播放控制 ----------
export const MODES = [
  { value: 'order', icon: 'repeat', title: '顺序循环' },
  { value: 'one', icon: 'repeat1', title: '单曲循环' },
  { value: 'shuffle', icon: 'shuffle', title: '随机播放' },
]

export function openFullscreen() {
  patchPlayer({ fullscreen: true })
}

export function closeFullscreen() {
  patchPlayer({ fullscreen: false })
}

// 供歌词组件以 60fps 读取真实播放进度（不经过 zustand，避免全量重渲染）
export function getAudio() {
  ensureAudio()
  return audio
}

// 点击队列列表中的某首直接切过去
export function playIndex(i) {
  const p = useStore.getState().player
  if (i < 0 || i >= p.queue.length) return
  patchPlayer({ index: i })
  loadTrack(p.queue[i], true)
  saveState()
}

function loadTrack(track, autoplay, resumeAt = 0) {
  audio.src = track.url
  audio.currentTime = resumeAt
  patchPlayer({ currentTime: resumeAt, duration: 0 })
  if (autoplay) audio.play().catch(() => {})
  setMediaMetadata(track)
}

function updateQueue(queue, index, autoplay) {
  ensureAudio()
  failStreak = 0
  patchPlayer({ queue, index, visible: true, restored: !autoplay })
  loadTrack(queue[index], autoplay)
  saveState()
}

// 点击文件列表里的音频：把当前目录全部音频注入队列，从点击的那首播起
export function playFromList(files, target) {
  const tracks = files.map((f) => ({
    name: f.name,
    path: f.path,
    bucket: f.bucket,
    url: f.url,
    presigned: f.presigned,
  }))
  const idx = tracks.findIndex((t) => t.path === target.path)
  if (idx < 0) return
  updateQueue(tracks, idx, true)
}

export function togglePlay() {
  ensureAudio()
  const p = useStore.getState().player
  if (!currentTrack()) return
  if (audio.paused) {
    audio.play().catch(() => {})
  } else {
    audio.pause()
  }
}

function pickNextIndex(p, manual) {
  if (!p.queue.length) return -1
  if (p.mode === 'shuffle') {
    if (p.queue.length === 1) return p.index
    let i
    do {
      i = Math.floor(Math.random() * p.queue.length)
    } while (i === p.index)
    return i
  }
  let i = p.index + 1
  if (i >= p.queue.length) {
    // 顺序模式循环播放；手动切歌在列表尾部也绕回
    i = 0
  }
  return i
}

export function next(auto = false) {
  const p = useStore.getState().player
  if (!p.queue.length) return
  if (auto && p.mode === 'order' && p.index === p.queue.length - 1) {
    // 播完最后一首：回到列表头但不自动连播？——循环播放，直接续播
  }
  const i = pickNextIndex(p, !auto)
  patchPlayer({ index: i })
  loadTrack(p.queue[i], true)
  saveState()
}

export function prev() {
  const p = useStore.getState().player
  if (!p.queue.length) return
  // 播放超过 3 秒时"上一首"= 回到本曲开头（常见播放器习惯）
  if (audio.currentTime > 3) {
    audio.currentTime = 0
    return
  }
  let i
  if (p.mode === 'shuffle') {
    i = pickNextIndex(p, true)
  } else {
    i = p.index - 1 < 0 ? p.queue.length - 1 : p.index - 1
  }
  patchPlayer({ index: i })
  loadTrack(p.queue[i], true)
  saveState()
}

export function seek(t) {
  if (!audio) return
  seekingBar = false
  audio.currentTime = t
  patchPlayer({ currentTime: t })
}

export function seekStart() {
  seekingBar = true
}

export function seekPreview(t) {
  patchPlayer({ currentTime: t })
}

export function setMode(mode) {
  patchPlayer({ mode })
  saveState()
}

export function closePlayer() {
  if (audio) {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }
  patchPlayer({ queue: [], index: -1, playing: false, duration: 0, currentTime: 0, visible: false, restored: true })
  try {
    localStorage.removeItem(SAVE_KEY)
  } catch {}
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = null
  }
}

// ---------- Media Session（锁屏 / 耳机 / 蓝牙控制） ----------
function setMediaMetadata(track) {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: 'R2 Explorer',
      album: track.bucket,
    })
    navigator.mediaSession.setActionHandler('play', () => togglePlay())
    navigator.mediaSession.setActionHandler('pause', () => togglePlay())
    navigator.mediaSession.setActionHandler('previoustrack', () => prev())
    navigator.mediaSession.setActionHandler('nexttrack', () => next())
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (d.seekTime != null) seek(d.seekTime)
    })
  } catch {}
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !audio || !isFinite(audio.duration)) return
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: audio.currentTime,
    })
  } catch {}
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'
  } catch {}
}

// ---------- 状态持久化（跨会话恢复，恢复后不自动播放，等用户手势） ----------
function saveState() {
  lastSave = Date.now()
  const p = useStore.getState().player
  if (!p.queue.length) return
  try {
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        queue: p.queue.map(({ name, path, bucket, url, presigned }) => ({ name, path, bucket, url, presigned })),
        index: p.index,
        mode: p.mode,
        currentTime: audio ? audio.currentTime : p.currentTime,
        savedAt: Date.now(),
      })
    )
  } catch {}
}

export function restorePlayer() {
  let saved
  try {
    saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null')
  } catch {}
  if (!saved || !saved.queue?.length || saved.index < 0) return
  // 预签名链接 7 天有效，超过 6 天直接丢弃 url 让 error→重签兜底
  ensureAudio()
  patchPlayer({
    queue: saved.queue,
    index: saved.index,
    mode: saved.mode || 'order',
    visible: true,
    restored: true,
    playing: false,
  })
  const track = saved.queue[saved.index]
  if (track) {
    loadTrack(track, false, saved.currentTime || 0)
    patchPlayer({ currentTime: saved.currentTime || 0 })
  }
}

export function fmtTimeSec(s) {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}
