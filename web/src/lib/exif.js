// 轻量 JPEG EXIF 解析：只取常用的拍摄信息（相机 / 时间 / 光圈快门 ISO 焦距 / 方向）
// 策略：Range 请求只拉文件头部 256KB（EXIF 位于 SOI 之后的 APP1 段，一般远小于此）
// 非 JPEG 或解析失败一律返回 null，调用方降级只展示尺寸/大小/格式

const EXIF_MAX_BYTES = 256 * 1024

function readU16(view, off, le) {
  return view.getUint16(off, le)
}
function readU32(view, off, le) {
  return view.getUint32(off, le)
}

// 遍历 IFD，返回 { tag: value }，RATIONAL 以 [num, den] 表示
function parseIfd(view, tiffStart, ifdOffset, le, out) {
  const count = readU16(view, tiffStart + ifdOffset, le)
  let nextOff = tiffStart + ifdOffset + 2 + count * 12
  for (let i = 0; i < count; i++) {
    const entry = tiffStart + ifdOffset + 2 + i * 12
    if (entry + 12 > view.byteLength) break
    const tag = readU16(view, entry, le)
    const type = readU16(view, entry + 2, le)
    const num = readU32(view, entry + 4, le)
    const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }
    const unit = sizes[type] || 1
    const total = unit * num
    let dataOff = entry + 8
    if (total > 4) dataOff = tiffStart + readU32(view, entry + 8, le)
    if (dataOff < 0 || dataOff + Math.min(total, unit) > view.byteLength) continue

    let value
    if (type === 2) {
      // ASCII
      const bytes = new Uint8Array(view.buffer, view.byteOffset + dataOff, num - 1)
      value = new TextDecoder('utf-8').decode(bytes).replace(/\0/g, '').trim()
    } else if (type === 5 || type === 10) {
      // RATIONAL / SRATIONAL
      value = []
      for (let j = 0; j < num && dataOff + j * 8 + 8 <= view.byteLength; j++) {
        value.push([readU32(view, dataOff + j * 8, le), readU32(view, dataOff + j * 8 + 4, le)])
      }
      if (value.length === 1) value = value[0]
    } else if (type === 3) {
      value = num === 1 ? readU16(view, dataOff, le) : Array.from({ length: num }, (_, j) => readU16(view, dataOff + j * 2, le))
    } else {
      value = num === 1 ? readU32(view, dataOff, le) : Array.from({ length: num }, (_, j) => readU32(view, dataOff + j * 4, le))
    }
    out[tag] = value
  }
  return nextOff - tiffStart
}

function rational(v) {
  if (!Array.isArray(v) || !v[1]) return null
  return v[0] / v[1]
}

export async function readExif(url) {
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${EXIF_MAX_BYTES - 1}` } })
    if (!res.ok && res.status !== 206) return null
    const buf = await res.arrayBuffer()
    const view = new DataView(buf)
    // JPEG 魔数
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null

    // 找 APP1/Exif 段
    let off = 2
    let tiffStart = -1
    while (off + 4 < view.byteLength) {
      if (view.getUint8(off) !== 0xff) break
      const marker = view.getUint8(off + 1)
      const size = view.getUint16(off + 2)
      if (marker === 0xe1) {
        // "Exif\0\0"
        if (
          view.getUint32(off + 4) === 0x45786966 &&
          view.getUint16(off + 8) === 0x0000
        ) {
          tiffStart = off + 10
          break
        }
      }
      if (marker === 0xda) break // SOS，EXIF 不会在后面
      off += 2 + size
    }
    if (tiffStart < 0 || tiffStart + 8 > view.byteLength) return null

    const le = view.getUint16(tiffStart) === 0x4949 // "II" 小端
    if (readU16(view, tiffStart + 2, le) !== 42) return null
    const ifd0Off = readU32(view, tiffStart + 4, le)

    const ifd0 = {}
    const next = parseIfd(view, tiffStart, ifd0Off, le, ifd0)

    const exif = {}
    if (ifd0[0x8769]) {
      try {
        parseIfd(view, tiffStart, ifd0[0x8769], le, exif)
      } catch {}
    }

    // 常用字段整理
    const pick = (t) => ifd0[t] ?? exif[t]
    const exposure = rational(exif[0x829a])
    const fnumber = rational(exif[0x829d])
    const focal = rational(exif[0x920a])
    const info = {}
    if (ifd0[0x010f]) info.make = ifd0[0x010f]
    if (ifd0[0x0110]) info.model = ifd0[0x0110]
    if (ifd0[0x0132]) info.dateTime = ifd0[0x0132]
    if (exif[0x9003]) info.dateTimeOriginal = exif[0x9003]
    if (exposure != null) info.exposure = exposure >= 1 ? `${+exposure.toFixed(1)}s` : `1/${Math.round(1 / exposure)}s`
    if (fnumber != null) info.fnumber = `f/${+fnumber.toFixed(1)}`
    if (exif[0x8827] != null) info.iso = `ISO ${exif[0x8827]}`
    if (focal != null) info.focal = `${Math.round(focal)}mm`
    if (pick(0x0112)) info.orientation = pick(0x0112)
    return Object.keys(info).length ? info : null
  } catch {
    return null
  }
}
