import { useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import Modal from './Modal'

// 新建文件夹：支持 a/b 多级，后端写入 key 以 / 结尾的零字节对象
export default function CreateFolderModal({ bucket, prefix, onClose, onDone }) {
  const toast = useStore((s) => s.toast)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    const n = name.trim()
    if (!n) return onClose()
    if (n.startsWith('/') || n.endsWith('/') || n.split('/').some((p) => !p)) {
      setError('名称格式不正确')
      return
    }
    if (n.split('/').some((p) => p === '.' || p === '..')) {
      setError('名称不能包含 . 或 ..')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(
        '/api/mkdir?bucket=' + encodeURIComponent(bucket) + '&key=' + encodeURIComponent(prefix + n + '/'),
        { method: 'POST' }
      )
      toast('文件夹已创建')
      onDone()
    } catch (e) {
      if (e.message !== 'unauthorized') setError(e.message)
      setBusy(false)
    }
  }

  return (
    <Modal title="新建文件夹" onClose={onClose} width="max-w-[400px]">
      <div className="px-5 py-5">
        <input
          className="input"
          placeholder="文件夹名称，用 / 可一次建多级"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <div className="mt-2 min-h-[18px] text-[13px] text-danger">{error}</div>
        <div className="flex justify-end gap-2">
          <button className="btn-plain" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
