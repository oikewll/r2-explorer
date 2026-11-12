import { api } from './api'
import { useStore } from './store'

// 服务端离线下载任务轮询：Workers KV list() 有每日配额（免费版仅 1000 次/天），
// 有活跃任务且页面可见 1.2s；活跃但页面在后台 10s；空闲 30s；
// 页面隐藏且无活跃任务时暂停轮询，回到前台立即恢复
const ACTIVE_VISIBLE = 1200
const ACTIVE_HIDDEN = 10000
const IDLE_MS = 30000
const ERROR_MS = 30000

let timer = null
let running = false

async function fetchOnce() {
  const { tasks } = await api('/api/download/tasks')
  const store = useStore.getState()
  const prev = store.downloads
  store.setDownloads(tasks)
  const prevStatus = new Map(prev.map((t) => [t.id, t.status]))
  for (const t of tasks) {
    const before = prevStatus.get(t.id)
    if (!before || before === t.status) continue
    if (t.status === 'completed') {
      store.toast(`下载完成：${t.name}`)
      store.bumpDownloadsVersion()
    } else if (t.status === 'failed') {
      store.bumpDownloadsVersion()
    }
  }
  return tasks.some((t) => t.status === 'queued' || t.status === 'running')
}

function schedule(active) {
  if (!running) return
  // 页面隐藏且无活跃任务：暂停轮询，visibilitychange 时恢复
  if (document.hidden && !active) return
  const ms = active ? (document.hidden ? ACTIVE_HIDDEN : ACTIVE_VISIBLE) : IDLE_MS
  timer = setTimeout(loop, ms)
}

function loop() {
  timer = null
  fetchOnce()
    .then(schedule)
    .catch(() => schedule(false))
}

// 回到前台且轮询处于暂停状态时立即刷新
document.addEventListener('visibilitychange', () => {
  if (!running || document.hidden || timer) return
  loop()
})

// 登录后启动；登出时停止
export function startDownloadPolling() {
  if (running) return
  running = true
  loop()
}

export function stopDownloadPolling() {
  running = false
  if (timer) clearTimeout(timer)
  timer = null
  useStore.getState().setDownloads([])
}

// 手动立即刷新（创建任务/重试/删除后调用，避免等下一轮轮询）
export function refreshDownloads() {
  fetchOnce().catch(() => {})
}
