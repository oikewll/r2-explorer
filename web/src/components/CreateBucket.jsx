import { useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import Modal from './Modal'

export default function CreateBucket({ onClose, onCreated }) {
  const toast = useStore((s) => s.toast)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const valid = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await api('/api/buckets', { method: 'POST', body: JSON.stringify({ name }) })
      toast('已创建存储桶：' + name)
      onCreated(name)
      onClose()
    } catch (e) {
      if (e.message !== 'unauthorized') setError(e.message)
      setBusy(false)
    }
  }

  return (
    <Modal title="新建存储桶" onClose={onClose} width="max-w-[400px]">
      <div className="px-5 py-5">
        <input
          className="input font-mono text-[13px]"
          placeholder="my-new-bucket"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && valid && submit()}
        />
        <div className="mt-2 text-[12px] leading-relaxed text-ink2">
          仅小写字母、数字和连字符（-），3–63 个字符，字母或数字开头结尾
        </div>
        <div className="mt-1.5 min-h-[18px] text-[13px] text-danger">{error}</div>
        <div className="flex justify-end gap-2">
          <button className="btn-plain" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy || !valid}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
