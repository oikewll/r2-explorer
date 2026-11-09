import { useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { FIcon } from './icons'

export default function Login({ onOk }) {
  const [pwd, setPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const toast = useStore((s) => s.toast)

  const submit = async (e) => {
    e.preventDefault()
    if (!pwd || busy) return
    setBusy(true)
    setErr('')
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password: pwd }) })
      onOk()
    } catch (e2) {
      if (e2.message !== 'unauthorized') setErr(e2.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <form onSubmit={submit} className="card pop-in w-full max-w-[360px] p-10 text-center">
        <div className="flex justify-center">
          <FIcon type="bucket" size={56} />
        </div>
        <h1 className="mt-3 text-[20px] font-semibold">R2 Explorer</h1>
        <p className="mb-6 mt-1 text-[13px] text-ink2">基于 Cloudflare R2 的轻量文件管理器</p>
        <input
          type="password"
          className="input text-center"
          placeholder="登录密码"
          value={pwd}
          autoFocus
          onChange={(e) => setPwd(e.target.value)}
        />
        <div className="mt-2 min-h-[18px] text-[13px] text-danger">{err}</div>
        <button type="submit" className="btn-primary mt-1 w-full py-2.5" disabled={busy || !pwd}>
          {busy ? '登录中…' : '登 录'}
        </button>
      </form>
    </div>
  )
}
