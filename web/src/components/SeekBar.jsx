import { useRef } from 'react'
import { seek, seekStart, seekPreview } from '../lib/player'

// 可拖拽进度条：Pointer Events 统一鼠标/触摸，capture 保证拖出区域仍跟手
// align="bottom" 时进度条贴容器底边（迷你条用法），默认垂直居中
// 轨道 = currentColor 15%，已播放 = currentColor 实色，圆点常显
export default function SeekBar({ duration, currentTime, className = '', barClass = 'h-1.5', align = 'center' }) {
  const barRef = useRef(null)

  const ratioOf = (clientX) => {
    const rect = barRef.current.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  const dragging = (e) => e.currentTarget.hasPointerCapture?.(e.pointerId)
  const pad = align === 'bottom' ? 'pt-2.5 pb-1' : 'py-2.5'
  const pct = duration ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) + '%' : '0%'
  const thumbSize = align === 'bottom' ? 'h-2.5 w-2.5' : 'h-3 w-3'

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
        {/* 轨道与填充分层：轨道的淡色不能通过父级 opacity 实现，否则会连填充一起淡化 */}
        <div className={`relative overflow-hidden rounded-full ${barClass}`}>
          <div className="absolute inset-0 bg-current opacity-15" />
          <div className="absolute inset-y-0 left-0 rounded-full bg-current" style={{ width: pct }} />
        </div>
        {/* 拖拽圆点：常显，hover 略放大 */}
        <div
          className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current shadow-[0_1px_4px_rgba(0,0,0,.35)] transition-transform duration-150 group-hover/bar:scale-125 ${thumbSize}`}
          style={{ left: pct }}
        />
      </div>
    </div>
  )
}
