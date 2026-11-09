// 压缩包预览：rar/7z/tar 的解析支持（zip 走 server.js 里的 Range 手工解析，不经这里）
// - rar → node-unrar-js（官方 unrar 6.1.7 编译的 WASM，RAR4/RAR5 都支持）
// - 7z  → 7z-wasm（完整 7-Zip CLI 的 WASM 移植；libarchive-wasm 对非 ASCII 文件名会打码成 *，弃用）
// - tar/tar.gz → 手工解析（tar 格式简单，自己解析比 wasm 库更稳、中文路径没问题）
// 两者都需要把压缩包读进内存，所以有大小上限。
import { GetObjectCommand } from '@aws-sdk/client-s3'
import zlib from 'node:zlib'
import { createExtractorFromData } from 'node-unrar-js'
import SevenZip from '7z-wasm'

const ARCHIVE_CAP = 256 * 1024 * 1024 // 整包进内存上限
const TAR_CAP = 512 * 1024 * 1024 // tar.gz 解压后的上限
const LIST_CAP = 5000 // 目录条目上限（与 zip 一致）
const ENTRY_CAP = 100 * 1024 * 1024 // 单条目解压上限（与 zip 一致）

// 缓存最近用到的压缩包内容：点开目录后逐个预览条目时不用反复整包下载
const CACHE_MAX_BYTES = 512 * 1024 * 1024
const CACHE_MAX_ITEMS = 4
const CACHE_TTL = 10 * 60 * 1000
const arcCache = new Map() // key -> { buf, kind, ts }

// 识别压缩包格式，head 需要至少 512 字节（tar 的 magic 在偏移 257 处）
export function detectArchiveKind(head) {
  // rar4: "Rar!\x1a\x07\x00" / rar5: "Rar!\x1a\x07\x01\x00"，统一按 rar 处理
  if (head.length >= 7 && head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21 && head[4] === 0x1a && head[5] === 0x07) return 'rar'
  // 7z: "7z\xbc\xaf\x27\x1c"
  if (head.length >= 6 && head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf && head[4] === 0x27 && head[5] === 0x1c) return '7z'
  // gzip（大概率是 tar.gz，解压后在 getArchiveBuffer 里二次确认）
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'gzip'
  // POSIX tar：偏移 257 处 "ustar"
  if (head.length >= 262 && head.toString('ascii', 257, 262) === 'ustar') return 'tar'
  return null
}

function err(status, message) {
  return Object.assign(new Error(message), { status })
}

function cacheGet(key) {
  const hit = arcCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > CACHE_TTL) {
    arcCache.delete(key)
    return null
  }
  hit.ts = Date.now()
  return hit
}

function cachePut(key, buf, kind) {
  arcCache.set(key, { buf, kind, ts: Date.now() })
  while (arcCache.size > CACHE_MAX_ITEMS || [...arcCache.values()].reduce((s, v) => s + v.buf.length, 0) > CACHE_MAX_BYTES) {
    const oldest = [...arcCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
    if (!oldest || oldest[0] === key) break
    arcCache.delete(oldest[0])
  }
}

// 整包下载（带缓存）；gzip 会先解开确认是 tar.gz，纯 .gz 明确报错（libarchive/7z 都不认单文件 gzip）
export async function getArchiveBuffer(s3, bucket, key, size) {
  if (size > ARCHIVE_CAP) {
    throw err(413, `压缩包超过 ${Math.round(ARCHIVE_CAP / 1024 / 1024)}MB，暂不支持在线预览，请下载后查看`)
  }
  const ck = `${bucket}\0${key}`
  const hit = cacheGet(ck)
  if (hit) return hit
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  let buf = Buffer.from(await obj.Body.transformToByteArray())
  let kind = detectArchiveKind(buf.subarray(0, Math.min(buf.length, 512)))
  if (kind === 'gzip') {
    try {
      buf = zlib.gunzipSync(buf, { maxOutputLength: TAR_CAP })
    } catch {
      throw err(413, '压缩包过大或已损坏，暂不支持在线预览')
    }
    if (buf.length < 262 || buf.toString('ascii', 257, 262) !== 'ustar') {
      throw err(400, '暂不支持预览单个 .gz 文件（仅支持 .tar.gz）')
    }
    kind = 'tar'
  }
  cachePut(ck, buf, kind)
  return { buf, kind }
}

// 把各类错误翻译成用户能看懂的提示
export function archiveError(e) {
  const reason = e?.reason || ''
  const msg = String(e?.message || e)
  if (reason.includes('PASSWORD') || /encrypted|password|wrong password/i.test(msg)) return err(400, '压缩包已加密，暂不支持在线预览加密包')
  if (reason === 'ERAR_BAD_ARCHIVE' || reason === 'ERAR_UNKNOWN_FORMAT' || /is not RAR archive/i.test(msg)) return err(400, '不是标准的 RAR 格式')
  if (reason === 'ERAR_BAD_DATA') return err(400, '压缩包数据损坏，无法解析')
  if (reason === 'ERAR_NO_MEMORY') return err(413, '压缩包过大，服务器内存不足')
  return err(500, `压缩包解析失败: ${msg.slice(0, 200)}`)
}

// ---------- rar（node-unrar-js） ----------
export async function listRar(buf) {
  try {
    const extractor = await createExtractorFromData({ data: toAB(buf) })
    const list = extractor.getFileList()
    const entries = []
    for (const fh of list.fileHeaders) {
      // fileHeaders 生成器必须遍历完，否则 WASM 内部对象不释放（官方文档明确警告）
      if (!fh.flags?.directory && entries.length < LIST_CAP) {
        entries.push({ name: fh.name, uncompSize: fh.unpSize })
      }
    }
    return entries
  } catch (e) {
    throw archiveError(e)
  }
}

export async function extractRar(buf, name) {
  try {
    const extractor = await createExtractorFromData({ data: toAB(buf) })
    // 先查目标条目大小，超限直接拒绝，避免白解压一大坨
    const list = extractor.getFileList()
    for (const fh of list.fileHeaders) {
      if (fh.name === name && fh.unpSize > ENTRY_CAP) throw err(413, '文件过大，请下载整个压缩包查看')
    }
    const extracted = extractor.extract({ files: [name] })
    let data = null
    for (const f of extracted.files) {
      // files 生成器同样必须遍历完
      if (f.extraction) data = Buffer.from(f.extraction)
    }
    if (!data) throw err(404, '压缩包内未找到该文件')
    return data
  } catch (e) {
    if (e.status) throw e
    throw archiveError(e)
  }
}

function toAB(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

// ---------- 7z（7z-wasm） ----------
// 每次操作起一个独立 wasm 实例（callMain 复用同实例有静态状态风险），MEMFS 不落盘
// -p 传空密码：未加密包无影响，加密包直接报错而不是卡在等 stdin
async function with7z(buf, fn) {
  const outs = []
  const errs = []
  let sz
  try {
    sz = await SevenZip({
      print: (t) => outs.push(t),
      printErr: (t) => errs.push(String(t)),
    })
  } catch (e) {
    throw err(500, `7z 组件加载失败: ${String(e?.message || e).slice(0, 200)}`)
  }
  try {
    sz.FS.writeFile('a.7z', buf)
    return await fn(sz, outs)
  } catch (e) {
    if (e?.status) throw e
    const msg = errs.join('\n')
    if (/wrong password|enter password/i.test(msg)) throw err(400, '压缩包已加密，暂不支持在线预览加密包')
    if (/Cannot open|Is not archive|unsupported/i.test(msg)) throw err(400, '不是标准的 7z 格式或已损坏')
    throw err(500, `压缩包解析失败: ${(msg || String(e?.message || e)).slice(0, 200)}`)
  }
}

function callMainSafe(sz, args) {
  try {
    sz.callMain(args)
  } catch (e) {
    // EXIT_RUNTIME 开启时正常退出也会抛 ExitStatus(0)
    if (e?.name === 'ExitStatus' && e.status === 0) return
    throw e
  }
}

export async function list7z(buf) {
  return with7z(buf, async (sz, out) => {
    callMainSafe(sz, ['l', '-ba', '-slt', '-p', 'a.7z'])
    if (!out.length) throw err(400, '不是标准的 7z 格式或已损坏')
    const entries = []
    let cur = null
    for (const line of out) {
      const m = line.match(/^(Path|Size|Folder|Attributes) = (.*)$/)
      if (m) {
        if (m[1] === 'Path') cur = { name: m[2], uncompSize: 0, dir: false }
        else if (cur) {
          if (m[1] === 'Size') cur.uncompSize = Number(m[2]) || 0
          if (m[1] === 'Folder' && m[2] === '+') cur.dir = true
          if (m[1] === 'Attributes' && /^D/.test(m[2])) cur.dir = true
        }
      }
      // 空行表示一个条目结束（-ba -slt 用空行分隔）
      if (line === '' && cur) {
        if (!cur.dir && entries.length < LIST_CAP) entries.push({ name: cur.name, uncompSize: cur.uncompSize })
        cur = null
      }
    }
    if (cur && !cur.dir && entries.length < LIST_CAP) entries.push({ name: cur.name, uncompSize: cur.uncompSize })
    return entries
  })
}

export async function extract7z(buf, name) {
  return with7z(buf, async (sz) => {
    callMainSafe(sz, ['x', 'a.7z', '-y', '-p', '-o/out', name])
    const data = sz.FS.readFile('/out/' + name, { encoding: 'binary' })
    if (!data || !data.length) throw err(404, '压缩包内未找到该文件')
    if (data.length > ENTRY_CAP) throw err(413, '文件过大，请下载整个压缩包查看')
    return Buffer.from(data)
  })
}

// ---------- tar / tar.gz（手工解析，中文路径无坑） ----------
// 解析 tar：处理 pax 扩展头（type x）与 GNU longname（type L），目录项(type 5)跳过
function parseTar(buf) {
  const entries = []
  let off = 0
  let pendingPath = null
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512)
    if (hdr[0] === 0) break
    const size = parseInt((hdr.toString('ascii', 124, 136).replace(/\0/g, '').trim() || '0'), 8) || 0
    const type = String.fromCharCode(hdr[156] || 48)
    const name = hdr.toString('utf8', 0, 100).replace(/\0[\s\S]*$/, '')
    const prefix = hdr[345] ? hdr.toString('utf8', 345, 500).replace(/\0[\s\S]*$/, '') : ''
    const dataStart = off + 512
    off = dataStart + Math.ceil(size / 512) * 512
    if (type === 'x' || type === 'g') {
      const rec = buf.toString('utf8', dataStart, dataStart + size)
      if (type === 'x') {
        const m = rec.match(/(?:^|\n)\d+ path=([^\n]*)\n/)
        if (m) pendingPath = m[1]
      }
      continue
    }
    if (type === 'L') {
      // GNU long name：数据区就是真实路径
      pendingPath = buf.toString('utf8', dataStart, dataStart + size).replace(/\0+$/, '')
      continue
    }
    const fullName = pendingPath || (prefix ? `${prefix}/${name}` : name)
    pendingPath = null
    if (type === '5' || fullName.endsWith('/')) continue // 目录
    if (entries.length < LIST_CAP) entries.push({ name: fullName, uncompSize: size, _off: dataStart, _size: size })
  }
  return entries
}

export function listTar(buf) {
  return parseTar(buf).map(({ name, uncompSize }) => ({ name, uncompSize }))
}

export function extractTar(buf, name) {
  const hit = parseTar(buf).find((e) => e.name === name)
  if (!hit) return null
  return buf.subarray(hit._off, hit._off + hit._size)
}
