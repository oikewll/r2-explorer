import { useState } from 'react'
import { useStore } from '../lib/store'
import { navigate } from '../lib/hash'
import { api } from '../lib/api'
import { loadAccountsAndBuckets } from '../lib/loader'
import { useT } from '../lib/i18n'
import Settings from './Settings'
import { FIcon, UIcon } from './icons'

export default function Header({ route }) {
  const t = useT()
  const accounts = useStore((s) => s.accounts)
  const activeId = useStore((s) => s.activeId)
  const buckets = useStore((s) => s.buckets)
  const setAccountsOpen = useStore((s) => s.setAccountsOpen)
  const toast = useStore((s) => s.toast)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const changeAccount = async (id) => {
    try {
      await api(`/api/accounts/${encodeURIComponent(id)}/activate`, { method: 'POST' })
      await loadAccountsAndBuckets()
      navigate('', '')
    } catch (e) {
      if (e.message !== 'unauthorized') toast(t('切换失败：') + e.message, 'error')
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-bg/85 backdrop-blur-md">
      <div className={'mx-auto flex h-14 items-center gap-2 px-4 ' + (route.bucket ? 'max-w-[920px]' : 'max-w-[1140px]')}>
        <button
          className="flex items-center gap-2.5 rounded-[10px] font-semibold text-[16px] hover:opacity-80 transition"
          onClick={() => navigate('', '')}
        >
          <FIcon type="bucket" size={30} />
          <span className="max-sm:hidden">R2 Explorer</span>
        </button>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {accounts.length > 0 && (
            <select
              className="select max-w-[140px]"
              value={activeId}
              onChange={(e) => changeAccount(e.target.value)}
              title={t('切换 R2 账号')}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          {buckets.length > 0 && (
            <select
              className="select max-w-[180px]"
              value={route.bucket}
              onChange={(e) => navigate(e.target.value, '')}
              title={t('切换存储桶')}
            >
              {!route.bucket && <option value="">{t('选择桶…')}</option>}
              {buckets.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <button className="icon-btn" title={t('账号管理')} onClick={() => setAccountsOpen(true)}>
            <UIcon name="user" size={18} />
          </button>
          <button className="icon-btn" title={t('设置')} onClick={() => setSettingsOpen(true)}>
            <UIcon name="gear" size={18} />
          </button>
        </div>
      </div>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </header>
  )
}
