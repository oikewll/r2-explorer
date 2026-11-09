import { useState } from 'react'
import { useStore } from '../lib/store'
import { navigate } from '../lib/hash'
import { api } from '../lib/api'
import { loadAccountsAndBuckets } from '../lib/loader'
import { getTheme, setTheme } from '../lib/theme'
import { FIcon, UIcon } from './icons'

const THEME_ORDER = ['light', 'dark', 'auto']
const THEME_LABEL = { light: '亮色模式', dark: '暗色模式', auto: '自动模式（跟随系统）' }
const THEME_ICON = { light: 'sun', dark: 'moon', auto: 'monitor' }

export default function Header({ route }) {
  const accounts = useStore((s) => s.accounts)
  const activeId = useStore((s) => s.activeId)
  const buckets = useStore((s) => s.buckets)
  const setAccountsOpen = useStore((s) => s.setAccountsOpen)
  const toast = useStore((s) => s.toast)
  const [theme, setThemeState] = useState(getTheme)

  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]
    setTheme(next)
    setThemeState(next)
  }

  const changeAccount = async (id) => {
    try {
      await api(`/api/accounts/${encodeURIComponent(id)}/activate`, { method: 'POST' })
      await loadAccountsAndBuckets()
      navigate('', '')
    } catch (e) {
      if (e.message !== 'unauthorized') toast('切换失败：' + e.message, 'error')
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[920px] items-center gap-2 px-4">
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
              title="切换 R2 账号"
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
              title="切换存储桶"
            >
              {!route.bucket && <option value="">选择桶…</option>}
              {buckets.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <button
            className="icon-btn"
            title={`主题：${THEME_LABEL[theme]}（点击切换）`}
            onClick={cycleTheme}
          >
            <UIcon name={THEME_ICON[theme]} size={18} />
          </button>
          <button className="icon-btn" title="账号管理" onClick={() => setAccountsOpen(true)}>
            <UIcon name="gear" size={18} />
          </button>
        </div>
      </div>
    </header>
  )
}
