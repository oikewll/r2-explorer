import { useStore } from '../lib/store'
import { cancelUpload } from '../lib/uploader'
import { fmtSize } from '../lib/format'
import { UIcon } from './icons'

function TaskRow({ task }) {
  const uploading = task.status === 'uploading'
  const failed = task.status === 'fail'
  const done = task.status === 'done'
  const cancelled = task.status === 'cancelled'
  return (
    <div className={`rounded-xl px-3 py-2.5 ${failed ? 'bg-danger-soft' : cancelled ? 'bg-ink/[0.035]' : 'bg-bg'}`}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {task.name}
          {task.partTag && <span className="ml-1.5 rounded-md bg-accent-soft px-1.5 py-px text-[11px] text-accent">{task.partTag}</span>}
        </div>
        {uploading ? (
          <button
            className="shrink-0 text-[12px] text-ink2 hover:text-danger"
            onClick={() => cancelUpload(task)}
          >
            取消
          </button>
        ) : (
          <span
            className={`shrink-0 text-[12px] font-medium ${
              done ? 'text-emerald-600' : failed ? 'text-danger' : 'text-ink2'
            }`}
            title={task.error || ''}
          >
            {done ? '完成' : failed ? '失败' : cancelled ? '已取消' : '等待中'}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/[0.07]">
          <div
            className={`h-full rounded-full transition-[width] duration-200 ${
              failed ? 'bg-danger' : done ? 'bg-emerald-500' : 'bg-accent'
            }`}
            style={{ width: (done || failed ? 100 : task.pct) + '%' }}
          />
        </div>
        <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-ink2">
          {done ? '100%' : task.pct + '%'}
        </span>
        <span className="w-16 shrink-0 text-right text-[11px] text-ink2/70">{fmtSize(task.size)}</span>
      </div>
      {failed && task.error && (
        <div className="mt-1 truncate text-[12px] text-danger/80" title={task.error}>
          {task.error}
        </div>
      )}
    </div>
  )
}

export default function UploadPanel() {
  const uploads = useStore((s) => s.uploads)
  const open = useStore((s) => s.uploadPanelOpen)
  const setOpen = useStore((s) => s.setUploadPanelOpen)
  const clearFinished = useStore((s) => s.clearFinishedUploads)
  const playerVisible = useStore((s) => s.player.visible)

  if (!uploads.length || !open) return null
  const done = uploads.filter((t) => t.status === 'done').length
  const fail = uploads.filter((t) => t.status === 'fail').length
  const allDone = done + fail + uploads.filter((t) => t.status === 'cancelled').length === uploads.length

  return (
    <div
      className="fixed right-4 z-40 w-[min(340px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-line bg-card shadow-[0_12px_40px_rgba(16,24,40,.18)] max-sm:right-3"
      style={{ bottom: playerVisible ? 92 : 16 }}
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="text-[13px] font-semibold">
          {allDone ? `上传完成：${done} 成功${fail ? `，${fail} 失败` : ''}` : `上传中… ${done + fail}/${uploads.length}`}
        </div>
        <div className="flex items-center gap-1">
          {allDone && (
            <button className="text-[12px] text-ink2 hover:text-ink" onClick={clearFinished}>
              清空
            </button>
          )}
          <button className="icon-btn h-7 w-7" onClick={() => setOpen(false)} title="收起">
            <UIcon name="close" size={14} />
          </button>
        </div>
      </div>
      <div className="thin-scroll max-h-[260px] space-y-2 overflow-y-auto p-3">
        {uploads.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </div>
    </div>
  )
}
