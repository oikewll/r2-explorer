// 主题模式：light / dark / auto（跟随系统）
const KEY = 'r2x-theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')

export function getTheme() {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'auto'
}

function apply() {
  const mode = getTheme()
  const dark = mode === 'dark' || (mode === 'auto' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#101318' : '#f5f6f8')
}

// 自动模式下跟随系统切换
media.addEventListener('change', () => {
  if (getTheme() === 'auto') apply()
})

export function setTheme(mode) {
  localStorage.setItem(KEY, mode === 'light' || mode === 'dark' ? mode : 'auto')
  apply()
}

apply()
