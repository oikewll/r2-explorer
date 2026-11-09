import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { FIcon, UIcon } from './icons'
import Modal from './Modal'

// 移动/重命名弹窗：浏览目标目录后移动。items: [{ path, name, isDir }]
export default function MoveModal({ bucket, items, currentPrefix, onClose, onDone }) {
  const toast = useStore((s) => s.toast)
  const [prefix, setPrefix] = useState('')
  const [dirs, setDirs] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const crumbs = [{ name: bucket, path: '' }]
  let acc = ''
  for (const seg of prefix.split('/').filter(Boolean)) {
    acc += seg + '/'
    crumbs.push({ name: seg, path: acc })
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    api('/api/list?bucket=' + encodeURIComponent(bucket) + '&prefix=' + encodeURIComponent(prefix))
      .then((d) => {
        if (alive) setDirs(d.dirs)
      })
      .catch((e) => {
        if (alive && e.message !== 'unauthorized') setError(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [bucket, prefix])

  const doMove = async () => {
    setBusy(true)
    try {
      // 计算目标 key；过滤非法目标（移动到自身/自身子目录）
      const fileItems = []
      const dirItems = []
      for (const it of items) {
        let to
        if (it.isDir) {
          to = prefix + it.name + '/'
          if (to === it.path || to.startsWith(it.path)) continue
          dirItems.push({ from: it.path, to })
        } else {
          to = prefix + it.name
          if (to === it.path) continue
          fileItems.push({ from: it.path, to })
        }
      }
      let moved = 0
      const failed = []
      if (fileItems.length) {
        const res = await api('/api/move', {
          method: 'POST',
          body: JSON.stringify({ bucket, items: fileItems }),
        })
        moved += res.moved || 0
        failed.push(...(res.failed || []))
      }
      if (dirItems.length) {
        const res = await api('/api/move-tree', {
          method: 'POST',
          body: JSON.stringify({ bucket, items: dirItems }),
        })
        moved += res.moved || 0
        failed.push(...(res.failed || []))
      }
      if (failed.length) {
        toast(`移动完成，${failed.length} 项失败：${failed[0].reason || ''}`, 'error')
      } else {
        toast(`已移动 ${moved} 项到 /${prefix || ''}`)
      }
      onDone()
    } catch (e) {
      if (e.message !== 'unauthorized') toast('移动失败：' + e.message, 'error')
      setBusy(false)
    }
  }

  const canDropHere =
    !items.some((it) => it.isDir && (prefix + it.name + '/' === it.path || (prefix + it.name + '/').startsWith(it.path))) &&
    !items.some((it) => prefix + it.name === it.path)

  return (
    <Modal title={`移动 ${items.length} 项`} onClose={onClose} width="max-w-[520px]">
      <div className="px-5 py-4">
        {/* 面包屑 */}
        <div className="mb-3 flex flex-wrap items-center gap-1 text-[13.5px]">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1">
              {i > 0 && <span className="text-ink2/50">/</span>}
              {i === crumbs.length - 1 ? (
                <span className="font-semibold">{c.name}</span>
              ) : (
                <button
                  className="rounded-md px-1 py-0.5 text-ink2 hover:bg-ink/[0.05] hover:text-ink"
                  onClick={() => setPrefix(c.path)}
                >
                  {c.name}
                </button>
              )}
            </span>
          ))}
        </div>

        <div className="thin-scroll max-h-[280px] min-h-[120px] overflow-y-auto rounded-xl border border-line">
          {loading ? (
            <div className="p-8 text-center text-[13px] text-ink2">加载中…</div>
          ) : error ? (
            <div className="p-8 text-center text-[13px] text-danger">{error}</div>
          ) : dirs.length === 0 ? (
            <div className="p-8 text-center text-[13px] text-ink2/70">这里没有子文件夹，可以直接移动到当前位置</div>
          ) : (
            <div className="divide-y divide-line/60">
              {dirs.map((d) => (
                <button
                  key={d.path}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-bg"
                  onClick={() => setPrefix(d.path)}
                >
                  <FIcon type="folder" size={26} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{d.name}</span>
                  <UIcon name="back" size={14} className="rotate-180 text-ink2/50" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="text-[12px] text-ink2">{canDropHere ? '' : '不能移动到自身或其子目录'}</div>
          <div className="flex gap-2">
            <button className="btn-plain" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button className="btn-primary" onClick={doMove} disabled={busy || !canDropHere}>
              {busy ? '移动中…' : '移动到这里'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
