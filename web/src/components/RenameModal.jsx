import { useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import Modal from './Modal'

// 重命名：文件走 /api/move，文件夹走 /api/move-tree
export default function RenameModal({ bucket, item, prefix, onClose, onDone }) {
  const toast = useStore((s) => s.toast)
  const [name, setName] = useState(item.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    const newName = name.trim()
    if (!newName || newName === item.name) return onClose()
    if (newName.includes('/')) {
      setError('名称不能包含 /')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (item.isDir) {
        await api('/api/move-tree', {
          method: 'POST',
          body: JSON.stringify({ bucket, items: [{ from: item.path, to: prefix + newName + '/' }] }),
        })
      } else {
        await api('/api/move', {
          method: 'POST',
          body: JSON.stringify({ bucket, items: [{ from: item.path, to: prefix + newName }] }),
        })
      }
      toast('已重命名')
      onDone()
    } catch (e) {
      if (e.message !== 'unauthorized') setError(e.message)
      setBusy(false)
    }
  }

  return (
    <Modal title={`重命名${item.isDir ? '文件夹' : '文件'}`} onClose={onClose} width="max-w-[400px]">
      <div className="px-5 py-5">
        <input
          className="input"
          value={name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <div className="mt-2 min-h-[18px] text-[13px] text-danger">{error}</div>
        <div className="flex justify-end gap-2">
          <button className="btn-plain" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
