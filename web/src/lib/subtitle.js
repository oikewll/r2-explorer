import { api } from './api'

// 同名字幕：foo.mp4 → foo.srt / foo.vtt，走 /api/text 同源代理
// SRT → VTT：补 WEBVTT 头 + 时间戳毫秒分隔符逗号→点；结果包成 blob URL
function srtToVtt(srt) {
  return (
    'WEBVTT\n\n' +
    srt
      .replace(/^\uFEFF/, '')
      .replace(/\r/g, '')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
  )
}

function toVttUrl(text, ext) {
  const vtt = ext === 'vtt' ? text : srtToVtt(text)
  return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }))
}

// 返回 { url, ext } 或 null
export async function fetchSubtitle(bucket, path) {
  const base = path.replace(/\.[^.]+$/, '')
  for (const ext of ['vtt', 'srt']) {
    try {
      const text = await api(
        `/api/text?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(base + '.' + ext)}`
      )
      return { url: toVttUrl(text, ext), ext }
    } catch {
      // 404 等继续试下一种格式
    }
  }
  return null
}
