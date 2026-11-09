import { useRef } from 'react'
import { seek, seekStart, seekPreview } from '../lib/player'

// 可拖拽进度条：Pointer Events 统一鼠标/触摸，capture 保证拖出区域仍跟手
export default function SeekBar({ duration, currentTime, className = '', barClass = 'h-1.5' }) {
  const barRef = useRef(null)

  const ratioOf = (clientX) => {
    const rect = barRef.current.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  const dragging = (e) => e.currentTarget.hasPointerCapture?.(e.pointerId)

  return (
    <div
      ref={barRef}
      className={`group/bar relative cursor-pointer touch-none select-none py-2.5 ${className}`}
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
      <div className={`overflow-hidden rounded-full bg-current opacity-20 ${barClass}`}>
        <div
          className="h-full rounded-full bg-current"
          style={{ width: duration ? (currentTime / duration) * 100 + '%' : '0%' }}
        />
      </div>
      <div
        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current opacity-0 shadow transition-opacity group-hover/bar:opacity-100"
        style={{ left: duration ? (currentTime / duration) * 100 + '%' : '0%' }}
      />
    </div>
  )
}
