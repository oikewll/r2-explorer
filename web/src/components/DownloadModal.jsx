import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { refreshDownloads } from '../lib/downloads'
import { fmtSize } from '../lib/format'
import Modal from './Modal'
import { UIcon } from './icons'

const STATUS_TEXT = {
  queued: { text: '排队中', cls: 'text-ink2' },
  running: { text: '下载中', cls: 'text-accent' },
  completed: { text: '已完成', cls: 'text-emerald-600' },
  failed: { text: '失败', cls: 'text-danger' },
  cancelled: { text: '已取消', cls: 'text-ink2' },
}

function TaskRow({ t, onToast }) {
  const running = t.status === 'running'
  const failed = t.status === 'failed'
  const completed = t.status === 'completed'
  const pct = t.size > 0 ? Math.min(100, Math.round((t.downloaded / t.size) * 100)) : 0
  const st = STATUS_TEXT[t.status] || STATUS_TEXT.queued

  const act = async (fn, okMsg) => {
    try {
      await fn()
      if (okMsg) onToast(okMsg)
      refreshDownloads()
    } catch (e) {
      if (e.message !== 'unauthorized') onToast(e.message, 'error')
    }
  }

  return (
    <div className={`rounded-xl px-3 py-2.5 ${failed ? 'bg-danger-soft' : 'bg-bg'}`}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-[13px] font-medium" title={t.key}>
          {t.name}
        </div>
        {(failed || t.status === 'cancelled' || completed) && (
          <button
            className="shrink-0 text-[12px] text-ink2 hover:text-accent"
            onClick={() => act(() => api(`/api/download/tasks/${t.id}/retry`, { method: 'POST' }), '已重新加入队列')}
          >
            重试
          </button>
        )}
        <button
          className="shrink-0 text-[12px] text-ink2 hover:text-danger"
          onClick={() => act(() => api(`/api/download/tasks/${t.id}`, { method: 'DELETE' }))}
        >
          {running ? '取消' : '删除'}
        </button>
        <span className={`shrink-0 text-[12px] font-medium ${st.cls}`} title={t.error || ''}>
          {st.text}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/[0.07]">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${
              failed ? 'bg-danger' : completed ? 'bg-emerald-500' : 'bg-accent'
            }`}
            style={{ width: (completed ? 100 : pct) + '%' }}
          />
        </div>
        <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-ink2">
          {completed ? '100%' : t.size > 0 ? pct + '%' : '—'}
        </span>
        <span className="w-28 shrink-0 text-right text-[11px] tabular-nums text-ink2/70">
          {running
            ? `${fmtSize(t.downloaded)} · ${fmtSize(t.speed)}/s`
            : completed
              ? fmtSize(t.size >= 0 ? t.size : t.downloaded)
              : t.downloaded > 0
                ? fmtSize(t.downloaded)
                : ''}
        </span>
      </div>
      {failed && t.error && (
        <div className="mt-1 truncate text-[12px] text-danger/80" title={t.error}>
          {t.error}
        </div>
      )}
    </div>
  )
}

export default function DownloadModal({ onClose }) {
  const toast = useStore((s) => s.toast)
  const target = useStore((s) => s.downloadTarget)
  const downloads = useStore((s) => s.downloads)

  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [probe, setProbe] = useState(null) // { size, contentType } | null
  const [probeErr, setProbeErr] = useState('')
  const [probing, setProbing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const nameRef = useRef(null)

  // URL 变化后自动探测直链（防抖），成功则预填文件名与大小
  useEffect(() => {
    setProbe(null)
    setProbeErr('')
    const u = url.trim()
    if (!u || !/^https?:\/\//i.test(u)) return
    const timer = setTimeout(async () => {
      setProbing(true)
      try {
        const info = await api('/api/download/resolve', { method: 'POST', body: JSON.stringify({ url: u }) })
        setProbe(info)
        if (!nameTouched && info.name) {
          setName(info.name)
        }
        setProbeErr('')
      } catch (e) {
        if (e.message !== 'unauthorized') setProbeErr(e.message)
      } finally {
        setProbing(false)
      }
    }, 550)
    return () => clearTimeout(timer)
  }, [url])

  const submit = async () => {
    const u = url.trim()
    if (!u) return toast('请粘贴下载链接', 'error')
    if (!/^https?:\/\//i.test(u)) return toast('仅支持 http/https 直链', 'error')
    setSubmitting(true)
    try {
      await api('/api/download/tasks', {
        method: 'POST',
        body: JSON.stringify({ url: u, bucket: target.bucket, prefix: target.prefix, name: name.trim() }),
      })
      setUrl('')
      setName('')
      setNameTouched(false)
      setProbe(null)
      setProbeErr('')
      toast('任务已创建')
      refreshDownloads()
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const clearFinished = async () => {
    try {
      const { removed } = await api('/api/download/clear', { method: 'POST' })
      if (removed) toast(`已清理 ${removed} 个任务`)
      refreshDownloads()
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message, 'error')
    }
  }

  const active = downloads.filter((t) => t.status === 'queued' || t.status === 'running').length
  const settled = downloads.length - active

  return (
    <Modal title="离线下载" onClose={onClose} width="max-w-[540px]">
      <div className="space-y-3.5 px-5 py-4">
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink2">下载链接</div>
          <input
            className="input"
            placeholder="粘贴文件直链（http/https）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            autoFocus
          />
          {probing && <div className="mt-1.5 text-[12px] text-ink2/70">正在探测链接…</div>}
          {!probing && probe && (
            <div className="mt-1.5 text-[12px] text-emerald-600">
              探测成功：{probe.size > 0 ? fmtSize(probe.size) : '大小未知'}
              {probe.contentType ? ` · ${probe.contentType}` : ''}
              {!probe.name && ' · 无法识别文件名，请手动填写'}
            </div>
          )}
          {!probing && probeErr && <div className="mt-1.5 text-[12px] text-danger/85">{probeErr}（仍可尝试创建任务）</div>}
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline gap-1 text-[13px] text-ink2">
            <span className="font-medium">保存到</span>
            <span className="truncate" title={`${target.bucket}/${target.prefix}`}>
              {target.bucket}/{target.prefix}
            </span>
          </div>
          <input
            ref={nameRef}
            className="input"
            placeholder="文件名（留空自动从链接识别）"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setNameTouched(true)
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>

        <button className="btn-primary w-full" disabled={submitting || !url.trim()} onClick={submit}>
          <UIcon name="download" size={15} />
          开始下载
        </button>

        <div className="flex items-center justify-between pt-1">
          <div className="text-[13px] font-semibold">
            任务列表{active > 0 && <span className="ml-1.5 text-[12px] font-normal text-accent">{active} 个进行中</span>}
          </div>
          {settled > 0 && (
            <button className="text-[12px] text-ink2 hover:text-ink" onClick={clearFinished}>
              清理已完成
            </button>
          )}
        </div>

        {downloads.length === 0 ? (
          <div className="rounded-xl bg-bg px-4 py-8 text-center text-[13px] text-ink2/70">
            暂无任务。粘贴链接后服务器会在后台下载并转存到你的 R2 桶
          </div>
        ) : (
          <div className="thin-scroll max-h-[300px] space-y-2 overflow-y-auto pr-0.5">
            {downloads.map((t) => (
              <TaskRow key={t.id} t={t} onToast={toast} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
