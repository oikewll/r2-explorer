import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { UIcon } from './icons'

const LONG_PRESS_MS = 480

/*
 * 右键菜单（PC 右键 / 移动端长按触发）。
 * menu: { x, y, items }，items 元素：
 *   - { icon, label, danger?, onClick }
 *   - { sep: true } 分隔线
 */

// 行/卡片上展开的事件 props：桌面右键 + 移动端单指长按（双指/滚动不触发）
export function useCtxTrigger(onMenu) {
  const timer = useRef(null)
  const start = useRef(null)
  const suppressUntil = useRef(0)

  const clear = () => {
    clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clear, [])

  // 长按打开菜单后，浏览器会为这次触摸补发一个 click（落到菜单上会误触菜单项），全局拦掉这一个
  const killNextClick = () => {
    const kill = (e) => {
      e.stopPropagation()
      e.preventDefault()
      window.removeEventListener('click', kill, true)
    }
    window.addEventListener('click', kill, true)
    setTimeout(() => window.removeEventListener('click', kill, true), 450)
  }

  return {
    onContextMenu: (e) => {
      clear()
      e.preventDefault()
      e.stopPropagation()
      // Android 长按会补发原生 contextmenu，此时菜单已由长按逻辑打开，跳过避免重放动画
      if (Date.now() < suppressUntil.current) return
      onMenu(e.clientX, e.clientY)
    },
    onTouchStart: (e) => {
      // 双指（捏合缩放等）不触发菜单
      if (e.touches.length !== 1) {
        clear()
        return
      }
      const t = e.touches[0]
      start.current = { x: t.clientX, y: t.clientY }
      clear()
      timer.current = setTimeout(() => {
        timer.current = null
        suppressUntil.current = Date.now() + 500
        if (navigator.vibrate) navigator.vibrate(15)
        killNextClick()
        onMenu(start.current.x, start.current.y)
      }, LONG_PRESS_MS)
    },
    onTouchMove: (e) => {
      if (!timer.current || !start.current) return
      const t = e.touches[0]
      // 移动超过 10px 视为滚动，取消长按
      if (Math.abs(t.clientX - start.current.x) > 10 || Math.abs(t.clientY - start.current.y) > 10) clear()
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
    onClickCapture: (e) => {
      if (Date.now() < suppressUntil.current) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
  }
}

export default function ContextMenu({ menu, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  // 打开时按实际尺寸夹到视口内（贴边翻转）
  useLayoutEffect(() => {
    if (!menu) {
      setPos(null)
      return
    }
    const el = ref.current
    const w = el?.offsetWidth || 180
    const h = el?.offsetHeight || 200
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - h - 8)),
    })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onClose()
      }
    }
    const close = () => onClose()
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, true)
    document.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  if (!menu) return null

  return (
    <div
      ref={ref}
      className="pop-in fixed z-[70] min-w-[168px] overflow-hidden rounded-xl border border-line bg-card py-1 shadow-[0_12px_40px_rgba(0,0,0,.18)]"
      style={pos ? { left: pos.x, top: pos.y } : { left: menu.x, top: menu.y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((it, i) =>
        it.sep ? (
          <div key={i} className="my-1 h-px bg-line/70" />
        ) : (
          <button
            key={i}
            className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-[13.5px] transition-colors ${
              it.danger ? 'text-danger hover:bg-danger-soft' : 'text-ink hover:bg-ink/[0.05]'
            }`}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            <UIcon name={it.icon} size={15} className="shrink-0 opacity-80" />
            <span className="min-w-0 truncate">{it.label}</span>
          </button>
        )
      )}
    </div>
  )
}
