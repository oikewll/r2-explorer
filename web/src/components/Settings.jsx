import { useState } from 'react'
import { useStore } from '../lib/store'
import { getTheme, setTheme } from '../lib/theme'
import { useT, setLang, LANGS } from '../lib/i18n'
import Modal from './Modal'
import { UIcon } from './icons'
const THEMES = [
  { value: 'light', label: '亮色', full: '亮色模式', icon: 'sun' },
  { value: 'dark', label: '暗色', full: '暗色模式', icon: 'moon' },
  { value: 'auto', label: '自动', full: '自动模式（跟随系统）', icon: 'monitor' },
]

// 设置弹窗：语言 + 主题。移动端顶栏不放这些入口，统一收进这里。
export default function Settings({ onClose }) {
  const t = useT()
  const lang = useStore((s) => s.lang)
  const setAccountsOpen = useStore((s) => s.setAccountsOpen)
  const [theme, setThemeState] = useState(getTheme)

  return (
    <Modal title={t('设置')} onClose={onClose} width="max-w-[360px]">
      <div className="space-y-5 px-5 py-4">
        {/* 语言 */}
        <section>
          <div className="mb-2 text-[13px] font-medium text-ink2">{t('语言')}</div>
          <div className="flex flex-wrap gap-2">
            {LANGS.map((l) => (
              <button
                key={l.code}
                className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] transition ${
                  lang === l.code
                    ? 'border-accent bg-accent-soft font-medium text-accent'
                    : 'border-line text-ink2 hover:bg-ink/[0.04] hover:text-ink'
                }`}
                onClick={() => setLang(l.code)}
              >
                {lang === l.code && <UIcon name="check" size={13} />}
                {l.label}
              </button>
            ))}
          </div>
        </section>

        {/* 主题 */}
        <section>
          <div className="mb-2 text-[13px] font-medium text-ink2">{t('主题')}</div>
          <div className="flex overflow-hidden rounded-[10px] border border-line">
            {THEMES.map((m, i) => (
              <button
                key={m.value}
                title={t(m.full)}
                className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap py-2 text-[12.5px] transition ${
                  i > 0 ? 'border-l border-line' : ''
                } ${
                  theme === m.value
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-ink2 hover:bg-ink/[0.04] hover:text-ink'
                }`}
                onClick={() => {
                  setTheme(m.value)
                  setThemeState(m.value)
                }}
              >
                <UIcon name={m.icon} size={15} />
                {t(m.label)}
              </button>
            ))}
          </div>
        </section>

        {/* 账号管理 */}
        <button
          className="flex w-full items-center gap-2 rounded-[10px] border border-line px-3.5 py-2.5 text-[13.5px] transition hover:bg-ink/[0.04]"
          onClick={() => {
            onClose()
            setAccountsOpen(true)
          }}
        >
          <UIcon name="user" size={16} className="text-ink2" />
          <span className="flex-1 text-left font-medium">{t('账号管理')}</span>
          <span className="text-[12px] text-ink2/70">{t('导入 / 导出备份、绑定账号')}</span>
        </button>
      </div>
    </Modal>
  )
}
