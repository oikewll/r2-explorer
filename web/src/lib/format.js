export function fmtSize(b) {
  if (b === undefined || b === null) return '—'
  if (b === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), units.length - 1)
  const n = b / Math.pow(1024, i)
  return (n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i]
}

export function fmtTime(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return '—'
  const pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US')
}

export function iconType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'm4v', 'mov', 'avi', 'mkv', 'flv', 'wmv'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'wma'].includes(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (['zip', '7z', 'rar', 'gz', 'tar', 'bz2', 'xz', 'zst'].includes(ext)) return 'archive'
  if (['apk', 'ipa', 'dmg', 'exe', 'msi', 'appimage', 'deb', 'rpm'].includes(ext)) return 'app'
  if (['js', 'ts', 'mjs', 'cts', 'jsx', 'tsx', 'html', 'htm', 'css', 'scss', 'json', 'meta', 'xml', 'yml', 'yaml', 'lua', 'sh', 'bash', 'plist', 'properties', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'rb', 'sql'].includes(ext)) return 'code'
  if (['md', 'txt', 'csv', 'log', 'version', 'ini', 'cfg', 'conf'].includes(ext)) return 'doc'
  if (['so', 'wasm', 'dylib', 'dll', 'bin', 'dat', 'pak'].includes(ext)) return 'binary'
  return 'file'
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'm4v', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', '3gp', 'ogv', 'm2ts', 'vob'])
// 浏览器 <video> 能直放的容器
const NATIVE_VIDEO_EXT = new Set(['mp4', 'webm', 'm4v', 'mov'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'])
const TEXT_EXT = new Set(['txt', 'json', 'meta', 'xml', 'yml', 'yaml', 'js', 'ts', 'mjs', 'cts', 'css', 'html', 'htm', 'md', 'csv', 'log', 'ini', 'cfg', 'conf', 'sh', 'lua', 'plist', 'properties', 'version', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'sql', 'toml', 'swift', 'kt', 'diff', 'patch', 'env'])
const ZIP_EXT = new Set(['zip', 'apk', 'ipa', 'jar', 'xapk', 'epub'])

export function categoryOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (TEXT_EXT.has(ext)) return 'text'
  if (ZIP_EXT.has(ext)) return 'zip'
  return null
}

export function isNativeVideo(name) {
  return NATIVE_VIDEO_EXT.has((name.split('.').pop() || '').toLowerCase())
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {}
    ta.remove()
    return ok
  }
}
