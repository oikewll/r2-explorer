import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { fmtSize, fmtTime, categoryOf, iconType } from '../lib/format'
import { navigate } from '../lib/hash'
import { playFromList } from '../lib/player'
import { useStore } from '../lib/store'
import Modal from './Modal'
import { FIcon, UIcon } from './icons'

const PENDING_OPEN = 'r2x_pending_open'

// 结果点击：音频直接进播放器；其他类型跳到所在目录并自动打开预览
function openResult(f) {
  if (categoryOf(f.name) === 'audio') {
    playFromList([f], f)
    return
  }
  sessionStorage.setItem(PENDING_OPEN, JSON.stringify({ bucket: f.bucket, path: f.path }))
  navigate(f.bucket, f.dir)
}

function ResultRow({ f, onPick }) {
  return (
    <button
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-bg"
      onClick={() => {
        openResult(f)
        onPick()
      }}
    >
      <FIcon type={iconType(f.name)} size={22} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium" title={f.path}>
          {f.name}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-ink2" title={f.dir}>
          {f.dir || '/'}
        </div>
      </div>
      <div className="shrink-0 text-right text-[11.5px] tabular-nums text-ink2/80">
        <div>{f.sizeText}</div>
        <div className="mt-0.5">{fmtTime(f.modified)}</div>
      </div>
    </button>
  )
}

export default function SearchModal({ bucket, onClose }) {
  const toast = useStore((s) => s.toast)
  const [q, setQ] = useState('')
  const [scopeDir, setScopeDir] = useState(false)
  const [state, setState] = useState({ loading: false, files: [], more: false, done: false, error: '' })
  const inputRef = useRef(null)
  const seq = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 防抖搜索：输入停 300ms 才请求，避免打字过程狂刷
  useEffect(() => {
    const kw = q.trim()
    if (kw.length < 2) {
      setState({ loading: false, files: [], more: false, done: false, error: '' })
      return
    }
    const id = ++seq.current
    setState((s) => ({ ...s, loading: true }))
    const timer = setTimeout(() => {
      api('/api/search?bucket=' + encodeURIComponent(bucket) + '&q=' + encodeURIComponent(kw) + (scopeDir ? '&prefix=' : ''))
        .then((d) => {
          if (seq.current !== id) return
          // 统一补上 bucket，点击结果跳转/播放不再依赖调用方补参
          setState({ loading: false, files: (d.files || []).map((f) => ({ ...f, bucket })), more: !!d.more, done: true, error: '' })
        })
        .catch((e) => {
          if (seq.current !== id || e.message === 'unauthorized') return
          setState({ loading: false, files: [], more: false, done: true, error: e.message })
          toast('搜索失败：' + e.message, 'error')
        })
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, scopeDir, bucket])

  const { loading, files, more, done, error } = state
  return (
    <Modal title="全局搜索" onClose={onClose} width="max-w-xl">
      <div className="px-4 pb-2">
        <div className="relative">
          <UIcon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink2" />
          <input
            ref={inputRef}
            className="input h-10 pl-9"
            placeholder={`在「${bucket}」中搜索文件名（至少 2 个字符）…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[12.5px] text-ink2">
          <input type="checkbox" className="row-chk" checked={scopeDir} onChange={(e) => setScopeDir(e.target.checked)} />
          仅在当前目录范围内搜索
        </label>
      </div>
      <div className="thin-scroll max-h-[52vh] min-h-[160px] overflow-y-auto border-t border-line">
        {loading && <div className="py-10 text-center text-[13px] text-ink2">搜索中…</div>}
        {!loading && done && error && <div className="py-10 text-center text-[13px] text-danger">搜索失败：{error}</div>}
        {!loading && done && !error && files.length === 0 && (
          <div className="py-10 text-center text-[13px] text-ink2">没有匹配的文件</div>
        )}
        {files.length > 0 && (
          <>
            <div className="divide-y divide-line/60">
              {files.map((f) => (
                <ResultRow key={f.path} f={f} onPick={onClose} />
              ))}
            </div>
            {more && (
              <div className="border-t border-line/60 px-4 py-2.5 text-center text-[12px] text-ink2">
                匹配结果较多，仅显示前 {files.length} 条——试试更具体的关键字
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

export { PENDING_OPEN }
