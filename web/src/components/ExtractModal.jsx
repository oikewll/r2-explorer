import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { capabilities } from '../lib/video'
import { useStore } from '../lib/store'
import { stripArchiveExt } from '../lib/format'
import Modal from './Modal'
import { UIcon } from './icons'

// 在线解压弹窗，两种模式按服务端能力自动选择：
// - job（Node/Docker 版，caps.extract）：POST /api/extract 后台任务 + 轮询进度，页面可关
// - batch（Workers 版，caps.extractBatch）：前端驱动分批解压，zip 专用，浏览器需保持打开
const BATCH_SIZE = 10 // 每批条目数（服务端上限 12，留余量）

export default function ExtractModal({ bucket, file, prefix, onClose, onDone }) {
  const toast = useStore((s) => s.toast)
  const [mode, setMode] = useState(null) // 'job' | 'batch' | 'none'
  const [target, setTarget] = useState(prefix + stripArchiveExt(file.name) + '/')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState(null)
  const timer = useRef(null)
  const cancelRef = useRef(false)

  useEffect(() => {
    capabilities()
      .then((caps) => setMode(caps?.extract ? 'job' : caps?.extractBatch ? 'batch' : 'none'))
      .catch(() => setMode('none'))
  }, [])

  const stopPolling = () => {
    if (timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
  }
  useEffect(() => stopPolling, [])

  // job 模式：轮询任务状态，done/failed/cancelled 时停止
  useEffect(() => {
    if (mode !== 'job' || !job?.id || ['done', 'failed', 'cancelled'].includes(job.status)) return
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
  }, [mode, job?.id, job?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // batch 模式：先列条目，再分批解压，全部由前端驱动（中途关页面就断）
  const startBatch = async (t) => {
    setJob({ mode: 'batch', status: 'listing', total: 0, done: 0, failed: 0, errors: [] })
    let entries
    try {
      const data = await api('/api/zip?bucket=' + encodeURIComponent(bucket) + '&key=' + encodeURIComponent(file.path))
      entries = (data.entries || []).map((e) => ({
        name: e.name,
        off: e.offset,
        csize: e.compSize,
        usize: e.uncompSize,
        method: e.method,
      }))
      if (!entries.length) {
        setJob({ mode: 'batch', status: 'failed', error: '压缩包内没有可解压的文件' })
        return
      }
    } catch (e) {
      setJob({ mode: 'batch', status: 'failed', error: e.message })
      return
    }
    setJob({ mode: 'batch', status: 'running', total: entries.length, done: 0, failed: 0, errors: [] })
    const errors = []
    let done = 0
    let failed = 0
    let netFails = 0
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      if (cancelRef.current) {
        setJob({ mode: 'batch', status: 'cancelled', total: entries.length, done, failed, errors: errors.slice(0, 50) })
        return
      }
      let r
      try {
        r = await api('/api/extract-batch', {
          method: 'POST',
          body: JSON.stringify({ bucket, key: file.path, target: t, entries: entries.slice(i, i + BATCH_SIZE) }),
        })
        netFails = 0
      } catch (e) {
        // 网络类失败：连续两批失败则终止，否则跳过该批继续（避免 unauthorized 后无限空转）
        netFails++
        if (netFails >= 2 || e.message === 'unauthorized') {
          setJob({
            mode: 'batch',
            status: 'failed',
            error: `请求失败：${e.message}`,
            total: entries.length,
            done,
            failed,
            errors: errors.slice(0, 50),
          })
          return
        }
        continue
      }
      done += r.done.length
      failed += r.failed.length
      for (const f of r.failed) errors.push(`${f.name}: ${f.error}`)
      setJob({ mode: 'batch', status: 'running', total: entries.length, done, failed, errors: errors.slice(0, 50) })
    }
    finish({
      mode: 'batch',
      status: failed && !done ? 'failed' : 'done',
      total: entries.length,
      done,
      failed,
      errors: errors.slice(0, 50),
      message: failed ? `${failed} 个文件解压失败，其余已完成` : '',
    })
  }

  const startJob = async (t) => {
    const r = await api('/api/extract', {
      method: 'POST',
      body: JSON.stringify({ bucket, key: file.path, target: t }),
    })
    setJob({ mode: 'job', id: r.id, status: 'running', total: 0, done: 0, failed: 0, errors: [] })
  }

  const finish = (j) => {
    if (j.status === 'done' && !j.failed) {
      toast(`解压完成，共 ${j.done} 个文件`)
      onDone()
      onClose()
      return
    }
    setJob(j)
  }

  const start = async () => {
    cancelRef.current = false // 上次会话的取消标记不带入本次（放在入口，listing 阶段的取消才能生效）
    const t = target.trim()
    if (!t.endsWith('/') || t.startsWith('/') || t.slice(0, -1).split('/').some((p) => !p || p === '.' || p === '..')) {
      setError('目标目录格式不正确')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (mode === 'batch') await startBatch(t)
      else await startJob(t)
    } catch (e) {
      if (e.message !== 'unauthorized') setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (mode === 'job' && job?.id && job?.status === 'running') {
      stopPolling()
      try {
        await api('/api/extract/cancel', { method: 'POST', body: JSON.stringify({ id: job.id }) })
      } catch {}
      setJob((p) => ({ ...p, status: 'cancelled' }))
    } else {
      // batch 模式：标记取消，循环在下一批前停下（已解压的部分保留）
      cancelRef.current = true
    }
  }

  const running = job && ['running', 'listing'].includes(job.status)
  const ended = job && ['done', 'failed', 'cancelled'].includes(job.status)
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
              onKeyDown={(e) => e.key === 'Enter' && mode !== 'none' && start()}
            />
            <div className="mt-1.5 text-[12px] text-ink2/70">
              文件将写入「{target || '目标目录'}」下，同名文件会被覆盖
              {mode === 'batch' && '；解压期间请保持页面打开'}
            </div>
          </>
        )}

        {job && (
          <div className="mt-3">
            {job.status === 'listing' && <div className="text-[13px] text-ink2">正在读取压缩包目录…</div>}
            {job.status === 'running' && (
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
                {mode === 'batch' && job.total > 0 && (
                  <div className="mt-1.5 text-[12px] text-ink2/70">解压进行中，请勿关闭页面</div>
                )}
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
            {job.status === 'cancelled' && (
              <div className="text-[13px] text-ink2">
                任务已取消{job.done > 0 && `，已解压的 ${job.done} 个文件保留`}
              </div>
            )}
            {job.failed > 0 && job.errors.length > 0 && (
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
                {mode === 'job' ? '后台进行中' : '解压进行中'}
              </button>
            </>
          ) : ended ? (
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
              <button className="btn-primary" onClick={start} disabled={busy || !target.trim() || mode === 'none'}>
                {busy ? '启动中…' : '开始解压'}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
