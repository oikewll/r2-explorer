import { useEffect, useRef, useState } from 'react'
import { fmtSize } from '../lib/format'
import { readExif } from '../lib/exif'
import { UIcon } from './icons'
import ImageEditor from './ImageEditor'

const MIN_SCALE = 0.15
const MAX_SCALE = 12
const ALPHA_EXT = new Set(['png', 'webp', 'gif', 'svg', 'ico', 'avif'])

function ext(name) {
  return (name.split('.').pop() || '').toLowerCase()
}

// 图片查看器：
// - 缩放：滚轮（以光标为中心）/ 双击 / 按钮 / 键盘 +/-；拖拽平移；移动端单指拖动 + 双指捏合
// - 旋转/翻转（仅查看）；适应窗口 / 100%；文件夹内上一张/下一张（←/→）
// - 透明图棋盘格底、GIF 暂停/播放（当前帧定格）、EXIF 信息面板、进入编辑器
function TBtn({ icon, title, onClick, active }) {
  return (
    <button
      title={title}
      className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
        active ? 'bg-white/20 text-white' : 'text-white/75 hover:bg-white/10 hover:text-white'
      }`}
      onClick={onClick}
    >
      <UIcon name={icon} size={16} />
    </button>
  )
}

const Sep = () => <span className="mx-1 h-4 w-px shrink-0 bg-white/20" />

export default function ImageViewer({ f, url, siblings = [], setPreview, onSaved, canEdit = false, autoEdit = false }) {
  const boxRef = useRef(null)
  const imgRef = useRef(null)
  const gifRef = useRef(null)
  const stRef = useRef({ scale: 1, offset: { x: 0, y: 0 } })
  const exifTried = useRef(false)

  const [nat, setNat] = useState({ w: 0, h: 0 })
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [rot, setRot] = useState(0)
  const [flipH, setFlipH] = useState(false)
  const [flipV, setFlipV] = useState(false)
  const [hasAlpha, setHasAlpha] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [exif, setExif] = useState(null)
  const [editing, setEditing] = useState(autoEdit) // 右键菜单「编辑图片」进来时直接进编辑器
  const [gifPaused, setGifPaused] = useState(false)

  const isGif = ext(f.name) === 'gif'
  const idx = siblings.findIndex((s) => s.path === f.path)
  const canNav = siblings.length > 1 && idx >= 0

  // 切换图片时重置视图
  useEffect(() => {
    stRef.current = { scale: 1, offset: { x: 0, y: 0 } }
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setRot(0)
    setFlipH(false)
    setFlipV(false)
    setGifPaused(false)
    setHasAlpha(false)
    setExif(null)
    setInfoOpen(false)
    exifTried.current = false
    setNat({ w: 0, h: 0 })
  }, [f.path])

  // 容器尺寸跟踪（fit/100%/旋转补偿都依赖它）
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const fit = () => {
    if (!nat.w || !box.w) return
    // 内部小工具函数：正 transform 下图片未占满可用区域时按内容计算
    const s0 = Math.min(box.w / nat.w, box.h / nat.h)
    stRef.current = { scale: 1, offset: { x: 0, y: 0 } }
    setScale(1)
    setOffset({ x: 0, y: 0 })
    return s0
  }

  const fit100 = () => {
    if (!nat.w || !box.w) return
    const s0 = Math.min(box.w / nat.w, box.h / nat.h)
    const cs = rot % 180 ? Math.min(1, box.w / (nat.h * s0), box.h / (nat.w * s0)) : 1
    const sc = Math.min(MAX_SCALE, 1 / (s0 * cs))
    stRef.current = { scale: sc, offset: { x: 0, y: 0 } }
    setScale(sc)
    setOffset({ x: 0, y: 0 })
  }

  const rotate = (dir) => {
    setRot((r) => (r + dir + 360) % 360)
    stRef.current = { ...stRef.current, offset: { x: 0, y: 0 } }
    setOffset({ x: 0, y: 0 })
  }

  // 以某屏幕坐标为中心缩放（u = 坐标相对容器中心的向量）
  const zoomAt = (clientX, clientY, factor) => {
    if (!nat.w) return
    const el = boxRef.current
    if (!el) return
    const { scale: sc, offset: o } = stRef.current
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, sc * factor))
    const k = next / sc
    if (k === 1) return
    const rect = el.getBoundingClientRect()
    const ux = clientX - (rect.left + rect.width / 2)
    const uy = clientY - (rect.top + rect.height / 2)
    const no = { x: ux - k * (ux - o.x), y: uy - k * (uy - o.y) }
    stRef.current = { scale: next, offset: no }
    setScale(next)
    setOffset(no)
  }

  const zoomCenter = (factor) => {
    const el = boxRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  const clampOffset = (o, sc) => {
    if (!nat.w || !box.w) return o
    const s0 = Math.min(box.w / nat.w, box.h / nat.h)
    const cs = rot % 180 ? Math.min(1, box.w / (nat.h * s0), box.h / (nat.w * s0)) : 1
    const eff = sc * cs
    const fw = nat.w * s0
    const fh = nat.h * s0
    const vw = ((rot % 180 ? fh : fw) * eff - box.w) / 2
    const vh = ((rot % 180 ? fw : fh) * eff - box.h) / 2
    return {
      x: Math.min(Math.max(o.x, -Math.max(0, vw)), Math.max(0, vw)),
      y: Math.min(Math.max(o.y, -Math.max(0, vh)), Math.max(0, vh)),
    }
  }

  // 滚轮缩放（React 的 onWheel 是 passive 的，必须原生监听才能 preventDefault）
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const fn = (e) => {
      e.preventDefault()
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0022))
    }
    el.addEventListener('wheel', fn, { passive: false })
    return () => el.removeEventListener('wheel', fn)
  }, [nat.w, rot])

  // 拖拽平移 + 双指捏合
  const pointers = useRef(new Map())
  const gesture = useRef(null)

  const onPointerDown = (e) => {
    if (editing) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    e.currentTarget.setPointerCapture(e.pointerId)
    if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()]
      gesture.current = {
        type: 'pinch',
        dist0: Math.hypot(p1.x - p2.x, p1.y - p2.y),
        mid0: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        start: { ...stRef.current },
      }
    } else if (pointers.current.size === 1) {
      gesture.current = { type: 'pan', px: e.clientX, py: e.clientY, start: { ...stRef.current } }
    }
  }

  const onPointerMove = (e) => {
    const g = gesture.current
    if (!g || editing) return
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (g.type === 'pan' && pointers.current.size === 1) {
      const no = clampOffset(
        { x: g.start.offset.x + (e.clientX - g.px), y: g.start.offset.y + (e.clientY - g.py) },
        g.start.scale
      )
      stRef.current = { ...stRef.current, offset: no }
      setOffset(no)
    } else if (g.type === 'pinch' && pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()]
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y)
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
      const k = Math.min(MAX_SCALE / g.start.scale, Math.max(MIN_SCALE / g.start.scale, dist / (g.dist0 || 1)))
      const el = boxRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const ux = mid.x - (rect.left + rect.width / 2)
      const uy = mid.y - (rect.top + rect.height / 2)
      const no = {
        x: ux - k * (ux - g.start.offset.x),
        y: uy - k * (uy - g.start.offset.y),
      }
      const sc = Math.min(MAX_SCALE, Math.max(MIN_SCALE, g.start.scale * k))
      stRef.current = { scale: sc, offset: no }
      setScale(sc)
      setOffset(no)
    }
  }

  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0) gesture.current = null
    else if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()]
      gesture.current = { type: 'pan', px: p.x, py: p.y, start: { ...stRef.current } }
    }
  }

  const onDoubleClick = (e) => {
    if (editing) return
    if (stRef.current.scale > 1.05) fit()
    else zoomAt(e.clientX, e.clientY, 2.5)
  }

  // 文件夹内切换
  const go = (dir) => {
    if (!canNav) return
    const next = siblings[(idx + dir + siblings.length) % siblings.length]
    setPreview({ mode: 'file', f: next, siblings })
  }

  // 键盘快捷键
  useEffect(() => {
    if (editing) return
    const fn = (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === '+' || e.key === '=') zoomCenter(1.25)
      else if (e.key === '-') zoomCenter(0.8)
      else if (e.key === '0') fit()
      else if (e.key.toLowerCase() === 'i') setInfoOpen((v) => !v)
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [editing, canNav, idx, siblings, nat.w, rot])

  // EXIF（首次打开信息面板时拉取）
  useEffect(() => {
    if (!infoOpen || exifTried.current) return
    exifTried.current = true
    readExif(url).then(setExif)
  }, [infoOpen, url])

  const onImgLoad = (e) => {
    const img = e.target
    setNat({ w: img.naturalWidth, h: img.naturalHeight })
    // 透明检测（跨域画布会抛错，降级为不显示棋盘格）
    try {
      if (ALPHA_EXT.has(ext(f.name))) {
        const s = Math.min(1, 64 / Math.max(img.naturalWidth, img.naturalHeight))
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(img.naturalWidth * s))
        c.height = Math.max(1, Math.round(img.naturalHeight * s))
        const ctx = c.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, c.width, c.height)
        const d = ctx.getImageData(0, 0, c.width, c.height).data
        for (let i = 3; i < d.length; i += 4) {
          if (d[i] < 250) {
            setHasAlpha(true)
            break
          }
        }
      }
    } catch {}
  }

  // GIF 暂停：把当前帧定格到 canvas
  const toggleGif = () => {
    const img = imgRef.current
    const c = gifRef.current
    if (!img || !c) return
    if (!gifPaused) {
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      try {
        c.getContext('2d').drawImage(img, 0, 0)
      } catch {}
    }
    setGifPaused(!gifPaused)
  }

  // 变换参数
  const s0 = nat.w && box.w ? Math.min(box.w / nat.w, box.h / nat.h) : 1
  const cs = nat.w && box.w && rot % 180 ? Math.min(1, box.w / (nat.h * s0), box.h / (nat.w * s0)) : 1
  const eff = scale * cs
  const pct = Math.round(eff * 100)
  const imgTransform = `translate(${offset.x}px, ${offset.y}px) scale(${eff}) rotate(${rot}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})`
  const fd = nat.w && box.w ? { fw: nat.w * s0, fh: nat.h * s0 } : null

  return (
    <div
      ref={boxRef}
      className={`relative flex h-full w-full items-center justify-center overflow-hidden ${
        hasAlpha ? 'img-checker' : ''
      }`}
    >
      <img
        ref={imgRef}
        src={url}
        alt=""
        draggable={false}
        className="max-h-full max-w-full object-contain"
        style={{ transform: imgTransform, cursor: eff > 1.001 ? (gesture.current ? 'grabbing' : 'grab') : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onLoad={onImgLoad}
      />
      {/* GIF 定格帧（与 img 同变换、同尺寸覆盖；常驻渲染以便首次暂停时能取到 ref） */}
      {isGif && fd && (
        <canvas
          ref={gifRef}
          className="absolute left-1/2 top-1/2"
          style={{
            width: fd.fw,
            height: fd.fh,
            transform: `translate(-50%, -50%) ${imgTransform}`,
            display: gifPaused ? 'block' : 'none',
          }}
        />
      )}

      {/* 上一张 / 下一张 */}
      {canNav && (
        <>
          <button
            className="absolute left-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/80 backdrop-blur transition hover:bg-black/65 hover:text-white"
            title="上一张（←）"
            onClick={() => go(-1)}
          >
            <UIcon name="prev" size={17} />
          </button>
          <button
            className="absolute right-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white/80 backdrop-blur transition hover:bg-black/65 hover:text-white"
            title="下一张（→）"
            onClick={() => go(1)}
          >
            <UIcon name="next" size={17} />
          </button>
        </>
      )}

      {/* 信息面板 */}
      {infoOpen && (
        <div className="absolute bottom-16 left-3 z-10 w-56 rounded-xl bg-black/70 p-3.5 text-[12.5px] leading-relaxed text-white/90 shadow-xl backdrop-blur">
          <div className="mb-1.5 text-[13px] font-semibold text-white">图片信息</div>
          <Row k="尺寸" v={nat.w && nat.h ? `${nat.w} × ${nat.h}` : '…'} />
          <Row k="格式" v={ext(f.name).toUpperCase()} />
          <Row k="大小" v={fmtSize(f.size)} />
          {exif && (
            <>
              {(exif.make || exif.model) && <Row k="相机" v={[exif.make, exif.model].filter(Boolean).join(' ')} />}
              {(exif.dateTimeOriginal || exif.dateTime) && <Row k="拍摄时间" v={exif.dateTimeOriginal || exif.dateTime} />}
              {exif.exposure && <Row k="快门" v={exif.exposure} />}
              {exif.fnumber && <Row k="光圈" v={exif.fnumber} />}
              {exif.iso && <Row k="感光度" v={exif.iso} />}
              {exif.focal && <Row k="焦距" v={exif.focal} />}
            </>
          )}
        </div>
      )}

      {/* 底部工具栏 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-3">
        <div className="pointer-events-auto flex items-center rounded-full bg-black/65 py-1 pl-2 pr-1.5 text-white shadow-lg backdrop-blur">
          {canNav && (
            <span className="px-2 text-[12.5px] tabular-nums text-white/70">
              {idx + 1} / {siblings.length}
            </span>
          )}
          <TBtn icon="zoomOut" title="缩小（-）" onClick={() => zoomCenter(0.8)} />
          <button
            className="w-12 text-center text-[12px] tabular-nums text-white/80 hover:text-white"
            title="适应窗口（0）"
            onClick={fit}
          >
            {pct}%
          </button>
          <TBtn icon="zoomIn" title="放大（+）" onClick={() => zoomCenter(1.25)} />
          <button
            className="shrink-0 rounded-full px-1.5 text-[11.5px] font-medium text-white/80 hover:text-white"
            title="按原始尺寸显示（100%）"
            onClick={fit100}
          >
            1:1
          </button>
          <Sep />
          <TBtn icon="rotateCcw" title="向左旋转" onClick={() => rotate(-90)} />
          <TBtn icon="rotateCw" title="向右旋转" onClick={() => rotate(90)} />
          <TBtn icon="flipH" title="水平翻转" active={flipH} onClick={() => setFlipH((v) => !v)} />
          <TBtn icon="flipV" title="垂直翻转" active={flipV} onClick={() => setFlipV((v) => !v)} />
          {isGif && (
            <>
              <Sep />
              <TBtn icon={gifPaused ? 'play' : 'pause'} title={gifPaused ? '播放动图' : '暂停动图'} onClick={toggleGif} />
            </>
          )}
          <Sep />
          <TBtn icon="info" title="图片信息（i）" active={infoOpen} onClick={() => setInfoOpen((v) => !v)} />
          {canEdit && (
            <TBtn icon="edit" title="编辑图片（另存为新文件）" onClick={() => setEditing(true)} />
          )}
        </div>
      </div>

      {/* 编辑器 */}
      {editing && <ImageEditor f={f} url={url} onClose={() => setEditing(false)} onSaved={onSaved} />}
    </div>
  )
}

function Row({ k, v }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-white/50">{k}</span>
      <span className="min-w-0 truncate text-right" title={String(v)}>
        {v}
      </span>
    </div>
  )
}
