import { useStore } from '../lib/store'

export default function Toasts() {
  const toasts = useStore((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast-item max-w-[80vw] truncate rounded-full px-4 py-2 text-[13px] font-medium text-white shadow-lg ${
            t.kind === 'error' ? 'bg-danger' : 'bg-ink'
          }`}
        >
          {t.msg}
        </div>
      ))}
    </div>
  )
}
