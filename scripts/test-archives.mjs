import fs from 'node:fs'
import { detectArchiveKind, getArchiveBuffer, listRar, list7z, listTar, extractRar, extract7z, extractTar } from '/Users/hoanliu/projects/r2-explorer/src/archives.js'

const read = (p) => fs.readFileSync(p)
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label} ${extra}`) }
  else { fail++; console.log(`  ✗ ${label} ${extra}`) }
}

// ---- 格式识别（512 字节头）----
console.log('== detectArchiveKind ==')
for (const [p, expect] of [
  ['/tmp/unrar-repo/testFiles/FolderTest.rar', 'rar'],
  ['/tmp/libarchive-repo/archives/v4.rar', 'rar'],
  ['/tmp/arctest-zh.7z', '7z'],
  ['/tmp/arctest.tar.gz', 'gzip'],
  ['/tmp/arctest.tar', 'tar'],
  ['/tmp/app.js.gz', 'gzip'],
]) {
  try {
    const got = detectArchiveKind(read(p).subarray(0, 512))
    ok(got === expect, `${p.split('/').pop()} → ${got}`, `(期望 ${expect})`)
  } catch (e) {
    ok(false, `${p.split('/').pop()} 样本缺失或读取失败: ${e.message}`)
  }
}

// ---- rar（node-unrar-js）----
console.log('== rar ==')
for (const p of ['/tmp/unrar-repo/testFiles/FolderTest.rar', '/tmp/libarchive-repo/archives/v4.rar', '/tmp/libarchive-repo/archives/v5.rar']) {
  try {
    const buf = read(p)
    const entries = await listRar(buf)
    ok(entries.length > 0, `${p.split('/').pop()} 列出 ${entries.length} 条`, JSON.stringify(entries.slice(0, 2)))
    const target = entries.find((e) => e.uncompSize > 0)
    const data = await extractRar(buf, target.name)
    ok(data && data.length === target.uncompSize, `${p.split('/').pop()} 提取 ${target.name}`, `${data.length}B`)
  } catch (e) {
    ok(false, `${p.split('/').pop()} 失败: ${e.message}`)
  }
}

// ---- 加密 rar：文件名加密 → 列表报错；仅内容加密 → 提取报错 ----
console.log('== 加密 rar ==')
try {
  await listRar(read('/tmp/unrar-repo/testFiles/HeaderEnc1234.rar'))
  ok(false, 'HeaderEnc1234.rar 竟然列出来了')
} catch (e) {
  ok(e.status === 400 && /加密/.test(e.message), `HeaderEnc1234.rar → [${e.status}] ${e.message}`)
}
try {
  await listRar(read('/tmp/unrar-repo/testFiles/FileEncByName.rar')) // 文件名可见属正常
  const data = await extractRar(read('/tmp/unrar-repo/testFiles/FileEncByName.rar'), '3Sec.txt')
  ok(false, 'FileEncByName.rar 的 3Sec.txt 竟然提取成功了', JSON.stringify(data?.toString().slice(0, 20)))
} catch (e) {
  ok(e.status === 400 && /加密/.test(e.message), `FileEncByName.rar 加密条目 → [${e.status}] ${e.message}`)
}

// ---- 7z（7z-wasm，含中文文件名）----
console.log('== 7z ==')
for (const p of ['/tmp/libarchive-repo/archives/lzma2.7z', '/tmp/arctest-zh.7z']) {
  try {
    const buf = read(p)
    const entries = await list7z(buf)
    ok(entries.length > 0, `${p.split('/').pop()} 列出 ${entries.length} 条`, JSON.stringify(entries.slice(0, 3)))
    const target = entries.find((e) => e.uncompSize > 0)
    const data = await extract7z(buf, target.name)
    ok(data && data.length === target.uncompSize, `${p.split('/').pop()} 提取 ${target.name}`, `${data?.length}B`)
  } catch (e) {
    ok(false, `${p.split('/').pop()} 失败: ${e.message}`)
  }
}

// ---- tar / tar.gz（手工解析，中文路径）----
console.log('== tar / tar.gz ==')
try {
  const entries = listTar(read('/tmp/arctest.tar'))
  const zh = entries.find((e) => e.name.includes('说明.txt'))
  ok(!!zh, 'tar 中文条目', zh?.name)
  const data = extractTar(read('/tmp/arctest.tar'), zh.name)
  ok(data.toString('utf8').includes('你好'), 'tar 提取内容正确', JSON.stringify(data.toString().trim()))
} catch (e) {
  ok(false, `tar 失败: ${e.message}`)
}
try {
  // 走 getArchiveBuffer 完整链路（gzip → 解压 → tar），用 mock s3
  const mockS3 = { send: async () => ({ Body: { transformToByteArray: async () => new Uint8Array(read('/tmp/arctest.tar.gz')) } }) }
  const { buf, kind } = await getArchiveBuffer(mockS3, 'b', 'k', read('/tmp/arctest.tar.gz').length)
  ok(kind === 'tar', 'tar.gz 识别为 tar')
  const entries = listTar(buf)
  const zh = entries.find((e) => e.name.includes('说明.txt'))
  ok(!!zh, 'tar.gz 中文条目', zh?.name)
  const data = extractTar(buf, zh.name)
  ok(data.toString('utf8').includes('你好'), 'tar.gz 提取内容正确')
} catch (e) {
  ok(false, `tar.gz 失败: ${e.message}`)
}

// ---- 纯 .gz → 明确报错而不是崩 ----
console.log('== 纯 .gz ==')
try {
  const mockS3 = { send: async () => ({ Body: { transformToByteArray: async () => new Uint8Array(read('/tmp/app.js.gz')) } }) }
  await getArchiveBuffer(mockS3, 'b', 'gz-single', read('/tmp/app.js.gz').length)
  ok(false, '纯 .gz 竟然通过了')
} catch (e) {
  ok(e.status === 400 && /\.gz/.test(e.message), `纯 .gz → [${e.status}] ${e.message}`)
}

// ---- 缓存命中验证 ----
console.log('== 缓存 ==')
let fetchCount = 0
try {
  const countS3 = { send: async () => { fetchCount++; return { Body: { transformToByteArray: async () => new Uint8Array(read('/tmp/arctest.tar')) } } } }
  await getArchiveBuffer(countS3, 'b2', 'k2', 1)
  await getArchiveBuffer(countS3, 'b2', 'k2', 1)
  ok(fetchCount === 1, '同一压缩包第二次读走缓存', `fetchCount=${fetchCount}`)
} catch (e) {
  ok(false, `缓存验证失败（样本缺失?）: ${e.message}`)
}

// ---- 整包解压（在线解压）：一次解出全部，避免逐条重复 WASM 初始化 ----
console.log('== 整包解压 extractAll* ==')
import zlib from 'node:zlib'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { extractAllRar, extractAll7z, extractAllTar } from '/Users/hoanliu/projects/r2-explorer/src/archives.js'
const mk = '/tmp/r2x-extract-all-test'
fs.rmSync(mk, { recursive: true, force: true })
fs.mkdirSync(mk + '/src/子目录', { recursive: true })
fs.writeFileSync(mk + '/src/中文.txt', '你好，世界')
fs.writeFileSync(mk + '/src/子目录/deep.js', 'console.log(1)')
fs.writeFileSync(mk + '/src/empty.bin', '')
const shims = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/vendor/sandbox-center-runtime-kit/shim/brokered-bin'
const bin = (n) => (fs.existsSync(shims + '/' + n) ? shims + '/' + n : n)

// tar / tar.gz
{
  execSync(`tar cf test-all.tar src`, { cwd: mk })
  const items = extractAllTar(read(mk + '/test-all.tar'))
  ok(items.some((e) => e.name === 'src/中文.txt' && e.data.toString() === '你好，世界'), 'tar: 中文内容正确')
  ok(items.some((e) => e.name === 'src/empty.bin' && e.data.length === 0), 'tar: 空文件 0 字节')
  execSync(`tar czf test-all.tar.gz src`, { cwd: mk })
  const untar = zlib.gunzipSync(read(mk + '/test-all.tar.gz'))
  ok(extractAllTar(untar).some((e) => e.name === 'src/子目录/deep.js'), 'tar.gz: gunzip 后整包解压正常')
}

// rar：extractAll 对已有样本跑一遍，产出与列表一致
try {
  const buf = read('/tmp/unrar-repo/testFiles/FolderTest.rar')
  const list = await listRar(buf)
  const out = []
  await extractAllRar(buf, async (name, data) => out.push({ name, data }))
  const listNames = new Set(list.map((e) => e.name))
  ok(out.length > 0 && out.every((e) => listNames.has(e.name)), `rar: 整包解压 ${out.length} 条与列表一致`)
  ok(out.every((e) => { const m = list.find((x) => x.name === e.name); return !m || m.uncompSize === e.data.length }), 'rar: 内容大小与标注一致')
} catch (e) {
  ok(false, `rar 整包解压失败: ${e.message}`)
}

// 7z：7z-wasm 造标准包再整包解
{
  const SevenZip = (await import('/Users/hoanliu/projects/r2-explorer/node_modules/7z-wasm/7zz.umd.js')).default
  const sz = await SevenZip({ print: () => {}, printErr: () => {} })
  for (const p of ['src/中文.txt', 'src/子目录/deep.js', 'src/empty.bin']) {
    sz.FS.mkdirTree('/in/' + path.dirname(p))
    sz.FS.writeFile('/in/' + p, fs.readFileSync(mk + '/' + p))
  }
  sz.callMain(['a', 'test-all.7z', '/in/src'])
  fs.writeFileSync(mk + '/test-all.7z', sz.FS.readFile('test-all.7z'))
  const buf = read(mk + '/test-all.7z')
  const list = await list7z(buf)
  const out = await extractAll7z(buf, list.map((e) => e.name))
  ok(out.some((e) => e.name.includes('中文') && e.data.toString() === '你好，世界'), '7z: 中文内容正确')
  ok(out.some((e) => e.name.endsWith('empty.bin') && e.data.length === 0), '7z: 空文件保留 0 字节')
}

// zip 流式解压：复刻 server.js worker 代码路径（compSize=0 跳过 Range）
{
  execSync(`${bin('zip')} -r -q test-all.zip src`, { cwd: mk })
  const buf = read(mk + '/test-all.zip')
  const u32t = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
  const u16t = (b, o) => b[o] | (b[o + 1] << 8)
  const size = buf.length
  const tail = buf.subarray(size - Math.min(size, 65536 + 65535))
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) if (u32t(tail, i) === 0x06054b50) { eocd = i; break }
  ok(eocd >= 0, 'zip: EOCD 定位')
  const cdSize = u32t(tail, eocd + 12)
  const cdOffset = u32t(tail, eocd + 16)
  const cbuf = buf.subarray(cdOffset, cdOffset + cdSize)
  const entries = []
  let p = 0
  while (p + 46 <= cbuf.length) {
    if (u32t(cbuf, p) !== 0x02014b50) break
    const nameLen = u16t(cbuf, p + 28)
    const name = cbuf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (!name.endsWith('/')) entries.push({ name, method: u16t(cbuf, p + 10), compSize: u32t(cbuf, p + 20), offset: u32t(cbuf, p + 42) })
    p += 46 + nameLen + u16t(cbuf, p + 30) + u16t(cbuf, p + 32)
  }
  const results = new Map()
  for (const e of entries) {
    let data
    if (e.compSize === 0) data = Buffer.alloc(0)
    else {
      const lbuf = buf.subarray(e.offset, e.offset + 30)
      const dataStart = e.offset + 30 + u16t(lbuf, 26) + u16t(lbuf, 28)
      data = buf.subarray(dataStart, dataStart + e.compSize)
      if (e.method === 8) data = zlib.inflateRawSync(data)
    }
    results.set(e.name, data)
  }
  ok(results.get('src/中文.txt')?.toString() === '你好，世界', 'zip: 中文内容正确')
  ok(results.get('src/empty.bin')?.length === 0, 'zip: 空文件 0 字节')
}

// 路径消毒（server.js sanitizeEntryName 等价复刻）
console.log('== 路径消毒 ==')
function sanitizeEntryName(name) {
  const parts = String(name).replace(/\\/g, '/').split('/')
  const out = []
  for (const p of parts) {
    if (!p || p === '.') continue
    if (p === '..') return null
    out.push(p)
  }
  return out.length ? out.join('/') : null
}
ok(sanitizeEntryName('a/../../etc/passwd') === null, '.. 穿越 → null')
ok(sanitizeEntryName('/abs/path.txt') === 'abs/path.txt', '绝对路径去前导斜杠')
ok(sanitizeEntryName('win\\path\\文.txt') === 'win/path/文.txt', '反斜杠归一')
ok(sanitizeEntryName('a//b/./c') === 'a/b/c', '空段与 . 过滤')
ok(sanitizeEntryName('../') === null, '纯 .. → null')

fs.rmSync(mk, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
