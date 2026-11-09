import { useEffect, useRef, useState } from 'react'
import Artplayer from 'artplayer'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { isNativeVideo } from '../lib/format'
import { fetchSubtitle } from '../lib/subtitle'
import {
  capabilities,
  getSavedPos,
  savePos,
  clearPos,
  startTranscode,
  stopTranscode,
  nextVideoOf,
} from '../lib/video'
import { fmtTimeSec } from '../lib/player'
import { UIcon } from './icons'

// ArtPlayer 播放器封装：
// - 浏览器可直放的格式直接播；mkv/avi 等走服务端 ffmpeg HLS 转码（仅 Node/Docker 版）
// - 同名 .srt/.vtt 字幕、播放位置记忆、播完自动下一集
export default function VideoPlayer({ f, siblings, setPreview }) {
  const boxRef = useRef(null)
  const artRef = useRef(null)
  const transIdRef = useRef('')
  const ssRef = useRef(0)
  const [status, setStatus] = useState('init') // init | transcoding | failed
  const [failMsg, setFailMsg] = useState('')

  const toast = useStore((s) => s.toast)

  useEffect(() => {
    let alive = true
    let art = null
    setStatus('init')
    setFailMsg('')

    const playNext = () => {
      const next = nextVideoOf(siblings, f)
      if (next) {
        toast('即将播放下一集：' + next.name)
        setPreview({ mode: 'file', f: next, siblings })
      }
    }

    ;(async () => {
      try {
        let url = f.url
        let type = ''
        const saved = getSavedPos(f.bucket, f.path)

      if (!isNativeVideo(f.name)) {
        // 转码路径：从上次位置开始转（时间线 0 = ss）
        const cap = await capabilities()
        if (!cap.transcode) {
          if (alive) {
            setStatus('failed')
            setFailMsg('服务器未开启转码（需 Docker 自托管版并安装 ffmpeg），该格式无法在线播放')
          }
          return
        }
        if (alive) setStatus('transcoding')
        const resumeAt = saved > 30 ? saved : 0
        try {
          const r = await startTranscode(f.bucket, f.path, resumeAt)
          if (!alive) {
            stopTranscode(r.id)
            return
          }
          transIdRef.current = r.id
          ssRef.current = r.ss || 0
          url = `/api/transcode/${r.id}/index.m3u8`
          type = 'm3u8'
        } catch (e) {
          if (alive) {
            setStatus('failed')
            setFailMsg(e.message)
          }
          return
        }
      }

      // 字幕（转码等待期间一并加载）
      let subtitle = null
      try {
        subtitle = await fetchSubtitle(f.bucket, f.path)
      } catch {}
      if (!alive) return

      // 注意：ArtPlayer v5 会校验 option 类型，显式传 undefined（如 subtitle/customType）会直接抛错
      const opts = {
        container: boxRef.current,
        url,
        type,
        setting: true,
        fullscreen: true,
        fullscreenWeb: true,
        pip: true,
        miniProgressBar: true,
        hotkey: true,
        playsInline: true,
        autoplay: true,
        autoSize: true,
        autoMini: false,
        // 不能加 crossOrigin：R2 预签名直链不带 CORS 头，加了浏览器会直接拦掉视频请求
        moreVideoAttr: { playsInline: true },
      }
      if (type === 'm3u8') {
        opts.customType = {
          m3u8: async (video, src) => {
            const Hls = (await import('hls.js')).default
            if (Hls.isSupported()) {
              const hls = new Hls({ maxBufferLength: 30 })
              hls.loadSource(src)
              hls.attachMedia(video)
              video._hls = hls
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
              video.src = src // Safari 原生 HLS
            }
          },
        }
      }
      if (subtitle) {
        opts.subtitle = {
          url: subtitle.url,
          type: 'vtt',
          style: {
            color: '#fff',
            textShadow: '0 1px 4px rgba(0,0,0,.9)',
            fontSize: '15px',
          },
        }
      }
      art = new Artplayer(opts)
      artRef.current = art

      // 出画面就撤掉加载遮罩（ready 在 HLS 首片出流时触发；playing 兜底）
      art.on('ready', () => {
        if (alive) setStatus('ready')
      })
      art.on('video:playing', () => {
        if (alive) setStatus('ready')
      })
      // 播放出错给出可读信息，而不是停在转圈
      art.on('video:error', () => {
        if (alive) {
          setStatus('failed')
          setFailMsg('视频加载失败：文件可能不支持浏览器播放或直链已过期，请重试')
        }
      })

      // 恢复上次播放位置（直连格式用时间轴 seek；转码格式已通过 ss 起转）
      if (type !== 'm3u8') {
        art.on('ready', () => {
          if (saved > 15 && !art.playing) {
            art.currentTime = saved
            toast(`已从 ${fmtTimeSec(saved)} 继续播放`)
          }
        })
      }

      // 进度记忆节流 5s
      let lastSave = 0
      art.on('video:timeupdate', () => {
        const now = Date.now()
        if (now - lastSave > 5000) {
          lastSave = now
          savePos(f.bucket, f.path, ssRef.current + art.currentTime)
        }
      })
      art.on('video:ended', () => {
        clearPos(f.bucket, f.path)
        playNext()
      })
      art.on('destroy', () => {
        try {
          art.video?._hls?.destroy()
        } catch {}
        savePos(f.bucket, f.path, ssRef.current + (art.currentTime || 0))
      })
      } catch (e) {
        // 播放器初始化异常也要可见，不能永远停在转圈
        console.error('[VideoPlayer] init failed:', e)
        if (alive) {
          setStatus('failed')
          setFailMsg('播放器初始化失败：' + (e?.message || e))
        }
      }
    })()

    return () => {
      alive = false
      try {
        art?.destroy(false)
      } catch {}
      artRef.current = null
      if (transIdRef.current) {
        stopTranscode(transIdRef.current)
        transIdRef.current = ''
      }
      ssRef.current = 0
    }
  }, [f.bucket, f.path])

  if (status === 'failed') {
    return (
      <div className="modal-panel pop-in m-auto w-full max-w-[420px]">
        <div className="flex flex-col items-center px-8 py-14 text-center">
          <UIcon name="alert" size={40} className="text-danger" />
          <div className="mt-4 text-[15px] font-medium">{f.name}</div>
          <div className="mt-1 px-2 text-[13px] leading-relaxed text-ink2">{failMsg}</div>
          <a className="btn-primary mt-5" href={f.url} target="_blank" rel="noreferrer">
            <UIcon name="download" size={15} />
            下载文件
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="m-auto flex h-full w-full max-w-[1100px] items-center justify-center px-4 py-2">
      <div className="relative h-full w-full overflow-hidden rounded-xl bg-black">
        <div ref={boxRef} className="h-full w-full" />
        {status !== 'ready' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-white/70">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/25 border-t-white/80" />
            <span className="text-[13px]">{status === 'transcoding' ? '服务端转码中，马上就能播…' : '加载中…'}</span>
            {status === 'transcoding' && (
              <span className="text-[11.5px] text-white/40">大文件首次转码需要一点时间，边转边播</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
