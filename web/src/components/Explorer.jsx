import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { fmtSize, fmtTime, iconType, categoryOf, copyText } from '../lib/format'
import { navigate, buildHash } from '../lib/hash'
import { useStore } from '../lib/store'
import { startUpload } from '../lib/uploader'
import { playFromList } from '../lib/player'
import { capabilities } from '../lib/video'
import { FIcon, UIcon } from './icons'
import Preview from './Preview'
import Confirm from './Confirm'
import MoveModal from './MoveModal'
import RenameModal from './RenameModal'

function Crumbs({ crumbs, bucket }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 text-[14px]">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1
        return (
          <span key={c.path} className="flex min-w-0 items-center gap-1">
            {i > 0 && <span className="shrink-0 text-ink2/50">/</span>}
            {last ? (
              <span className="truncate font-semibold">{c.name}</span>
            ) : (
              <button
                className="shrink-0 max-w-[160px] truncate rounded-md px-1.5 py-0.5 text-ink2 transition hover:bg-ink/[0.05] hover:text-ink"
                onClick={() => navigate(bucket, c.path)}
              >
                {c.name}
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

function RowAction({ title, icon, onClick, danger }) {
  return (
    <button
      title={title}
      className={`rounded-lg p-1.5 transition-colors ${
        danger ? 'text-ink2 hover:bg-danger-soft hover:text-danger' : 'text-ink2 hover:bg-ink/[0.06] hover:text-ink'
      }`}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <UIcon name={icon} size={15} />
    </button>
  )
}

const SORTS = [
  { value: 'name', label: '按名称' },
  { value: 'size', label: '按大小' },
  { value: 'time', label: '按时间' },
]

export default function Explorer({ route }) {
  const toast = useStore((s) => s.toast)
  const playerVisible = useStore((s) => s.player.visible)
  const setDownloadModalOpen = useStore((s) => s.setDownloadModalOpen)
  const setDownloadTarget = useStore((s) => s.setDownloadTarget)
  const downloadsVersion = useStore((s) => s.downloadsVersion)
  const [caps, setCaps] = useState(null)
  const [data, setData] = useState(null) // { crumbs, dirs, files }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('name')
  const [selected, setSelected] = useState(new Set())
  const [reload, setReload] = useState(0)
  const [preview, setPreview] = useState(null)
  const [confirm, setConfirm] = useState(null) // { title, message, onOk }
  const [moveItems, setMoveItems] = useState(null)
  const [renameItem, setRenameItem] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef(null)
  const dragCounter = useRef(0)

  const bucket = route.bucket
  const prefix = route.prefix

  useEffect(() => {
    setSelected(new Set())
    setSearch('')
    let alive = true
    setLoading(true)
    setError('')
    api('/api/list?bucket=' + encodeURIComponent(bucket) + '&prefix=' + encodeURIComponent(prefix))
      .then((d) => {
        if (alive) setData(d)
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
  }, [bucket, prefix, reload])

  const refresh = () => setReload((n) => n + 1)

  // 服务端能力（离线下载仅 Node/Docker 版支持）
  useEffect(() => {
    capabilities().then(setCaps).catch(() => {})
  }, [])

  // 有下载任务结束（完成/失败）时刷新目录，新文件及时出现
  useEffect(() => {
    if (downloadsVersion > 0) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadsVersion])

  const items = useMemo(() => {
    if (!data) return { dirs: [], files: [] }
    const q = search.trim().toLowerCase()
    const match = (n) => !q || n.toLowerCase().includes(q)
    const dirs = data.dirs.filter((d) => match(d.name))
    // 每个文件统一带上 bucket，预览/播放等下游不再依赖调用方补参
    let files = data.files.filter((f) => match(f.name)).map((f) => ({ ...f, bucket }))
    if (sort === 'size') files = [...files].sort((a, b) => b.size - a.size)
    else if (sort === 'time') files = [...files].sort((a, b) => new Date(b.modified) - new Date(a.modified))
    else {
      dirs.sort((a, b) => a.name.localeCompare(b.name))
      files.sort((a, b) => a.name.localeCompare(b.name))
    }
    return { dirs, files }
  }, [data, search, sort])

  const allPaths = useMemo(
    () => [...items.dirs.map((d) => d.path), ...items.files.map((f) => f.path)],
    [items]
  )
  const allSelected = allPaths.length > 0 && allPaths.every((p) => selected.has(p))
  const toggleSelect = (path) => {
    setSelected((s) => {
      const n = new Set(s)
      n.has(path) ? n.delete(path) : n.add(path)
      return n
    })
  }
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(allPaths))
  }

  const selectedItems = useMemo(() => {
    if (!data) return []
    const map = new Map()
    data.dirs.forEach((d) => map.set(d.path, { ...d, isDir: true }))
    data.files.forEach((f) => map.set(f.path, { ...f, isDir: false }))
    return [...selected].map((p) => map.get(p)).filter(Boolean)
  }, [data, selected])

  const askDelete = (items) => {
    const dirs = items.filter((i) => i.isDir)
    const files = items.filter((i) => !i.isDir)
    const label = [
      files.length ? `${files.length} 个文件` : '',
      dirs.length ? `${dirs.length} 个文件夹（含全部内容）` : '',
    ]
      .filter(Boolean)
      .join(' + ')
    setConfirm({
      title: '确认删除',
      message: `确定要删除 ${label} 吗？\n此操作不可恢复。`,
      okText: '删除',
      onOk: async () => {
        try {
          if (files.length) {
            for (let i = 0; i < files.length; i += 500) {
              await api('/api/delete-batch', {
                method: 'POST',
                body: JSON.stringify({ bucket, keys: files.slice(i, i + 500).map((f) => f.path) }),
              })
            }
          }
          if (dirs.length) {
            await api('/api/delete-tree', {
              method: 'POST',
              body: JSON.stringify({ bucket, prefixes: dirs.map((d) => d.path) }),
            })
          }
          toast('删除完成')
          setSelected(new Set())
          refresh()
        } catch (e) {
          if (e.message !== 'unauthorized') toast('删除失败：' + e.message, 'error')
        }
      },
    })
  }

  const doUpload = async (fileList) => {
    await startUpload(fileList, bucket, prefix)
    refresh()
  }

  const copyLink = async (f) => {
    const ok = await copyText(f.url)
    toast(ok ? '直链已复制' : '复制失败', ok ? 'info' : 'error')
  }

  // 音频文件直接进播放器队列（路由切换不断播）；视频带兄弟列表用于连续剧连播；zip 内的媒体仍走预览弹窗
  const openFile = (f) => {
    const cat = categoryOf(f.name)
    if (cat === 'audio') {
      const audioFiles = items.files.filter((x) => categoryOf(x.name) === 'audio')
      playFromList(audioFiles, f)
    } else if (cat === 'video') {
      setPreview({ mode: 'file', f, siblings: items.files.filter((x) => categoryOf(x.name) === 'video') })
    } else if (cat === 'image') {
      // 图片预览带同目录图片列表：查看器内可直接切换上一张/下一张
      setPreview({ mode: 'file', f, siblings: items.files.filter((x) => categoryOf(x.name) === 'image') })
    } else {
      setPreview({ mode: 'file', f })
    }
  }

  if (loading && !data) {
    return <div className="py-24 text-center text-[14px] text-ink2">加载中…</div>
  }
  if (error) {
    return <div className="py-24 text-center text-[14px] text-danger">加载失败：{error}</div>
  }
  if (!data) return null

  const empty = items.dirs.length === 0 && items.files.length === 0

  return (
    <div
      className="relative"
      onDragEnter={(e) => {
        if (![...e.dataTransfer.items].some((i) => i.kind === 'file')) return
        dragCounter.current++
        setDragOver(true)
      }}
      onDragLeave={() => {
        if (--dragCounter.current <= 0) {
          dragCounter.current = 0
          setDragOver(false)
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        dragCounter.current = 0
        setDragOver(false)
        if (e.dataTransfer.files.length) doUpload(e.dataTransfer.files)
      }}
    >
      {/* 面包屑 + 工具栏 */}
      <div className="mb-3 flex items-center gap-2">
        <Crumbs crumbs={data.crumbs} bucket={bucket} />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="input h-9 flex-1 min-w-[140px] py-0"
          placeholder="搜索当前目录…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="select h-9 py-0" value={sort} onChange={(e) => setSort(e.target.value)}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="btn-primary h-9" onClick={() => fileInput.current?.click()}>
          <UIcon name="upload" size={15} />
          上传
        </button>
        {caps?.offlineDownload && (
          <button
            className="btn-plain h-9"
            title="粘贴链接，服务器后台下载后转存到当前目录"
            onClick={() => {
              setDownloadTarget({ bucket, prefix })
              setDownloadModalOpen(true)
            }}
          >
            <UIcon name="download" size={15} />
            离线下载
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files.length) doUpload(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {data.truncated && (
        <div className="mb-2 flex items-center gap-1.5 text-[12px] text-ink2">
          <UIcon name="alert" size={13} />
          目录对象超过 1000 个，仅显示前 1000 项
        </div>
      )}

      {/* 文件列表 */}
      {empty ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center text-[14px] text-ink2">
          <FIcon type="folder" size={56} />
          <div className="mt-3">这个目录是空的</div>
          <div className="mt-1 text-[13px] text-ink2/70">拖拽文件到这里，或点击上方「上传」</div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="divide-y divide-line/70">
            {items.dirs.map((d) => (
              <DirRow
                key={d.path}
                d={d}
                selected={selected.has(d.path)}
                anySelected={selected.size > 0}
                onToggle={() => toggleSelect(d.path)}
                onOpen={() => navigate(bucket, d.path)}
                onRename={() => setRenameItem({ ...d, isDir: true })}
                onDelete={() => askDelete([{ ...d, isDir: true }])}
              />
            ))}
            {items.files.map((f) => (
              <FileRow
                key={f.path}
                f={f}
                selected={selected.has(f.path)}
                anySelected={selected.size > 0}
                onToggle={() => toggleSelect(f.path)}
                onOpen={() => openFile(f)}
                onCopy={() => copyLink(f)}
                onRename={() => setRenameItem({ ...f, isDir: false })}
                onDelete={() => askDelete([{ ...f, isDir: false }])}
              />
            ))}
          </div>
        </div>
      )}

      {/* 拖放遮罩 */}
      {dragOver && (
        <div className="fade-in pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft/80">
          <div className="flex items-center gap-2 text-[15px] font-medium text-accent">
            <UIcon name="upload" size={18} />
            松开上传到当前目录
          </div>
        </div>
      )}

      {/* 批量操作条 */}
      {selected.size > 0 && (
        <div
          className="pop-in fixed left-1/2 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-[#1e222b] py-2 pl-5 pr-2 text-white shadow-[0_10px_36px_rgba(0,0,0,.35)]"
          style={{ bottom: playerVisible ? 92 : 20 }}
        >
          <span className="text-[13px] font-medium">已选 {selected.size} 项</span>
          <span className="mx-1 h-4 w-px bg-white/20" />
          <button className="rounded-full px-3 py-1.5 text-[13px] hover:bg-white/10" onClick={toggleAll}>
            {allSelected ? '取消全选' : '全选'}
          </button>
          <button
            className="rounded-full px-3 py-1.5 text-[13px] hover:bg-white/10"
            onClick={() => {
              if (!selectedItems.some((i) => !i.isDir) && selectedItems.length) {
                // 只选了文件夹：move-tree 支持文件夹，不拦
              }
              setMoveItems(selectedItems)
            }}
          >
            移动
          </button>
          <button
            className="rounded-full bg-danger px-3 py-1.5 text-[13px] font-medium hover:brightness-110"
            onClick={() => askDelete(selectedItems)}
          >
            删除
          </button>
          <button
            className="icon-btn text-white/70 hover:bg-white/10 hover:text-white"
            onClick={() => setSelected(new Set())}
            title="取消选择"
          >
            <UIcon name="close" size={15} />
          </button>
        </div>
      )}

      {/* 弹层 */}
      {preview && (
        <Preview
          state={preview}
          bucket={bucket}
          onClose={() => setPreview(null)}
          onBack={() => setPreview((p) => (p.mode === 'zipEntry' ? { mode: 'zip', f: p.f, entries: p.entries, total: p.total, truncated: p.truncated } : null))}
          setPreview={setPreview}
          onSaved={refresh}
        />
      )}
      {confirm && <Confirm {...confirm} onClose={() => setConfirm(null)} />}
      {moveItems && (
        <MoveModal
          bucket={bucket}
          items={moveItems}
          currentPrefix={prefix}
          onClose={() => setMoveItems(null)}
          onDone={() => {
            setMoveItems(null)
            setSelected(new Set())
            refresh()
          }}
        />
      )}
      {renameItem && (
        <RenameModal
          bucket={bucket}
          item={renameItem}
          prefix={prefix}
          onClose={() => setRenameItem(null)}
          onDone={() => {
            setRenameItem(null)
            setSelected(new Set())
            refresh()
          }}
        />
      )}
    </div>
  )
}

function DirRow({ d, selected, anySelected, onToggle, onOpen, onRename, onDelete }) {
  return (
    <div
      className={`group flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors sm:px-4 ${
        selected ? 'bg-accent-soft' : 'hover:bg-bg'
      }`}
      onClick={onOpen}
    >
      <input
        type="checkbox"
        className={`row-chk shrink-0 ${selected || anySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        checked={selected}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggle}
        title="选择"
      />
      <FIcon type="folder" size={30} />
      <div className="min-w-0 flex-1 truncate text-[14px] font-medium">{d.name}</div>
      <div className="hidden shrink-0 items-center gap-1 sm:flex">
        <RowAction title="重命名" icon="edit" onClick={onRename} />
        <RowAction title="删除文件夹" icon="trash" onClick={onDelete} danger />
      </div>
    </div>
  )
}

function FileRow({ f, selected, anySelected, onToggle, onOpen, onCopy, onRename, onDelete }) {
  const type = iconType(f.name)
  return (
    <div
      className={`group flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors sm:px-4 ${
        selected ? 'bg-accent-soft' : 'hover:bg-bg'
      }`}
      onClick={onOpen}
    >
      <input
        type="checkbox"
        className={`row-chk shrink-0 ${selected || anySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        checked={selected}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggle}
        title="选择"
      />
      <FIcon type={type} size={30} />
      <div className="min-w-0 flex-1 truncate text-[14px]" title={f.name}>
        {f.name}
      </div>
      <div className="hidden w-24 shrink-0 text-right text-[12.5px] tabular-nums text-ink2 sm:block">{f.sizeText}</div>
      <div className="hidden w-32 shrink-0 text-right text-[12.5px] text-ink2/80 lg:block">{fmtTime(f.modified)}</div>
      <div className="flex shrink-0 items-center gap-0.5 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
        <RowAction title="复制直链" icon="copy" onClick={onCopy} />
        <RowAction title="重命名" icon="edit" onClick={onRename} />
        <RowAction title="删除文件" icon="trash" onClick={onDelete} danger />
      </div>
    </div>
  )
}
