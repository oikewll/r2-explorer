import { useRef } from 'react'
import { seek, seekStart, seekPreview } from '../lib/player'

// 可拖拽进度条：Pointer Events 统一鼠标/触摸，capture 保证拖出区域仍跟手
// align="bottom" 时进度条贴容器底边（迷你条用法），默认垂直居中
export default function SeekBar({ duration, currentTime, className = '', barClass = 'h-1.5', align = 'center' }) {
  const barRef = useRef(null)

  const ratioOf = (clientX) => {
    const rect = barRef.current.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  const dragging = (e) => e.currentTarget.hasPointerCapture?.(e.pointerId)
  const pad = align === 'bottom' ? 'pt-2.5 pb-0' : 'py-2.5'
  const pct = duration ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) + '%' : '0%'

  return (
    <div
      ref={barRef}
      className={`group/bar relative cursor-pointer touch-none select-none ${pad} ${className}`}
      onPointerDown={(e) => {
        if (!duration) return
        e.currentTarget.setPointerCapture(e.pointerId)
        seekStart()
        seekPreview(ratioOf(e.clientX) * duration)
      }}
      onPointerMove={(e) => {
        if (!duration || !dragging(e)) return
        seekPreview(ratioOf(e.clientX) * duration)
      }}
      onPointerUp={(e) => {
        if (!duration) return
        seek(ratioOf(e.clientX) * duration)
      }}
    >
      <div className="relative">
        <div
          className={`overflow-hidden rounded-full bg-current opacity-15 transition-all duration-150 group-hover/bar:opacity-25 ${barClass}`}
        >
          <div className="h-full rounded-full bg-current" style={{ width: pct }} />
        </div>
        {/* 拖拽圆点：hover 进度条区域时显示 */}
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current opacity-0 shadow-[0_1px_4px_rgba(0,0,0,.3)] transition-opacity group-hover/bar:opacity-100"
          style={{ left: pct }}
        />
      </div>
    </div>
  )
}
