import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { fmtSize, fmtTime, fmtNum, categoryOf, iconType } from '../lib/format'
import { FIcon, UIcon } from './icons'
// hljs 主题样式（重构时从 CDN 内联丢了，没它语法 token 不着色）
import 'highlight.js/styles/github.css'
import VideoPlayer from './VideoPlayer'
import ImageViewer from './ImageViewer'

const PLAIN_EXT = new Set(['txt', 'log', 'csv'])
const LANG_BY_EXT = {
  json: 'json',
  js: 'javascript', mjs: 'javascript', cts: 'javascript', ts: 'typescript',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', plist: 'xml',
  css: 'css', md: 'markdown',
  yml: 'yaml', yaml: 'yaml', toml: 'ini',
  ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini',
  sh: 'bash', lua: 'lua', py: 'python', rb: 'ruby', php: 'php', sql: 'sql',
  go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c',
  cpp: 'hpp', cs: 'csharp', swift: 'swift', kt: 'kotlin',
  diff: 'diff', patch: 'diff',
}

function codeLang(name) {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (PLAIN_EXT.has(ext)) return 'plaintext'
  return LANG_BY_EXT[ext] || '' // 其余交给 hljs 自动识别
}

// zip 条目走 Range 参数直读；rar/7z/tar 走 /api/ar-entry 按名字解压
function entryUrl(f, kind, e, download) {
  const q = new URLSearchParams({ bucket: f.bucket, key: f.path, download: download ? '1' : '0' })
  if (kind === 'zip' || !kind) {
    q.set('name', e.name)
    q.set('off', e.offset)
    q.set('csize', e.compSize)
    q.set('usize', e.uncompSize)
    q.set('method', e.method)
    return '/api/zip-entry?' + q.toString()
  }
  q.set('name', e.name)
  return '/api/ar-entry?' + q.toString()
}

function textUrl(bucket, key) {
  return '/api/text?bucket=' + encodeURIComponent(bucket) + '&key=' + encodeURIComponent(key)
}

// 图片走同源代理：预签名/CDN 直链没有 CORS 头，画布（透明检测/GIF 定格/编辑导出）会被污染
function rawUrl(f) {
  return '/api/raw?bucket=' + encodeURIComponent(f.bucket) + '&key=' + encodeURIComponent(f.path)
}

// 代码/文本预览（动态加载 highlight.js）
function CodeBody({ text, name }) {
  const [html, setHtml] = useState(null)
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { default: hljs } = await import('highlight.js/lib/common')
      const lang = codeLang(name)
      let highlighted
      try {
        highlighted = lang ? hljs.highlight(text, { language: lang }) : hljs.highlightAuto(text)
      } catch {
        highlighted = hljs.highlight(text, { language: 'plaintext' })
      }
      if (alive) setHtml(highlighted.value)
    })()
    return () => {
      alive = false
    }
  }, [text, name])
  return (
    <pre className="code-view">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html ?? null }} />
    </pre>
  )
}

function TopBar({ title, url, onBack, onClose, dark }) {
  return (
    <div
      className={`flex shrink-0 items-center gap-1 px-3 py-2 ${
        dark ? 'border-b border-white/10 bg-black/60 text-white' : 'border-b border-line bg-card'
      }`}
    >
      {onBack && (
        <button className={`icon-btn ${dark ? 'hover:bg-white/10 hover:text-white' : ''}`} onClick={onBack} title="返回">
          <UIcon name="back" size={17} />
        </button>
      )}
      <div className={`min-w-0 flex-1 truncate text-[13.5px] font-medium ${dark ? 'text-white/90' : ''}`} title={title}>
        {title}
      </div>
      {url && (
        <a
          className={`icon-btn ${dark ? 'hover:bg-white/10 hover:text-white' : ''}`}
          href={url}
          target="_blank"
          rel="noreferrer"
          title="下载 / 新窗口打开"
        >
          <UIcon name="download" size={16} />
        </a>
      )}
      <button className={`icon-btn ${dark ? 'hover:bg-white/10 hover:text-white' : ''}`} onClick={onClose} title="关闭">
        <UIcon name="close" size={17} />
      </button>
    </div>
  )
}

function DownloadPrompt({ name, url, sizeText }) {
  return (
    <div className="flex flex-col items-center px-8 py-14 text-center">
      <FIcon type={iconType(name)} size={72} />
      <div className="mt-4 text-[15px] font-medium">{name}</div>
      <div className="mt-1 text-[13px] text-ink2">{sizeText} · 该文件类型不支持在线预览</div>
      <a className="btn-primary mt-5" href={url} target="_blank" rel="noreferrer">
        <UIcon name="download" size={15} />
        下载文件
      </a>
    </div>
  )
}

// Office 预览：docx/xlsx/pptx 纯前端渲染（服务端只管给字节，zip 条目同样适用）
function officeExt(name) {
  return (name.split('.').pop() || '').toLowerCase()
}

function OfficeBody({ name, url }) {
  const ext = officeExt(name)
  const [state, setState] = useState({ status: 'loading' })
  const hostRef = useRef(null)

  useEffect(() => {
    let alive = true
    const host = hostRef.current
    setState({ status: 'loading' })
    ;(async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error('读取失败（HTTP ' + res.status + '）')
        const buf = await res.arrayBuffer()
        if (!alive) return
        if (ext === 'docx') {
          const { renderAsync } = await import('docx-preview')
          await renderAsync(buf, host, null, { inWrapper: true })
        } else if (ext === 'xlsx') {
          const XLSX = await import('xlsx')
          const wb = XLSX.read(buf, { type: 'array' })
          if (!alive) return
          setState({ status: 'xlsx', book: wb, lib: XLSX, active: wb.SheetNames[0] })
          return
        } else if (ext === 'pptx') {
          const { init } = await import('pptx-preview')
          const width = Math.max(320, Math.min(host.clientWidth || 800, 960))
          const viewer = init(host, { width, height: Math.round((width * 9) / 16) })
          viewer.preview(buf)
        }
        if (alive) setState({ status: 'ok' })
      } catch (e) {
        if (alive) setState({ status: 'error', error: e.message })
      }
    })()
    return () => {
      alive = false
      if (host) host.innerHTML = ''
    }
  }, [url, ext])

  const xlsxHtml = () => {
    const raw = state.lib.utils.sheet_to_html(state.book.Sheets[state.active])
    const m = raw.match(/<table[\s\S]*<\/table>/i)
    return m ? m[0] : raw
  }

  return (
    <div className="relative flex h-full w-full flex-col">
      {state.status === 'loading' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-card text-[14px] text-ink2">
          <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-line border-t-accent" />
          <div className="mt-4">正在加载预览…</div>
        </div>
      )}
      {state.status === 'error' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-card px-8 text-center text-[14px] text-ink2">
          <div>预览失败：{state.error}</div>
          <div className="mt-1 text-[12px] text-ink2/60">可下载后用本地软件打开</div>
        </div>
      )}
      {state.status === 'xlsx' ? (
        <>
          {state.book.SheetNames.length > 1 && (
            <div className="thin-scroll flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-2">
              {state.book.SheetNames.map((n) => (
                <button
                  key={n}
                  className={`shrink-0 rounded-lg px-3 py-1 text-[13px] ${
                    n === state.active ? 'bg-accent-soft font-medium text-accent' : 'text-ink2 hover:bg-bg'
                  }`}
                  onClick={() => setState((s) => ({ ...s, active: n }))}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          <div className="thin-scroll office-xlsx flex-1 overflow-auto p-4" dangerouslySetInnerHTML={{ __html: xlsxHtml() }} />
        </>
      ) : (
        <div ref={hostRef} className="office-host thin-scroll min-h-0 flex-1 overflow-auto" />
      )}
    </div>
  )
}

function AudioCard({ name, url, sizeText }) {
  return (
    <div className="mx-auto my-auto w-full max-w-[420px] rounded-2xl bg-card p-8 text-center shadow-2xl">
      <div className="mx-auto w-fit">
        <FIcon type="audio" size={56} />
      </div>
      <div className="mt-3 truncate text-[15px] font-medium" title={name}>
        {name}
      </div>
      <div className="mt-0.5 text-[12px] text-ink2">{sizeText}</div>
      <audio src={url} controls autoplay className="mt-5 w-full" />
    </div>
  )
}

function ZipBody({ f, kind, entries, total, truncated, onEntry, onClose, onBack }) {
  return (
    <div className="modal-panel pop-in max-h-[86dvh] w-full max-w-[620px]">
      <TopBar
        title={`${f.name} · ${fmtNum(total)} 个文件${truncated ? '（已截断）' : ''}`}
        onClose={onClose}
        onBack={onBack}
      />
      <div className="thin-scroll flex-1 overflow-y-auto">
        <div className="divide-y divide-line/70">
          {entries.map((e, i) => {
            const cat = categoryOf(e.name)
            return (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg">
                <FIcon type={iconType(e.name)} size={26} />
                <div className="min-w-0 flex-1 truncate text-[13.5px]" title={e.name}>
                  {e.name}
                </div>
                <div className="hidden w-20 shrink-0 text-right text-[12px] text-ink2 sm:block">{fmtSize(e.uncompSize)}</div>
                {cat ? (
                  <button
                    className="btn-ghost shrink-0 !px-2.5 !py-1 text-[13px] text-accent hover:!bg-accent-soft"
                    onClick={() => onEntry(e)}
                  >
                    预览
                  </button>
                ) : (
                  <a
                    className="btn-ghost shrink-0 !px-2.5 !py-1 text-[13px]"
                    href={entryUrl(f, kind, e, true)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    下载
                  </a>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default function Preview({ state, onClose, onBack, setPreview, onSaved }) {
  const { mode } = state
  const dark = mode !== 'zip' && ['file', 'zipEntry'].includes(mode)
  const cat = state.f ? categoryOf(state.f.name) : null
  const mediaUrl = mode === 'zipEntry' ? entryUrl(state.f, state.kind, state.entry, false) : state.f.url

  useEffect(() => {
    const fn = (e) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        if (mode === 'zipEntry') onBack()
        else onClose()
      }
    }
    document.addEventListener('keydown', fn, true)
    return () => document.removeEventListener('keydown', fn, true)
  }, [mode])

  const loadEntryText = async (f, e, kind) => {
    const res = await fetch(entryUrl(f, kind, e, false))
    const text = await res.text()
    setPreview({ mode: 'zipEntry', f, entry: e, kind, text })
  }

  const openEntry = async (f, e, kind) => {
    const c = categoryOf(e.name)
    if (c === 'text') return loadEntryText(f, e, kind)
    setPreview({ mode: 'zipEntry', f, entry: e, kind })
  }

  // 压缩包目录视图
  if (mode === 'zip') {
    return (
      <div className="modal-overlay fade-in items-end sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <ZipBody
          f={state.f}
          kind={state.kind}
          entries={state.entries}
          total={state.total}
          truncated={state.truncated}
          onEntry={(e) => openEntry(state.f, e, state.kind)}
          onClose={onClose}
          onBack={onBack}
        />
      </div>
    )
  }

  // 文件 / zip 条目
  return (
    <div
      className="modal-overlay fade-in !bg-black/80 p-0 sm:p-0"
      onMouseDown={(e) => e.target === e.currentTarget && (mode === 'zipEntry' ? onBack() : onClose())}
    >
      <div className="fixed inset-0 flex flex-col">
        <TopBar
          dark={cat !== 'text' && cat !== 'pdf'}
          title={mode === 'zipEntry' ? state.entry.name : state.f.name}
          url={mediaUrl}
          onBack={mode === 'zipEntry' ? onBack : null}
          onClose={onClose}
        />
        <div className="relative flex min-h-0 flex-1">
          {cat === 'image' && mode === 'file' && (
            <ImageViewer
              f={state.f}
              url={rawUrl(state.f)}
              siblings={state.siblings || [state.f]}
              setPreview={setPreview}
              onSaved={onSaved}
              canEdit
            />
          )}
          {cat === 'image' && mode === 'zipEntry' && (
            <ImageViewer
              f={{ ...state.f, name: state.entry.name, size: state.entry.uncompSize, path: `${state.f.path}::${state.entry.name}` }}
              url={mediaUrl}
              siblings={[]}
              setPreview={setPreview}
            />
          )}
          {cat === 'video' && mode === 'file' && (
            <VideoPlayer f={state.f} siblings={state.siblings} setPreview={setPreview} />
          )}
          {cat === 'video' && mode === 'zipEntry' && (
            <video
              src={mediaUrl}
              controls
              autoPlay
              playsInline
              className="m-auto max-h-full w-full max-w-[900px] px-4"
            />
          )}
          {cat === 'audio' && (
            <AudioCard
              name={mode === 'zipEntry' ? state.entry.name : state.f.name}
              url={mediaUrl}
              sizeText={fmtSize(mode === 'zipEntry' ? state.entry.uncompSize : state.f.size)}
            />
          )}
          {cat === 'pdf' && (
            <div className="modal-panel pop-in m-auto h-[86dvh] w-full max-w-[860px]">
              <iframe src={mediaUrl} className="h-full w-full border-0" title="pdf" />
            </div>
          )}
          {cat === 'office' && (
            <div className="modal-panel pop-in m-auto h-[86dvh] w-full max-w-[920px]">
              <OfficeBody
                name={mode === 'zipEntry' ? state.entry.name : state.f.name}
                // office 解析需要 fetch 读字节：必须走同源 /api/raw，预签名直链没有 CORS 头会直接被拦
                url={mode === 'zipEntry' ? mediaUrl : rawUrl(state.f)}
              />
            </div>
          )}
          {cat === 'text' && (
            <div className="modal-panel pop-in m-auto h-[86dvh] w-full max-w-[860px]">
              {mode === 'zipEntry' ? (
                <CodeBody text={state.text || ''} name={state.entry.name} />
              ) : (
                <TextBody bucket={state.f.bucket} path={state.f.path} name={state.f.name} />
              )}
            </div>
          )}
          {cat === 'zip' && mode === 'file' && (
            <ZipLoader bucket={state.f.bucket} path={state.f.path} f={state.f} setPreview={setPreview} onClose={onClose} />
          )}
          {(!cat || (cat === 'zip' && mode === 'zipEntry')) && (
            <div className="modal-panel pop-in m-auto w-full max-w-[420px]">
              <DownloadPrompt
                name={mode === 'zipEntry' ? state.entry.name : state.f.name}
                url={mediaUrl}
                sizeText={fmtSize(mode === 'zipEntry' ? state.entry.uncompSize : state.f.size)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// 文本文件：拉取 + 判断大小
function TextBody({ bucket, path, name }) {
  const [state, setState] = useState({ loading: true })
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(textUrl(bucket, path))
        // 只消费一次 body：先 text 再解析错误信息（先 json() 会把成功响应的流读走）
        const text = await res.text()
        if (!res.ok) {
          let msg = '读取失败'
          try {
            msg = JSON.parse(text).error || msg
          } catch {}
          throw new Error(msg)
        }
        if (alive) setState({ loading: false, text })
      } catch (e) {
        if (alive) setState({ loading: false, error: e.message })
      }
    })()
    return () => {
      alive = false
    }
  }, [bucket, path])

  if (state.loading) return <div className="p-10 text-center text-[14px] text-ink2">加载中…</div>
  if (state.error)
    return (
      <div className="p-10 text-center text-[14px] text-ink2">
        {state.error}
        <div className="mt-1 text-[12px] text-ink2/60">大文件请下载后查看</div>
      </div>
    )
  return <CodeBody text={state.text} name={name} />
}

// zip 目录加载器：加载后切换到 zip 列表视图
function ZipLoader({ bucket, path, f, setPreview, onClose }) {
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    api('/api/zip?bucket=' + encodeURIComponent(bucket) + '&key=' + encodeURIComponent(path))
      .then((data) => {
        if (alive) setPreview({ mode: 'zip', f, ...data })
      })
      .catch((e) => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
    }
  }, [bucket, path])

  return (
    <div className="modal-panel pop-in m-auto w-full max-w-[420px]">
      {error ? (
        <div className="flex flex-col items-center px-8 py-12 text-center">
          <FIcon type={iconType(f.name)} size={64} />
          <div className="mt-4 text-[15px] font-medium">{f.name}</div>
          <div className="mt-1 text-[13px] text-ink2">{fmtSize(f.size)}</div>
          <div className="mt-3 max-w-[320px] text-[13px] text-red-500">{error}</div>
          <a className="btn-primary mt-5" href={f.url} target="_blank" rel="noreferrer">
            <UIcon name="download" size={15} />
            下载文件
          </a>
        </div>
      ) : (
        <div className="flex flex-col items-center px-8 py-14 text-[14px] text-ink2">
          <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-line border-t-accent" />
          <div className="mt-4">正在读取压缩包目录…</div>
        </div>
      )}
    </div>
  )
}
