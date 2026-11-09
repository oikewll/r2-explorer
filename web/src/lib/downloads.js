import { api } from './api'
import { useStore } from './store'

// 服务端离线下载任务的轮询同步：有活跃任务 1.2s，空闲降到 6s（自托管本地服务，开销可忽略）
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

function loop() {
  timer = null
  fetchOnce()
    .then((active) => {
      timer = setTimeout(loop, active ? 1200 : 6000)
    })
    .catch(() => {
      timer = setTimeout(loop, 8000)
    })
}

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
