import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { stripArchiveExt } from '../lib/format'
import Modal from './Modal'
import { UIcon } from './icons'

// 在线解压（仅 Node/Docker 版）：把压缩包整包解到桶内指定目录，后台任务 + 轮询进度
export default function ExtractModal({ bucket, file, prefix, onClose, onDone }) {
  const toast = useStore((s) => s.toast)
  const [target, setTarget] = useState(prefix + stripArchiveExt(file.name) + '/')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState(null) // { id, status, total, done, failed, message, error, errors }
  const timer = useRef(null)

  const stopPolling = () => {
    if (timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
  }
  useEffect(() => stopPolling, [])

  // 轮询任务状态：done/failed/cancelled 时停止
  useEffect(() => {
    if (!job?.id || ['done', 'failed', 'cancelled'].includes(job.status)) return
    timer.current = setInterval(async () => {
      try {
        const s = await api('/api/extract/status?id=' + encodeURIComponent(job.id))
        setJob((p) => ({ ...p, ...s }))
        if (['done', 'failed', 'cancelled'].includes(s.status)) {
          stopPolling()
          if (s.status === 'done' && !s.failed) {
            toast(`解压完成，共 ${s.done} 个文件`)
            onDone()
            onClose()
          }
        }
      } catch {
        // 单次轮询失败忽略，下一轮再试
      }
    }, 800)
    return stopPolling
  }, [job?.id, job?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    const t = target.trim()
    if (!t.endsWith('/') || t.startsWith('/') || t.slice(0, -1).split('/').some((p) => !p || p === '.' || p === '..')) {
      setError('目标目录格式不正确')
      return
    }
    setBusy(true)
    setError('')
    try {
      const r = await api('/api/extract', {
        method: 'POST',
        body: JSON.stringify({ bucket, key: file.path, target: t }),
      })
      setJob({ id: r.id, status: 'running', total: 0, done: 0, failed: 0, errors: [] })
    } catch (e) {
      if (e.message !== 'unauthorized') setError(e.message)
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (job?.id) {
      try {
        await api('/api/extract/cancel', { method: 'POST', body: JSON.stringify({ id: job.id }) })
      } catch {}
    }
    stopPolling()
    onClose()
  }

  const running = job && job.status === 'running'
  const pct = job && job.total ? Math.round(((job.done + job.failed) / job.total) * 100) : 0

  return (
    <Modal title="在线解压" onClose={running ? cancel : onClose} width="max-w-[480px]">
      <div className="px-5 py-5">
        <div className="mb-1.5 text-[13px] text-ink2">
          压缩包：<span className="truncate font-medium text-ink">{file.name}</span>
        </div>

        {!job && (
          <>
            <div className="mt-3 mb-1.5 text-[13px] font-medium">解压到</div>
            <input
              className="input"
              placeholder="目标目录，如 photos/backup/"
              value={target}
              autoFocus
              onChange={(e) => setTarget(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && start()}
            />
            <div className="mt-1.5 text-[12px] text-ink2/70">文件将写入「{target || '目标目录'}」下，同名文件会被覆盖</div>
          </>
        )}

        {job && (
          <div className="mt-3">
            {running && (
              <>
                <div className="mb-2 flex items-center justify-between text-[13px]">
                  <span className="text-ink2">正在解压…</span>
                  <span className="tabular-nums text-ink2">
                    {job.done + job.failed}/{job.total || '?'}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: pct + '%' }} />
                </div>
              </>
            )}
            {job.status === 'done' && job.failed > 0 && (
              <div className="flex items-center gap-1.5 text-[13px] text-ink2">
                <UIcon name="check" size={15} className="text-accent" />
                解压完成，{job.done} 个成功，{job.failed} 个失败
              </div>
            )}
            {job.status === 'failed' && (
              <div className="text-[13px] text-danger">解压失败：{job.error || job.message || '未知错误'}</div>
            )}
            {job.status === 'cancelled' && <div className="text-[13px] text-ink2">任务已取消</div>}
            {(job.failed > 0 || job.errors.length > 0) && job.errors.length > 0 && (
              <div className="thin-scroll mt-2 max-h-28 overflow-auto rounded-[10px] border border-line bg-bg p-2.5 text-[12px] leading-[1.6] text-ink2">
                {job.errors.map((e, i) => (
                  <div key={i} className="break-all">
                    {e}
                  </div>
                ))}
                {job.failed > job.errors.length && <div>… 还有 {job.failed - job.errors.length} 个失败未展示</div>}
              </div>
            )}
          </div>
        )}

        <div className="mt-2 min-h-[18px] text-[13px] text-danger">{error}</div>
        <div className="flex justify-end gap-2">
          {running ? (
            <>
              <button className="btn-plain" onClick={cancel}>
                取消任务
              </button>
              <button className="btn-plain" disabled>
                后台进行中
              </button>
            </>
          ) : job && ['done', 'failed', 'cancelled'].includes(job.status) ? (
            <button
              className="btn-primary"
              onClick={() => {
                if (job.status === 'done') onDone()
                onClose()
              }}
            >
              关闭
            </button>
          ) : (
            <>
              <button className="btn-plain" onClick={onClose} disabled={busy}>
                取消
              </button>
              <button className="btn-primary" onClick={start} disabled={busy || !target.trim()}>
                {busy ? '启动中…' : '开始解压'}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
