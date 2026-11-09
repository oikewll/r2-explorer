import { create } from 'zustand'

let toastSeq = 0

export const useStore = create((set) => ({
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
