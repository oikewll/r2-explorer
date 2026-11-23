import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { loadAccountsAndBuckets } from '../lib/loader'
import { useStore } from '../lib/store'
import { navigate } from '../lib/hash'
import Modal from './Modal'
import Confirm from './Confirm'
import { UIcon } from './icons'

const EMPTY_FORM = { id: '', name: '', accountId: '', accessKeyId: '', secretAccessKey: '', apiToken: '', cdnMap: '' }

export default function Accounts({ onClose }) {
  const toast = useStore((s) => s.toast)
  const accounts = useStore((s) => s.accounts)
  const activeId = useStore((s) => s.activeId)
  const [form, setForm] = useState(null) // null = 列表视图
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDel, setConfirmDel] = useState(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [pendingImport, setPendingImport] = useState(null) // { data, count }
  const fileRef = useRef(null)

  const exportAccounts = async () => {
    if (!accounts.length) {
      toast('没有可导出的账号', 'error')
      return
    }
    try {
      const res = await fetch('/api/accounts/export')
      if (res.status === 401) {
        toast('登录已过期，请重新登录', 'error')
        return
      }
      if (!res.ok) {
        let msg = `导出失败 (${res.status})`
        try {
          const j = await res.json()
          if (j?.error) msg = j.error
        } catch {}
        toast(msg, 'error')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'r2-explorer-accounts-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.json'
      a.click()
      URL.revokeObjectURL(url)
      toast('已导出 ' + accounts.length + ' 个账号（含内置账号与完整凭证，请妥善保管）')
    } catch (e) {
      toast('导出失败：' + e.message, 'error')
    }
  }

  const onImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file) return
    let data
    try {
      data = JSON.parse(await file.text())
    } catch {
      toast('文件不是合法的 JSON', 'error')
      return
    }
    const list = Array.isArray(data?.accounts) ? data.accounts : Array.isArray(data) ? data : null
    if (!list || !list.length) {
      toast('备份文件格式不正确（缺少 accounts 数组）', 'error')
      return
    }
    setPendingImport({ data, count: list.length })
  }

  const doImport = async () => {
    const { data } = pendingImport
    setPendingImport(null)
    setBusy(true)
    try {
      const r = await api('/api/accounts/import', { method: 'POST', body: JSON.stringify(data) })
      const parts = ['导入完成：新增 ' + r.added + ' 个，跳过 ' + r.skipped + ' 个（已绑定）']
      if (r.failed?.length) {
        parts.push('失败 ' + r.failed.length + ' 个：' + r.failed.map((f) => `${f.name}（${f.error}）`).join('、'))
        toast(parts.join('；'), 'error')
      } else {
        toast(parts[0])
      }
      await loadAccountsAndBuckets()
    } catch (e) {
      if (e.message !== 'unauthorized') toast('导入失败：' + e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const resetForm = () => {
    setForm(null)
    setError('')
  }

  const editAccount = (a) => {
    setForm({
      id: a.id,
      name: a.name,
      accountId: a.accountId,
      accessKeyId: '',
      secretAccessKey: '',
      apiToken: '',
      cdnMap: a.cdnMap && Object.keys(a.cdnMap).length ? JSON.stringify(a.cdnMap) : '',
    })
    setError('')
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const payload = {
        name: form.name,
        accountId: form.accountId,
        accessKeyId: form.accessKeyId,
        secretAccessKey: form.secretAccessKey,
        apiToken: form.apiToken,
        cdnMap: form.cdnMap,
      }
      if (form.id) {
        await api('/api/accounts/' + encodeURIComponent(form.id), { method: 'PUT', body: JSON.stringify(payload) })
        toast('已保存修改')
      } else {
        await api('/api/accounts', { method: 'POST', body: JSON.stringify(payload) })
        toast('账号绑定成功')
      }
      resetForm()
      await loadAccountsAndBuckets()
    } catch (e) {
      if (e.message !== 'unauthorized') setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const activate = async (a) => {
    try {
      await api(`/api/accounts/${encodeURIComponent(a.id)}/activate`, { method: 'POST' })
      await loadAccountsAndBuckets()
      toast('已切换到「' + a.name + '」')
      navigate('', '')
    } catch (e) {
      if (e.message !== 'unauthorized') toast('切换失败：' + e.message, 'error')
    }
  }

  const remove = async (a) => {
    try {
      await api('/api/accounts/' + encodeURIComponent(a.id), { method: 'DELETE' })
      toast('已解绑：' + a.name)
      await loadAccountsAndBuckets()
      if (location.hash && location.hash !== '#/') navigate('', '')
    } catch (e) {
      if (e.message !== 'unauthorized') toast('删除失败：' + e.message, 'error')
    }
  }

  const logout = async () => {
    setLoggingOut(true)
    try {
      await api('/api/logout', { method: 'POST' })
    } catch {}
    location.reload()
  }

  return (
    <Modal
      title={form ? (form.id ? '编辑账号' : '绑定 R2 账号') : 'R2 账号管理'}
      onClose={form ? resetForm : onClose}
      width="max-w-[520px]"
    >
      {form ? (
        <div className="space-y-3.5 px-5 py-4">
          <Field label="备注名称">
            <input className="input" value={form.name} placeholder="例如：主力账号" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Account ID">
            <input
              className="input font-mono text-[13px]"
              value={form.accountId}
              disabled={!!form.id}
              placeholder="32 位十六进制"
              onChange={(e) => setForm({ ...form, accountId: e.target.value })}
            />
          </Field>
          <Field label="Access Key ID" hint={form.id ? '留空表示不修改' : ''}>
            <input
              className="input font-mono text-[13px]"
              value={form.accessKeyId}
              placeholder={form.id ? '留空则不修改' : 'R2 API Token 的 Access Key ID'}
              onChange={(e) => setForm({ ...form, accessKeyId: e.target.value })}
            />
          </Field>
          <Field label="Secret Access Key" hint={form.id ? '留空表示不修改' : ''}>
            <input
              className="input font-mono text-[13px]"
              type="password"
              value={form.secretAccessKey}
              placeholder={form.id ? '留空则不修改' : 'R2 API Token 的 Secret Access Key'}
              onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value })}
            />
          </Field>
          <Field
            label="CF API Token"
            hint="可选，仅用于识别免费/付费套餐；需「Account Subscriptions: Read」权限"
          >
            <input
              className="input font-mono text-[13px]"
              type="password"
              value={form.apiToken}
              placeholder={form.id && !form.apiToken ? '留空则不修改' : 'Cloudflare 账号级 API Token（区别于 R2 令牌）'}
              onChange={(e) => setForm({ ...form, apiToken: e.target.value })}
            />
          </Field>
          <Field label="CDN 映射" hint='JSON，如 {"my-bucket":"https://cdn.example.com"}；"*" 匹配所有桶。没映射的桶用 7 天预签名直链'>
            <textarea
              className="input min-h-[72px] resize-y font-mono text-[13px]"
              value={form.cdnMap}
              placeholder='{"*":"https://cdn.example.com"}'
              onChange={(e) => setForm({ ...form, cdnMap: e.target.value })}
            />
          </Field>
          <div className="min-h-[18px] text-[13px] text-danger">{error}</div>
          <div className="flex justify-end gap-2 pb-1">
            <button className="btn-plain" onClick={resetForm} disabled={busy}>
              取消
            </button>
            <button
              className="btn-primary"
              onClick={save}
              disabled={busy || !form.name.trim() || !form.accountId.trim()}
            >
              {busy ? '验证并保存…' : '保存（自动验证凭证）'}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-5 py-4">
          <div className="space-y-2">
            {accounts.map((a) => (
              <div
                key={a.id}
                className={`rounded-xl border px-4 py-3 transition ${
                  a.id === activeId ? 'border-accent/50 bg-accent-soft/60' : 'border-line'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{a.name}</span>
                  {a.builtin && (
                    <span className="rounded-md bg-ink/[0.06] px-1.5 py-px text-[11px] text-ink2">内置</span>
                  )}
                  {a.id === activeId && (
                    <span className="rounded-md bg-accent px-1.5 py-px text-[11px] font-medium text-white">使用中</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-ink2">
                  <span className="font-mono">{a.accountId}</span>
                  {a.keyMask && <span className="font-mono">Key {a.keyMask}</span>}
                  {a.hasApiToken && <span>API Token 已配置</span>}
                  {a.cdnMap && Object.keys(a.cdnMap).length > 0 && (
                    <span>CDN 映射 {Object.keys(a.cdnMap).length} 条</span>
                  )}
                </div>
                <div className="mt-2.5 flex justify-end gap-1.5">
                  {a.id !== activeId && (
                    <button className="btn-ghost !py-1.5 text-[13px] text-accent hover:!bg-accent-soft" onClick={() => activate(a)}>
                      使用
                    </button>
                  )}
                  {!a.builtin && (
                    <>
                      <button className="btn-ghost !py-1.5 text-[13px]" onClick={() => editAccount(a)}>
                        编辑
                      </button>
                      <button
                        className="btn-ghost !py-1.5 text-[13px] hover:!bg-danger-soft hover:text-danger"
                        onClick={() =>
                          setConfirmDel({
                            a,
                            message: `确定解绑「${a.name}」（${a.accountId}）？\n存储桶和文件不会被删除，只是不再在此工具里显示。`,
                          })
                        }
                      >
                        解绑
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <button
            className="btn-plain mt-3 w-full border-dashed"
            onClick={() => setForm({ ...EMPTY_FORM })}
          >
            <UIcon name="plus" size={15} />
            绑定新账号
          </button>
          <div className="mt-2 flex gap-2">
            <button className="btn-plain flex-1" onClick={exportAccounts} disabled={busy}>
              导出备份
            </button>
            <button className="btn-plain flex-1" onClick={() => fileRef.current?.click()} disabled={busy}>
              导入恢复
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onImportFile} />
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-line pt-3.5">
            <span className="text-[12px] text-ink2/70">凭证来自「R2 → 管理 R2 API 令牌」</span>
            <button className="btn-ghost text-[13px]" onClick={logout} disabled={loggingOut}>
              <UIcon name="logout" size={14} />
              退出登录
            </button>
          </div>
        </div>
      )}
      {confirmDel && (
        <Confirm title="解绑账号" message={confirmDel.message} okText="解绑" onOk={() => remove(confirmDel.a)} onClose={() => setConfirmDel(null)} />
      )}
      {pendingImport && (
        <Confirm
          title="导入账号备份"
          message={`将从备份文件导入 ${pendingImport.count} 条账号记录（文件含明文密钥）：\n逐个验证凭证后加入，已绑定的 Account ID 自动跳过。确定继续？`}
          okText="导入"
          onOk={doImport}
          onClose={() => setPendingImport(null)}
        />
      )}
    </Modal>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <label className="text-[13px] font-medium">{label}</label>
        {hint && <span className="text-[11.5px] text-ink2/70">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
