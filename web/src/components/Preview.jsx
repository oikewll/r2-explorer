import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fmtSize, fmtTime, fmtNum, categoryOf, iconType } from '../lib/format'
import { FIcon, UIcon } from './icons'

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

function zipEntryUrl(f, e, download) {
  const q = new URLSearchParams({
    bucket: f.bucket,
    key: f.path,
    name: e.name,
    off: e.offset,
    csize: e.compSize,
    usize: e.uncompSize,
    method: e.method,
    download: download ? '1' : '0',
  })
  return '/api/zip-entry?' + q.toString()
}

function textUrl(bucket, key) {
  return '/api/text?bucket=' + encodeURIComponent(bucket) + '&key=' + encodeURIComponent(key)
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

function ZipBody({ f, entries, total, truncated, onEntry, onClose, onBack }) {
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
                    href={zipEntryUrl(f, e, true)}
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

export default function Preview({ state, onClose, onBack, setPreview }) {
  const { mode } = state
  const dark = mode !== 'zip' && ['file', 'zipEntry'].includes(mode)
  const cat = state.f ? categoryOf(state.f.name) : null
  const mediaUrl = mode === 'zipEntry' ? zipEntryUrl(state.f, state.entry, false) : state.f.url

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

  const loadEntryText = async (f, e) => {
    const res = await fetch(zipEntryUrl(f, e, false))
    const text = await res.text()
    setPreview({ mode: 'zipEntry', f, entry: e, text })
  }

  const openEntry = async (f, e) => {
    const c = categoryOf(e.name)
    if (c === 'text') return loadEntryText(f, e)
    setPreview({ mode: 'zipEntry', f, entry: e })
  }

  // zip 目录视图
  if (mode === 'zip') {
    return (
      <div className="modal-overlay fade-in items-end sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <ZipBody
          f={state.f}
          entries={state.entries}
          total={state.total}
          truncated={state.truncated}
          onEntry={(e) => openEntry(state.f, e)}
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
          {cat === 'image' && (
            <img src={mediaUrl} alt="" className="m-auto max-h-full max-w-full object-contain p-4" />
          )}
          {cat === 'video' && (
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
        <DownloadPrompt name={f.name} url={f.url} sizeText={fmtSize(f.size)} />
      ) : (
        <div className="flex flex-col items-center px-8 py-14 text-[14px] text-ink2">
          <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-line border-t-accent" />
          <div className="mt-4">正在读取压缩包目录…</div>
        </div>
      )}
    </div>
  )
}
