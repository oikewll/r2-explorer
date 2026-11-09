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
  const got = detectArchiveKind(read(p).subarray(0, 512))
  ok(got === expect, `${p.split('/').pop()} → ${got}`, `(期望 ${expect})`)
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
const countS3 = { send: async () => { fetchCount++; return { Body: { transformToByteArray: async () => new Uint8Array(read('/tmp/arctest.tar')) } } } }
await getArchiveBuffer(countS3, 'b2', 'k2', 1)
await getArchiveBuffer(countS3, 'b2', 'k2', 1)
ok(fetchCount === 1, '同一压缩包第二次读走缓存', `fetchCount=${fetchCount}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
