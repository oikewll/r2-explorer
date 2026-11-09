import { useEffect } from 'react'
import { UIcon } from './icons'

// 通用弹窗：桌面居中卡片，移动端底部弹出
export default function Modal({ title, onClose, children, width = 'max-w-md', footer = null }) {
  useEffect(() => {
    const fn = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [onClose])

  return (
    <div
      className="modal-overlay fade-in items-end sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.()
      }}
    >
      <div className={`modal-panel pop-in max-sm:rounded-b-none max-sm:rounded-t-2xl ${width}`}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="icon-btn -mr-1.5" onClick={onClose} title="关闭">
            <UIcon name="close" size={17} />
          </button>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="shrink-0 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  )
}
