import { useEffect, useRef, useState } from 'react'
import { requestThumb, canThumb } from '../lib/thumbs'
import { fmtTime } from '../lib/format'
import { FIcon, UIcon } from './icons'

const rawUrl = (f) => '/api/raw?bucket=' + encodeURIComponent(f.bucket) + '&key=' + encodeURIComponent(f.path)

// 进入视口后再开始生成缩略图（IntersectionObserver，一次性）
function useInView(ref) {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || inView) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setInView(true)
          io.disconnect()
        }
      },
      { rootMargin: '300px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [inView])
  return inView
}

function ImageThumb({ f }) {
  const ref = useRef(null)
  const inView = useInView(ref)
  const [url, setUrl] = useState(null)
  const [failed, setFailed] = useState(false)
  const requested = useRef(false)
  useEffect(() => {
    if (!inView || requested.current) return
    requested.current = true
    let own = null
    const cancel = requestThumb(f, (u) => {
      if (u) {
        own = u
        setUrl(u)
      } else setFailed(true)
    })
    return () => {
      cancel()
      if (own) URL.revokeObjectURL(own)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView])
  return (
    <div ref={ref} className="flex h-full w-full items-center justify-center">
      {failed ? (
        <FIcon type="image" size={34} />
      ) : url ? (
        <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <div className="h-full w-full animate-pulse bg-ink/[0.04]" />
      )}
    </div>
  )
}

// 视频直接用 <video preload="metadata">：浏览器只按 Range 拉取元数据和首帧字节，
// loadedmetadata 后 seek 到前段拿一帧画面，不用下载整个视频。
// 注意：后台标签页里 Chrome 会暂停媒体加载，画不出帧只显示播放角标，属正常降级。
function VideoThumb({ f }) {
  const ref = useRef(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const onMeta = () => {
      try {
        v.currentTime = Math.min((v.duration || 2) * 0.1, 5)
      } catch {}
    }
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('error', () => setFailed(true))
    return () => v.removeEventListener('loadedmetadata', onMeta)
  }, [])
  if (failed) return <FIcon type="video" size={36} />
  return (
    <video
      ref={ref}
      src={rawUrl(f)}
      preload="metadata"
      muted
      playsInline
      className="h-full w-full object-cover"
      draggable={false}
    />
  )
}

function Tile({ f, isDir, selected, anySelected, onToggle, onOpen, onRename, onDelete, children, meta }) {
  return (
    <div
      className={`group relative cursor-pointer overflow-hidden rounded-xl border transition-all ${
        selected ? 'border-accent bg-accent-soft ring-1 ring-accent' : 'border-line bg-bg hover:border-accent/40 hover:shadow-sm'
      }`}
      onClick={onOpen}
    >
      <input
        type="checkbox"
        className={`row-chk absolute left-2 top-2 z-10 shrink-0 ${
          selected || anySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
        checked={selected}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggle}
        title="选择"
      />
      {/* 右上角操作 */}
      <div className="absolute right-1.5 top-1.5 z-10 flex gap-0.5 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
        {!isDir && (
          <button
            title="重命名"
            className="rounded-lg bg-bg/85 p-1.5 text-ink2 backdrop-blur transition hover:bg-ink/[0.08] hover:text-ink"
            onClick={(e) => {
              e.stopPropagation()
              onRename()
            }}
          >
            <UIcon name="edit" size={14} />
          </button>
        )}
        <button
          title={isDir ? '删除文件夹' : '删除文件'}
          className="rounded-lg bg-bg/85 p-1.5 text-ink2 backdrop-blur transition hover:bg-danger-soft hover:text-danger"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <UIcon name="trash" size={14} />
        </button>
      </div>
      {/* 缩略图区 */}
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-ink/[0.03]">{children}</div>
      {/* 名称区 */}
      <div className="border-t border-line/70 px-2.5 py-2">
        <div className="truncate text-[12.5px] font-medium" title={f.name}>
          {f.name}
        </div>
        {meta && <div className="mt-0.5 truncate text-[11px] tabular-nums text-ink2/80">{meta}</div>}
      </div>
    </div>
  )
}

export function DirTile({ d, selected, anySelected, onToggle, onOpen, onRename, onDelete }) {
  return (
    <Tile
      f={d}
      isDir
      selected={selected}
      anySelected={anySelected}
      onToggle={onToggle}
      onOpen={onOpen}
      onRename={onRename}
      onDelete={onDelete}
    >
      <FIcon type="folder" size={42} />
    </Tile>
  )
}

export function FileTile({ f, selected, anySelected, onToggle, onOpen, onRename, onDelete }) {
  const cat = (f.name.split('.').pop() || '').toLowerCase()
  const isVideo = ['mp4', 'webm', 'm4v', 'mov'].includes(cat)
  let thumb
  if (canThumb(f)) thumb = <ImageThumb f={f} />
  else if (isVideo) thumb = <VideoThumb f={f} />
  else thumb = <FIcon type={f._iconType} size={36} />

  const meta = f.sizeText + (isVideo || canThumb(f) ? '' : ' · ' + fmtTime(f.modified))
  return (
    <Tile
      f={f}
      selected={selected}
      anySelected={anySelected}
      onToggle={onToggle}
      onOpen={onOpen}
      onRename={onRename}
      onDelete={onDelete}
      meta={meta}
    >
      {thumb}
      {isVideo && (
        <div className="absolute bottom-1.5 left-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur">
          <UIcon name="play" size={11} />
        </div>
      )}
    </Tile>
  )
}
