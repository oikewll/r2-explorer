import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { fmtSize, fmtTime, iconType, categoryOf, copyText, isExtractable } from '../lib/format'
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
import CreateFolderModal from './CreateFolderModal'
import ExtractModal from './ExtractModal'
import SearchModal, { PENDING_OPEN } from './SearchModal'
import ContextMenu, { useCtxTrigger } from './ContextMenu'
import { DirTile, FileTile } from './GridView'
import QrModal from './QrModal'

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
  const uploadsVersion = useStore((s) => s.uploadsVersion)
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
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [extractItem, setExtractItem] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('r2x_view') || 'list')
  const [searching, setSearching] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null)
  const [qrItem, setQrItem] = useState(null) // 二维码弹窗：{ name, url, presigned }
  const fileInput = useRef(null)
  const dragCounter = useRef(0)

  const switchView = (m) => {
    setViewMode(m)
    localStorage.setItem('r2x_view', m)
  }

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

  // Ctrl/Cmd + K 唤起全局搜索
  useEffect(() => {
    const fn = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearching(true)
      }
    }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [])

  // 全局搜索跳转：落在目标目录后自动打开文件预览
  useEffect(() => {
    if (!data || searching) return
    const raw = sessionStorage.getItem(PENDING_OPEN)
    if (!raw) return
    try {
      const p = JSON.parse(raw)
      const dir = p.path.slice(0, p.path.lastIndexOf('/') + 1)
      if (p.bucket === bucket && dir === prefix) {
        sessionStorage.removeItem(PENDING_OPEN)
        const f = data.files.find((x) => x.path === p.path)
        if (f) {
          const cat = categoryOf(f.name)
          const withBucket = (x) => ({ ...x, bucket })
          const siblings = data.files
            .filter((x) => categoryOf(x.name) === cat && ['video', 'image'].includes(cat))
            .map(withBucket)
          setPreview({ mode: 'file', f: withBucket(f), ...(siblings.length > 1 ? { siblings } : {}) })
        }
      }
    } catch {}
  }, [data, bucket, prefix, searching])

  // 有下载任务结束（完成/失败）时刷新目录，新文件及时出现
  useEffect(() => {
    if (downloadsVersion > 0) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloadsVersion])

  // 手动重试的上传任务完成时刷新目录
  useEffect(() => {
    if (uploadsVersion > 0) refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadsVersion])

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
          let failCount = 0
          if (files.length) {
            for (let i = 0; i < files.length; i += 500) {
              const r = await api('/api/delete-batch', {
                method: 'POST',
                body: JSON.stringify({ bucket, keys: files.slice(i, i + 500).map((f) => f.path) }),
              })
              if (r && r.errors && r.errors.length) failCount += r.errors.length
            }
          }
          if (dirs.length) {
            // Worker 免费版每请求最多 50 个子请求，每个前缀至少要 1 次列取 + 1 次删除，
            // 按 10 个前缀一批分批调用，避免超限导致 500
            for (let i = 0; i < dirs.length; i += 10) {
              const r = await api('/api/delete-tree', {
                method: 'POST',
                body: JSON.stringify({
                  bucket,
                  prefixes: dirs.slice(i, i + 10).map((d) => d.path),
                }),
              })
              if (r && r.errors && r.errors.length) failCount += r.errors.length
            }
          }
          if (failCount) toast(`删除完成，${failCount} 项失败`, 'error')
          else toast('删除完成')
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

  // 生成二维码：内容就是文件直链（CDN 直链或 7 天预签名直链），手机扫码即可打开 / 下载
  const openQr = (f) => setQrItem({ name: f.name, url: f.url, presigned: f.presigned })

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

  // ---------- 右键 / 长按菜单 ----------
  // 单项菜单；若右键的项已在多选中，则展示批量操作
  const buildItemMenu = (item) => {
    if (selected.has(item.path) && selected.size > 1) {
      return [
        { icon: 'folderMove', label: `移动 ${selected.size} 项…`, onClick: () => setMoveItems(selectedItems) },
        { icon: 'check', label: allSelected ? '取消全选' : '全选', onClick: toggleAll },
        { sep: true },
        { icon: 'trash', label: `删除 ${selected.size} 项`, danger: true, onClick: () => askDelete(selectedItems) },
      ]
    }
    const cat = item.isDir ? null : categoryOf(item.name)
    const menu = []
    if (item.isDir) {
      menu.push({ icon: 'open', label: '打开', onClick: () => navigate(bucket, item.path) })
    } else {
      menu.push({ icon: 'open', label: '打开 / 预览', onClick: () => openFile(item) })
      if (cat === 'image') {
        menu.push({
          icon: 'edit',
          label: '编辑图片',
          onClick: () =>
            setPreview({
              mode: 'file',
              f: item,
              siblings: items.files.filter((x) => categoryOf(x.name) === 'image'),
              edit: true,
            }),
        })
      }
      menu.push({ icon: 'copy', label: '复制直链', onClick: () => copyLink(item) })
      menu.push({ icon: 'qr', label: '二维码 / 扫码打开', onClick: () => openQr(item) })
      // 在线解压：Node 版走后台任务（caps.extract）；Workers 版走前端驱动分批、zip 专用（caps.extractBatch）
      if ((caps?.extract || caps?.extractBatch) && isExtractable(item.name)) {
        menu.push({ icon: 'unpack', label: '在线解压…', onClick: () => setExtractItem(item) })
      }
    }
    menu.push({ icon: 'folderMove', label: '移动到…', onClick: () => setMoveItems([item]) })
    menu.push({ icon: 'edit', label: '重命名', onClick: () => setRenameItem(item) })
    menu.push({ sep: true })
    menu.push({
      icon: 'trash',
      label: item.isDir ? '删除文件夹' : '删除文件',
      danger: true,
      onClick: () => askDelete([item]),
    })
    return menu
  }

  const openItemCtx = (item) => (x, y) => {
    if (!selected.has(item.path)) setSelected(new Set([item.path]))
    setCtxMenu({ x, y, items: buildItemMenu(item) })
  }

  // 空白处菜单：上传 / 新建 / 全选 / 刷新
  const openBlankCtx = (x, y) => {
    setCtxMenu({
      x,
      y,
      items: [
        { icon: 'upload', label: '上传文件', onClick: () => fileInput.current?.click() },
        { icon: 'folderPlus', label: '新建文件夹', onClick: () => setCreatingFolder(true) },
        ...(caps?.offlineDownload
          ? [
              {
                icon: 'download',
                label: '离线下载',
                onClick: () => {
                  setDownloadTarget({ bucket, prefix })
                  setDownloadModalOpen(true)
                },
              },
            ]
          : []),
        { sep: true },
        { icon: 'check', label: allSelected ? '取消全选' : '全选', onClick: toggleAll },
        { icon: 'refresh', label: '刷新', onClick: refresh },
      ],
    })
  }

  // ---------- PC 鼠标框选（类似 Windows 资源管理器） ----------
  // 页面任意空白（内容区、两侧留白）和行/卡片上都可以按住左键拖拽框选；
  // 按住 Ctrl/Cmd 拖拽则在已有选择上追加；空白处单击清空选择。
  const listWrapRef = useRef(null)
  const [marquee, setMarquee] = useState(null) // 相对列表容器的 { x, y, w, h }
  const dragSel = useRef(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  useEffect(() => {
    // pointerdown 挂在 document 上，这样页面两侧留白也能起拖；
    // 只避开交互元素、顶栏和一切浮层（弹窗/播放器/菜单都是 fixed/modal-overlay）
    const onDown = (e) => {
      if (e.button !== 0 || e.pointerType !== 'mouse') return
      const t = e.target
      if (!t.closest) return
      if (t.closest('input, textarea, select, button, a, [contenteditable], header, .fixed, .modal-overlay')) return
      // 滚动条/页面根节点上不起拖（避免破坏滚动条拖拽）
      if (t === document.documentElement || t === document.body) return
      if (!listWrapRef.current) return
      dragSel.current = {
        sx: e.clientX,
        sy: e.clientY,
        cur: { x: e.clientX, y: e.clientY },
        base: e.ctrlKey || e.metaKey ? new Set(selectedRef.current) : null,
        active: false,
        prevUserSelect: document.body.style.userSelect,
      }
      document.body.style.userSelect = 'none'
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [])

  // Esc 取消选择（输入框聚焦时交给输入框自己处理）
  useEffect(() => {
    const fn = (e) => {
      if (e.key !== 'Escape') return
      const ae = document.activeElement
      if (ae && ae.closest && ae.closest('input, textarea, select, [contenteditable]')) return
      setSelected((s) => (s.size ? new Set() : s))
    }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [])

  useEffect(() => {
    // 从行/卡片上起拖并真正进入框选后，浏览器会补发一个 click 落在原行上，
    // 会误触“打开”，全局拦掉这一个
    const killNextClick = () => {
      const kill = (e) => {
        e.stopPropagation()
        e.preventDefault()
        window.removeEventListener('click', kill, true)
      }
      window.addEventListener('click', kill, true)
      setTimeout(() => window.removeEventListener('click', kill, true), 450)
    }

    const applySelection = (ds) => {
      const wrap = listWrapRef.current
      if (!wrap) return
      const wrapRect = wrap.getBoundingClientRect()
      const left = Math.min(ds.sx, ds.cur.x)
      const top = Math.min(ds.sy, ds.cur.y)
      const w = Math.abs(ds.cur.x - ds.sx)
      const h = Math.abs(ds.cur.y - ds.sy)
      setMarquee({ x: left - wrapRect.left, y: top - wrapRect.top, w, h })
      const mr = { left, top, right: left + w, bottom: top + h }
      const hit = new Set()
      wrap.querySelectorAll('[data-select-path]').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.left < mr.right && r.right > mr.left && r.top < mr.bottom && r.bottom > mr.top) {
          hit.add(el.dataset.selectPath)
        }
      })
      setSelected((prev) => {
        if (!ds.base) return hit
        const n = new Set(ds.base)
        hit.forEach((p) => n.add(p))
        return n
      })
    }

    // 指针贴近视口上下边缘时持续滚动，方便选跨屏的大量文件
    const autoScroll = () => {
      const ds = dragSel.current
      if (!ds || !ds.active) return
      const edge = 60
      if (ds.cur.y < edge) window.scrollBy(0, -Math.ceil((edge - ds.cur.y) / 3))
      else if (ds.cur.y > window.innerHeight - edge) window.scrollBy(0, Math.ceil((ds.cur.y - (window.innerHeight - edge)) / 3))
      applySelection(ds)
      ds.raf = requestAnimationFrame(autoScroll)
    }

    const onMove = (e) => {
      const ds = dragSel.current
      if (!ds) return
      ds.cur = { x: e.clientX, y: e.clientY }
      if (!ds.active) {
        if (Math.abs(ds.cur.x - ds.sx) < 4 && Math.abs(ds.cur.y - ds.sy) < 4) return
        ds.active = true
        killNextClick()
        ds.raf = requestAnimationFrame(autoScroll)
      }
      e.preventDefault()
      applySelection(ds)
    }
    const onUp = () => {
      const ds = dragSel.current
      dragSel.current = null
      setMarquee(null)
      if (!ds) return
      cancelAnimationFrame(ds.raf)
      document.body.style.userSelect = ds.prevUserSelect || ''
      if (!ds.active && !ds.base) {
        // 空白处单击：清空选择（Ctrl+单击不清，与 Windows 一致）
        setSelected(new Set())
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  // Ctrl/Cmd + A 全选（输入框内除外）
  useEffect(() => {
    const fn = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        const t = e.target
        if (t.closest && t.closest('input, textarea, select, [contenteditable]')) return
        e.preventDefault()
        setSelected(new Set(allPaths))
      }
    }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [allPaths])

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
      onContextMenu={(e) => {
        // 输入框/按钮/弹窗内保留浏览器原生菜单（二维码可右键保存），其余空白处弹自定义菜单
        const t = e.target
        if (t.closest && t.closest('input, textarea, select, a, button, [contenteditable], .modal-overlay')) return
        e.preventDefault()
        openBlankCtx(e.clientX, e.clientY)
      }}
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
        <div className="flex h-9 shrink-0 items-center overflow-hidden rounded-lg border border-line" role="group">
          <button
            className={`flex h-full w-9 items-center justify-center transition-colors ${
              viewMode === 'list' ? 'bg-accent-soft text-accent' : 'text-ink2 hover:bg-ink/[0.05] hover:text-ink'
            }`}
            title="列表视图"
            onClick={() => switchView('list')}
          >
            <UIcon name="list" size={15} />
          </button>
          <button
            className={`flex h-full w-9 items-center justify-center transition-colors ${
              viewMode === 'grid' ? 'bg-accent-soft text-accent' : 'text-ink2 hover:bg-ink/[0.05] hover:text-ink'
            }`}
            title="网格视图（图片/视频显示缩略图）"
            onClick={() => switchView('grid')}
          >
            <UIcon name="grid" size={15} />
          </button>
        </div>
        <button className="btn-plain h-9" title="全局搜索（Ctrl+K）" onClick={() => setSearching(true)}>
          <UIcon name="search" size={15} />
          全局搜索
        </button>
        <button className="btn-plain h-9" onClick={() => setCreatingFolder(true)}>
          <UIcon name="folderPlus" size={15} />
          新建文件夹
        </button>
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

      {/* 文件列表（PC 支持鼠标左键框选，页面空白处亦可起拖） */}
      <div ref={listWrapRef} className="relative">
        {empty ? (
          <div className="card flex flex-col items-center px-6 py-16 text-center text-[14px] text-ink2">
            <FIcon type="folder" size={56} />
            <div className="mt-3">这个目录是空的</div>
            <div className="mt-1 text-[13px] text-ink2/70">拖拽文件到这里，或点击上方「上传」</div>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
            {items.dirs.map((d) => (
              <DirTile
                key={d.path}
                d={d}
                selected={selected.has(d.path)}
                anySelected={selected.size > 0}
                onToggle={() => toggleSelect(d.path)}
                onOpen={() => navigate(bucket, d.path)}
                onRename={() => setRenameItem({ ...d, isDir: true })}
                onDelete={() => askDelete([{ ...d, isDir: true }])}
                onCtxMenu={openItemCtx({ ...d, isDir: true })}
              />
            ))}
            {items.files.map((f) => (
              <FileTile
                key={f.path}
                f={{ ...f, _iconType: iconType(f.name) }}
                selected={selected.has(f.path)}
                anySelected={selected.size > 0}
                onToggle={() => toggleSelect(f.path)}
                onOpen={() => openFile(f)}
                onCopy={() => copyLink(f)}
                onQr={() => openQr(f)}
                onRename={() => setRenameItem({ ...f, isDir: false })}
                onDelete={() => askDelete([{ ...f, isDir: false }])}
                onCtxMenu={openItemCtx(f)}
              />
            ))}
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
                  onCtxMenu={openItemCtx({ ...d, isDir: true })}
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
                  onQr={() => openQr(f)}
                  onRename={() => setRenameItem({ ...f, isDir: false })}
                  onDelete={() => askDelete([{ ...f, isDir: false }])}
                  onCtxMenu={openItemCtx(f)}
                />
              ))}
            </div>
          </div>
        )}
        {/* 框选矩形 */}
        {marquee && (
          <div
            className="pointer-events-none absolute z-30 rounded-sm border border-accent bg-accent/20"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}
      </div>

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
          onQr={(item) => setQrItem(item)}
          qrOpen={!!qrItem}
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
      {creatingFolder && (
        <CreateFolderModal
          bucket={bucket}
          prefix={prefix}
          onClose={() => setCreatingFolder(false)}
          onDone={() => {
            setCreatingFolder(false)
            refresh()
          }}
        />
      )}
      {extractItem && (
        <ExtractModal
          bucket={bucket}
          file={extractItem}
          prefix={prefix}
          onClose={() => setExtractItem(null)}
          onDone={refresh}
        />
      )}
      {searching && <SearchModal bucket={bucket} onClose={() => setSearching(false)} />}
      {qrItem && <QrModal item={qrItem} onClose={() => setQrItem(null)} />}

      {/* 右键 / 长按菜单 */}
      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
    </div>
  )
}

function DirRow({ d, selected, anySelected, onToggle, onOpen, onRename, onDelete, onCtxMenu }) {
  const ctx = useCtxTrigger(onCtxMenu)
  return (
    <div
      {...ctx}
      data-select-path={d.path}
      className={`ctx-target group flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors sm:px-4 ${
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

function FileRow({ f, selected, anySelected, onToggle, onOpen, onCopy, onQr, onRename, onDelete, onCtxMenu }) {
  const ctx = useCtxTrigger(onCtxMenu)
  const type = iconType(f.name)
  return (
    <div
      {...ctx}
      data-select-path={f.path}
      className={`ctx-target group flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors sm:px-4 ${
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
        <RowAction title="生成二维码（手机扫码打开）" icon="qr" onClick={onQr} />
        <RowAction title="重命名" icon="edit" onClick={onRename} />
        <RowAction title="删除文件" icon="trash" onClick={onDelete} danger />
      </div>
    </div>
  )
}
