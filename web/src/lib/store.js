import { create } from 'zustand'

let toastSeq = 0

// 界面语言：优先用已保存的偏好，否则跟随浏览器语言，兜底简体中文
function initialLang() {
  try {
    const saved = localStorage.getItem('r2x-lang')
    if (saved) return saved
    const n = (navigator.language || '').toLowerCase()
    if (n.startsWith('zh-tw') || n.startsWith('zh-hk') || n.startsWith('zh-hant')) return 'zh-TW'
    if (n.startsWith('en')) return 'en'
    if (n.startsWith('ja')) return 'ja'
    if (n.startsWith('ko')) return 'ko'
  } catch {}
  return 'zh-CN'
}

export const useStore = create((set) => ({
  // 语言（i18n）
  lang: initialLang(),
  setLang: (v) => set({ lang: v }),

  // 登录态
  authed: false,
  setAuthed: (v) => set({ authed: v }),

  // 账号
  accounts: [],
  activeId: '',
  setAccounts: (accounts, activeId) => set({ accounts, activeId }),

  // 桶
  buckets: [],
  setBuckets: (buckets) => set({ buckets }),

  // 通知
  toasts: [],
  toast(msg, kind = 'info') {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, msg, kind }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 2600)
  },

  // 弹窗
  accountsOpen: false,
  setAccountsOpen: (v) => set({ accountsOpen: v }),
  createBucketOpen: false,
  setCreateBucketOpen: (v) => set({ createBucketOpen: v }),

  // 上传
  uploads: [],
  uploadPanelOpen: false,
  setUploadPanelOpen: (v) => set({ uploadPanelOpen: v }),
  pushUploads: (tasks) => set((s) => ({ uploads: [...s.uploads, ...tasks] })),
  patchUpload: (id, patch) =>
    set((s) => ({ uploads: s.uploads.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  clearFinishedUploads: () =>
    set((s) => ({ uploads: s.uploads.filter((t) => !['done', 'fail', 'cancelled'].includes(t.status)) })),
  uploadsVersion: 0, // 手动重试等独立上传任务完成时 +1（Explorer 据此刷新目录）
  bumpUploadsVersion: () => set((s) => ({ uploadsVersion: s.uploadsVersion + 1 })),

  // 离线下载（服务端任务，轮询同步）
  downloads: [],
  setDownloads: (list) => set({ downloads: list }),
  downloadModalOpen: false,
  setDownloadModalOpen: (v) => set({ downloadModalOpen: v }),
  downloadTarget: null, // Explorer 打开弹窗时记录 { bucket, prefix }
  setDownloadTarget: (t) => set({ downloadTarget: t }),
  downloadsVersion: 0, // 每当有任务进入终态时 +1（Explorer 据此刷新目录）
  bumpDownloadsVersion: () => set((s) => ({ downloadsVersion: s.downloadsVersion + 1 })),

  // 音乐播放器（AudioEngine 单例的状态；audio 元素在 lib/player.js 里管理）
  player: {
    queue: [], // [{ name, path, bucket, url, presigned }]
    index: -1,
    playing: false,
    mode: 'order', // order 顺序循环 | one 单曲循环 | shuffle 随机
    duration: 0,
    currentTime: 0,
    visible: false,
    fullscreen: false, // 全屏播放页（歌词/队列）
    restored: true, // 恢复的会话未开始播放（等用户手势）
  },
  patchPlayer: (patch) => set((s) => ({ player: { ...s.player, ...patch } })),
}))
