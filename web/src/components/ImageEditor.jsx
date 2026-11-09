import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { UIcon } from './icons'

// 图片编辑器（另存制，不覆盖原图）：
// - 裁剪：8 向手柄 + 空白处拖出新框 + 比例预设（自由/1:1/4:3/3:4/16:9/9:16）
// - 旋转 / 翻转；亮度 / 对比度 / 饱和度（CSS 滤镜实时预览，导出时烘焙进像素）
// - 导出后可「下载到本地」或「保存到当前目录」（POST /api/upload，新文件名可编辑，同名会覆盖）
// 画布上限 4096px：超过的原图按比例缩入画布编辑（超大图导出分辨率以画布为准）

const MAX_DIM = 4096
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

function ext(name) {
  return (name.split('.').pop() || '').toLowerCase()
}

function filterStr(adj) {
  const parts = []
  if (adj.b) parts.push(`brightness(${1 + adj.b / 100})`)
  if (adj.c) parts.push(`contrast(${1 + adj.c / 100})`)
  if (adj.s) parts.push(`saturate(${1 + adj.s / 100})`)
  return parts.join(' ')
}

// ctx.filter 不可用时的像素级降级（老 Safari）
function pixelAdjust(ctx, w, h, adj) {
  const br = 1 + adj.b / 100
  const cr = 1 + adj.c / 100
  const sr = 1 + adj.s / 100
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    for (let j = 0; j < 3; j++) {
      let v = d[i + j] * br
      v = (v - 128) * cr + 128
      d[i + j] = v
    }
    const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    for (let j = 0; j < 3; j++) {
      d[i + j] = clamp(lum + (d[i + j] - lum) * sr, 0, 255)
    }
  }
  ctx.putImageData(img, 0, 0)
}

const RATIOS = [
  { label: '自由', v: 0 },
  { label: '1:1', v: 1 },
  { label: '4:3', v: 4 / 3 },
  { label: '3:4', v: 3 / 4 },
  { label: '16:9', v: 16 / 9 },
  { label: '9:16', v: 9 / 16 },
]

export default function ImageEditor({ f, url, onClose, onSaved }) {
  const toast = useStore((s) => s.toast)
  const imgRef = useRef(null)
  const viewRef = useRef(null)
  const boxRef = useRef(null)
  const overlayRef = useRef(null)
  const dragRef = useRef(null)

  const [status, setStatus] = useState('loading') // loading | ready | error
  const [nat, setNat] = useState({ w: 0, h: 0 })
  const [corsOk, setCorsOk] = useState(true)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [editDims, setEditDims] = useState(null) // { cw, ch } 画布（旋转烘焙后）尺寸
  const [rot, setRot] = useState(0)
  const [flipH, setFlipH] = useState(false)
  const [flipV, setFlipV] = useState(false)
  const [adj, setAdj] = useState({ b: 0, c: 0, s: 0 })
  const [tool, setTool] = useState(null) // null | crop | adjust
  const [crop, setCrop] = useState(null) // 归一化 {x,y,w,h}，null = 全图
  const [ratio, setRatio] = useState(0)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)

  const srcExt = ext(f.name)
  const outExt = srcExt === 'jpg' || srcExt === 'jpeg' ? 'jpg' : 'png'
  const effCrop = crop || { x: 0, y: 0, w: 1, h: 1 }
  const outW = editDims ? Math.max(1, Math.round(effCrop.w * editDims.cw)) : 0
  const outH = editDims ? Math.max(1, Math.round(effCrop.h * editDims.ch)) : 0

  // 加载原图（优先带 CORS，失败降级为仅可显示）
  useEffect(() => {
    let alive = true
    setStatus('loading')
    const done = (img, ok) => {
      if (!alive) return
      imgRef.current = img
      setCorsOk(ok)
      setNat({ w: img.naturalWidth, h: img.naturalHeight })
      setStatus('ready')
    }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => done(img, true)
    img.onerror = () => {
      const img2 = new Image()
      img2.onload = () => done(img2, false)
      img2.onerror = () => alive && setStatus('error')
      img2.src = url
    }
    img.src = url
    return () => {
      alive = false
    }
  }, [url])

  // 旋转/翻转变化时：重算画布尺寸（超限缩入 MAX_DIM）并清空裁剪框
  useEffect(() => {
    if (status !== 'ready' || !nat.w) return
    setCrop(null)
    const rw = rot % 180 ? nat.h : nat.w
    const rh = rot % 180 ? nat.w : nat.h
    const k = Math.min(1, MAX_DIM / rw, MAX_DIM / rh)
    setEditDims({ cw: Math.max(1, Math.round(rw * k)), ch: Math.max(1, Math.round(rh * k)) })
  }, [status, nat, rot, flipH, flipV])

  // 画布绘制（editDims 变更触发重渲染后执行，此时 canvas 已挂载）
  useEffect(() => {
    if (status !== 'ready' || !editDims || !nat.w) return
    const img = imgRef.current
    const v = viewRef.current
    if (!img || !v) return
    const rw = rot % 180 ? nat.h : nat.w
    const rh = rot % 180 ? nat.w : nat.h
    const k = Math.min(1, MAX_DIM / rw, MAX_DIM / rh)
    v.width = editDims.cw
    v.height = editDims.ch
    const ctx = v.getContext('2d')
    ctx.translate(editDims.cw / 2, editDims.ch / 2)
    ctx.rotate((rot * Math.PI) / 180)
    ctx.scale((flipH ? -1 : 1) * k, (flipV ? -1 : 1) * k)
    ctx.drawImage(img, -nat.w / 2, -nat.h / 2)
  }, [status, nat, rot, flipH, flipV, editDims])

  // Esc：先关保存面板，再关编辑器（window 捕获阶段拦截，避免把整个预览关掉）
  useEffect(() => {
    const fn = (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (saveOpen) setSaveOpen(false)
      else onClose()
    }
    window.addEventListener('keydown', fn, true)
    return () => window.removeEventListener('keydown', fn, true)
  }, [saveOpen, onClose])

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // 打开保存面板时给默认文件名
  useEffect(() => {
    if (saveOpen && !saveName) {
      const base = f.name.replace(/\.[^.]+$/, '')
      setSaveName(`${base}_edited.${outExt}`)
    }
  }, [saveOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 裁剪交互 ----------
  const disp = editDims && box.w
    ? (() => {
        const pad = 24
        const s = Math.min((box.w - pad) / editDims.cw, (box.h - pad) / editDims.ch)
        return { w: Math.max(1, editDims.cw * s), h: Math.max(1, editDims.ch * s) }
      })()
    : null

  const onOverlayDown = (e, handle) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    e.stopPropagation()
    const rectPx = overlayRef.current.getBoundingClientRect()
    dragRef.current = {
      handle,
      px: e.clientX,
      py: e.clientY,
      start: effCrop,
      rectPx,
      ratio,
    }
    if (handle === 'new') {
      // 在空白处按下：以按点为锚拖出新框
      dragRef.current.start = {
        x: clamp((e.clientX - rectPx.left) / rectPx.width, 0, 1),
        y: clamp((e.clientY - rectPx.top) / rectPx.height, 0, 1),
        w: 0,
        h: 0,
      }
      dragRef.current.anchor = dragRef.current.start
    }
    overlayRef.current.setPointerCapture(e.pointerId)
  }

  const onOverlayMove = (e) => {
    const d = dragRef.current
    if (!d) return
    const dxn = (e.clientX - d.px) / d.rectPx.width
    const dyn = (e.clientY - d.py) / d.rectPx.height
    setCrop(applyDrag(d, dxn, dyn, editDims))
  }

  const onOverlayUp = () => {
    dragRef.current = null
  }

  const applyRatioPreset = (v) => {
    setRatio(v)
    if (!v || !editDims) return
    const { cw, ch } = editDims
    let w = cw
    let h = w / v
    if (h > ch) {
      h = ch
      w = h * v
    }
    setCrop({ x: (cw - w) / 2 / cw, y: (ch - h) / 2 / ch, w: w / cw, h: h / ch })
  }

  // ---------- 导出 / 保存 ----------
  const exportCanvas = () => {
    const src = viewRef.current
    const cr = effCrop
    const sx = Math.round(cr.x * src.width)
    const sy = Math.round(cr.y * src.height)
    const sw = Math.max(1, Math.round(cr.w * src.width))
    const sh = Math.max(1, Math.round(cr.h * src.height))
    const out = document.createElement('canvas')
    out.width = sw
    out.height = sh
    const ctx = out.getContext('2d')
    const fstr = filterStr(adj)
    const supportsFilter = 'filter' in ctx
    if (supportsFilter && fstr) ctx.filter = fstr
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh)
    if (!supportsFilter && fstr) pixelAdjust(ctx, sw, sh, adj)
    return out
  }

  const withBlob = async (fn) => {
    try {
      const out = exportCanvas()
      const type = outExt === 'jpg' ? 'image/jpeg' : 'image/png'
      const blob = await new Promise((resolve, reject) =>
        out.toBlob((b) => (b ? resolve(b) : reject(new Error('导出失败'))), type, 0.92)
      )
      await fn(blob)
    } catch (e) {
      toast(e?.message === 'unauthorized' ? '登录已过期' : '导出失败：图片源不允许跨域读取，请下载原图后处理', 'error')
    }
  }

  const download = () =>
    withBlob(async (blob) => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = saveName || `edited.${outExt}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    })

  const doSave = () => {
    const name = saveName.trim()
    if (!name) return
    setSaving(true)
    const dir = f.path.slice(0, f.path.length - f.name.length)
    const key = dir + name
    withBlob(async (blob) => {
      await api(
        `/api/upload?bucket=${encodeURIComponent(f.bucket)}&key=${encodeURIComponent(key)}`,
        { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } }
      )
      toast(`已另存为 ${name}`)
      onSaved && onSaved({ bucket: f.bucket, path: key, name })
      setSaveOpen(false)
      onClose()
    }).finally(() => setSaving(false))
  }

  const fstr = filterStr(adj)

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#14161c] text-white">
      {/* 顶栏 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-white/10">
          <UIcon name="crop" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium" title={f.name}>
            编辑图片 · {f.name}
          </div>
          {editDims && (
            <div className="text-[11.5px] text-white/45">
              画布 {editDims.cw} × {editDims.ch}
              {nat.w && nat.w * nat.h > MAX_DIM * 0.98 && '（原图较大已缩入画布）'}
            </div>
          )}
        </div>
        {!corsOk && status === 'ready' && (
          <span className="hidden rounded-md bg-danger-soft px-2 py-1 text-[11.5px] text-danger sm:block">
            图源跨域受限，无法导出
          </span>
        )}
        <button
          className="flex h-9 w-9 items-center justify-center rounded-[10px] text-white/70 hover:bg-white/10 hover:text-white"
          onClick={onClose}
          title="关闭编辑器"
        >
          <UIcon name="close" size={17} />
        </button>
      </div>

      {/* 画布区 */}
      <div ref={boxRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {status === 'loading' && (
          <div className="flex flex-col items-center gap-3 text-white/60">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-white/80" />
            <span className="text-[13px]">正在加载原图…</span>
          </div>
        )}
        {status === 'error' && (
          <div className="flex flex-col items-center gap-3 px-8 text-center text-white/60">
            <UIcon name="alert" size={36} />
            <span className="text-[13.5px]">图片加载失败，无法编辑</span>
          </div>
        )}
        {status === 'ready' && editDims && disp && (
          <div className="relative overflow-hidden shadow-2xl" style={{ width: disp.w, height: disp.h }}>
            <canvas ref={viewRef} className="block h-full w-full" style={{ filter: fstr || undefined }} />
            {tool === 'crop' && (
              <div
                ref={overlayRef}
                className="absolute inset-0 touch-none"
                style={{ cursor: 'crosshair' }}
                onPointerDown={(e) => onOverlayDown(e, 'new')}
                onPointerMove={onOverlayMove}
                onPointerUp={onOverlayUp}
                onPointerCancel={onOverlayUp}
              >
                {/* 选框 */}
                <div
                  className="absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
                  style={{
                    left: `${effCrop.x * 100}%`,
                    top: `${effCrop.y * 100}%`,
                    width: `${effCrop.w * 100}%`,
                    height: `${effCrop.h * 100}%`,
                    cursor: 'move',
                  }}
                  onPointerDown={(e) => onOverlayDown(e, 'move')}
                >
                  {/* 三分线 */}
                  <div className="pointer-events-none absolute inset-0">
                    <div className="absolute left-1/3 top-0 h-full w-px bg-white/35" />
                    <div className="absolute left-2/3 top-0 h-full w-px bg-white/35" />
                    <div className="absolute left-0 top-1/3 h-px w-full bg-white/35" />
                    <div className="absolute left-0 top-2/3 h-px w-full bg-white/35" />
                  </div>
                  {/* 尺寸角标 */}
                  <div className="pointer-events-none absolute -top-0.5 left-1/2 -translate-x-1/2 -translate-y-full rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
                    {outW} × {outH}
                  </div>
                </div>
                {/* 8 向手柄 */}
                {HANDLES.map((hd) => (
                  <div
                    key={hd}
                    className="absolute h-4 w-4 rounded-[3px] border-2 border-white bg-black/25"
                    style={handleStyle(hd, effCrop)}
                    onPointerDown={(e) => onOverlayDown(e, hd)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 工具栏 */}
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-t border-white/10 px-3 py-2">
        <TBtn icon="crop" title="裁剪" active={tool === 'crop'} onClick={() => setTool(tool === 'crop' ? null : 'crop')} />
        <TBtn icon="rotateCcw" title="向左旋转" onClick={() => setRot((r) => (r + 270) % 360)} />
        <TBtn icon="rotateCw" title="向右旋转" onClick={() => setRot((r) => (r + 90) % 360)} />
        <TBtn icon="flipH" title="水平翻转" active={flipH} onClick={() => setFlipH((v) => !v)} />
        <TBtn icon="flipV" title="垂直翻转" active={flipV} onClick={() => setFlipV((v) => !v)} />
        <TBtn
          icon="sliders"
          title="调整（亮度/对比度/饱和度）"
          active={tool === 'adjust'}
          onClick={() => setTool(tool === 'adjust' ? null : 'adjust')}
        />
        <span className="mx-1 h-4 w-px bg-white/20" />
        {tool === 'adjust' && (
          <TBtn
            icon="undo"
            title="重置调整"
            onClick={() => setAdj({ b: 0, c: 0, s: 0 })}
          />
        )}
        {tool === 'crop' && ratio > 0 && (
          <TBtn icon="undo" title="重置裁剪框为全图" onClick={() => setCrop(null)} />
        )}
        <span className="flex-1" />
        <button
          className="flex items-center gap-1.5 rounded-[10px] px-3 py-2 text-[13.5px] text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40"
          disabled={status !== 'ready'}
          onClick={download}
          title="把当前编辑结果下载到本地"
        >
          <UIcon name="download" size={15} />
          下载
        </button>
        <button
          className="flex items-center gap-1.5 rounded-[10px] bg-accent px-3.5 py-2 text-[13.5px] font-medium text-white shadow hover:brightness-110 disabled:opacity-40"
          disabled={status !== 'ready'}
          onClick={() => setSaveOpen(true)}
        >
          <UIcon name="save" size={15} />
          另存为
        </button>
      </div>

      {/* 裁剪比例条 */}
      {tool === 'crop' && (
        <div className="flex shrink-0 items-center justify-center gap-1.5 border-t border-white/10 px-3 py-2">
          {RATIOS.map((r) => (
            <button
              key={r.label}
              className={`rounded-full px-3 py-1 text-[12.5px] transition ${
                ratio === r.v ? 'bg-white/20 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white'
              }`}
              onClick={() => applyRatioPreset(r.v)}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      {/* 调整面板 */}
      {tool === 'adjust' && (
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-6 gap-y-2 border-t border-white/10 px-4 py-3">
          <Slider label="亮度" value={adj.b} onChange={(b) => setAdj((a) => ({ ...a, b }))} />
          <Slider label="对比度" value={adj.c} onChange={(c) => setAdj((a) => ({ ...a, c }))} />
          <Slider label="饱和度" value={adj.s} onChange={(s) => setAdj((a) => ({ ...a, s }))} />
        </div>
      )}

      {/* 另存面板 */}
      {saveOpen && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => e.target === e.currentTarget && setSaveOpen(false)}
        >
          <div className="modal-panel pop-in w-full max-w-[440px] !bg-card p-5 text-ink">
            <div className="text-[15px] font-semibold">另存为新文件</div>
            <div className="mt-1 text-[12.5px] text-ink2">
              输出 {outW} × {outH} · {outExt.toUpperCase()}
              {(adj.b || adj.c || adj.s || crop || rot || flipH || flipV) ? ' · 包含当前编辑' : ''}
            </div>
            <label className="mt-4 block text-[13px] font-medium">文件名</label>
            <input
              className="input mt-1.5"
              value={saveName}
              spellCheck={false}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doSave()}
            />
            <div className="mt-1.5 text-[12px] text-ink2/85">
              保存到当前目录。同名文件会被直接覆盖，请注意文件名。
            </div>
            {!corsOk && (
              <div className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] leading-relaxed text-danger">
                图片源不允许跨域读取，编辑结果无法导出保存。可先下载原图，编辑后重新上传。
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-plain" onClick={download}>
                <UIcon name="download" size={14} />
                下载到本地
              </button>
              <button className="btn-primary" disabled={saving || !saveName.trim() || !corsOk} onClick={doSave}>
                <UIcon name="save" size={14} />
                {saving ? '保存中…' : '保存到当前目录'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- 小组件 ----------

function TBtn({ icon, title, active, onClick }) {
  return (
    <button
      title={title}
      className={`flex h-9 w-9 items-center justify-center rounded-[10px] transition ${
        active ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
      }`}
      onClick={onClick}
    >
      <UIcon name={icon} size={16} />
    </button>
  )
}

function Slider({ label, value, onChange }) {
  return (
    <label className="flex items-center gap-2 text-[12.5px] text-white/70">
      <span className="w-11 shrink-0 text-right">{label}</span>
      <input
        type="range"
        min={-100}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-36 accent-accent"
      />
      <span className="w-9 tabular-nums text-white/50">{value > 0 ? `+${value}` : value}</span>
    </label>
  )
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const HANDLE_CURSOR = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
}

function handleStyle(hd, r) {
  const x = hd.includes('w') ? r.x : hd.includes('e') ? r.x + r.w : r.x + r.w / 2
  const y = hd.includes('n') ? r.y : hd.includes('s') ? r.y + r.h : r.y + r.h / 2
  return {
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    transform: 'translate(-50%, -50%)',
    cursor: HANDLE_CURSOR[hd],
  }
}

function applyDrag(d, dxn, dyn, dims) {
  if (!dims) return d.start
  const minW = 24 / d.rectPx.width
  const minH = 24 / d.rectPx.height
  const hd = d.handle
  const st = d.start

  if (hd === 'move') {
    return { x: clamp(st.x + dxn, 0, 1 - st.w), y: clamp(st.y + dyn, 0, 1 - st.h), w: st.w, h: st.h }
  }

  if (hd === 'new') {
    // 从锚点拖出新框
    const cx = clamp(st.x + dxn, 0, 1)
    const cy = clamp(st.y + dyn, 0, 1)
    let l = Math.min(st.x, cx)
    let t = Math.min(st.y, cy)
    let w = Math.abs(cx - st.x)
    let h = Math.abs(cy - st.y)
    if (d.ratio && w > 0.002) {
      h = (w * dims.cw) / (dims.ch * d.ratio)
      if (cy < st.y) t = st.y - h
      else t = st.y
      if (t < 0 || t + h > 1) {
        h = cy < st.y ? st.y : 1 - st.y
        w = (h * dims.ch * d.ratio) / dims.cw
        t = cy < st.y ? st.y - h : st.y
      }
    }
    return { x: clamp(l, 0, 1), y: clamp(t, 0, 1), w: clamp(w, 0, 1), h: clamp(h, 0, 1) }
  }

  let l = st.x
  let t = st.y
  let r2 = st.x + st.w
  let b = st.y + st.h
  if (hd.includes('w')) l = clamp(l + dxn, 0, r2 - minW)
  if (hd.includes('e')) r2 = clamp(r2 + dxn, l + minW, 1)
  if (hd.includes('n')) t = clamp(t + dyn, 0, b - minH)
  if (hd.includes('s')) b = clamp(b + dyn, t + minH, 1)
  let w = r2 - l
  let h = b - t

  if (d.ratio) {
    const pxPerNw = dims.cw
    const pxPerNh = dims.ch
    if (hd.length === 2) {
      // 角手柄：固定对角，按比例重算
      const ax = hd.includes('w') ? st.x + st.w : st.x // 固定的竖直边
      const ay = hd.includes('n') ? st.y + st.h : st.y // 固定的水平边
      w = hd.includes('w') ? st.x + st.w - l : r2 - st.x
      h = (w * pxPerNw) / (pxPerNh * d.ratio)
      const maxH = hd.includes('n') ? ay : 1 - ay // 'n' 向上伸展、's' 向下
      if (h > maxH) {
        h = maxH
        w = (h * pxPerNh * d.ratio) / pxPerNw
      }
      l = hd.includes('w') ? ax - w : ax
      t = hd.includes('n') ? ay - h : ay
    } else if (hd === 'n' || hd === 's') {
      // 上下边：由 h 定 w，左右居中
      const cx = st.x + st.w / 2
      h = hd === 'n' ? b - t : b - t
      w = (h * pxPerNh * d.ratio) / pxPerNw
      if (w > 1) {
        w = 1
        h = (w * pxPerNw) / (pxPerNh * d.ratio)
      }
      l = clamp(cx - w / 2, 0, 1 - w)
      t = hd === 'n' ? b - h : t
    } else {
      // 左右边：由 w 定 h，上下居中
      const cy = st.y + st.h / 2
      w = r2 - l
      h = (w * pxPerNw) / (pxPerNh * d.ratio)
      if (h > 1) {
        h = 1
        w = (h * pxPerNh * d.ratio) / pxPerNw
      }
      t = clamp(cy - h / 2, 0, 1 - h)
      l = hd === 'w' ? r2 - w : l
    }
  }

  return { x: clamp(l, 0, 1), y: clamp(t, 0, 1), w: clamp(w, minW, 1), h: clamp(h, minH, 1) }
}
