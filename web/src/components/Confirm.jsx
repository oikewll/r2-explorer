import { useState } from 'react'
import Modal from './Modal'

export default function Confirm({ title, message, okText = '删除', onOk, onClose }) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} onClose={onClose} width="max-w-[380px]">
      <div className="px-5 py-4 text-[14px] leading-relaxed text-ink whitespace-pre-line">{message}</div>
      <div className="flex justify-end gap-2 px-5 pb-5">
        <button className="btn-plain" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="btn-danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onOk()
              onClose()
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? '处理中…' : okText}
        </button>
      </div>
    </Modal>
  )
}
