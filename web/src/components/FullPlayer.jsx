import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import {
  MODES,
  getAudio,
  togglePlay,
  next,
  prev,
  setMode,
  seek,
  playIndex,
  closeFullscreen,
  fmtTimeSec,
} from '../lib/player'
import { fetchLrc, findLine } from '../lib/lrc'
import { UIcon } from './icons'
import SeekBar from './SeekBar'

export default function FullPlayer() {
  const player = useStore((s) => s.player)
  const open = player.fullscreen
  const track = player.queue[player.index]
  const modeIdx = MODES.findIndex((m) => m.value === player.mode)
  const mode = MODES[modeIdx < 0 ? 0 : modeIdx]
  const nextMode = MODES[(modeIdx + 1) % MODES.length]

  // ---------- 歌词加载 ----------
  const [lyrics, setLyrics] = useState(null) // { meta, lines, times }
  const [lyricsState, setLyricsState] = useState('idle') // idle | loading | ok | none
  const [view, setView] = useState('lyrics') // lyrics | queue

  useEffect(() => {
    if (!open || !track) return
    let cancelled = false
    setLyrics(null)
    setLyricsState('loading')
    fetchLrc(track).then((r) => {
      if (cancelled) return
      if (r) {
        setLyrics(r)
        setLyricsState('ok')
      } else {
        setLyricsState('none')
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, track?.bucket, track?.path])

  // ---------- 60fps 歌词同步（rAF 读 audio.currentTime，仅行变化时 setState） ----------
  const [active, setActive] = useState(-1)
  const cursorRef = useRef(-1)
  const activeRef = useRef(-1)

  useEffect(() => {
    cursorRef.current = -1
    activeRef.current = -1
    setActive(-1)
  }, [lyrics])

  useEffect(() => {
    if (!open || lyricsState !== 'ok') return
    let raf
    const loop = () => {
      const a = getAudio()
      if (a) {
        const i = findLine(lyrics.times, a.currentTime, cursorRef)
        if (i !== activeRef.current) {
          activeRef.current = i
          setActive(i)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [open, lyricsState, lyrics])

  // ---------- 歌词自动滚动（用户手动滚动后暂停 3.5s） ----------
  const listRef = useRef(null)
  const lineRefs = useRef([])
  const userScrollUntil = useRef(0)

  useEffect(() => {
    if (active < 0 || !listRef.current) return
    if (Date.now() < userScrollUntil.current) return
    const el = lineRefs.current[active]
    const box = listRef.current
    if (el) {
      box.scrollTo({
        top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2,
        behavior: 'smooth',
      })
    }
  }, [active])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [lyrics, view])

  // Esc 关闭全屏
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') closeFullscreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open || !track) return null

  const clickLine = (i) => {
    seek(lyrics.times[i])
    userScrollUntil.current = 0
  }

  return (
    <div className="fade-in fixed inset-0 z-[60] flex flex-col bg-gradient-to-b from-[#1b1f2e] via-[#12141d] to-[#0c0d13] text-white">
      {/* 顶部栏 */}
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 max-sm:pt-2">
        <button
          className="flex h-10 w-10 items-center justify-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white"
          onClick={closeFullscreen}
          title="收起"
        >
          <UIcon name="collapse" size={20} />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="text-[11px] font-medium uppercase tracking-widest text-white/40">正在播放</div>
          <div className="truncate text-[12.5px] text-white/70">{track.bucket}</div>
        </div>
        <div className="h-10 w-10" />
      </div>

      {/* 中部：碟片 + 歌词/队列 */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 md:flex-row md:items-stretch md:gap-10">
        {/* 碟片 */}
        <div className="flex shrink-0 items-center justify-center max-md:pt-2">
          <div className="relative">
            <div
              className={`absolute -inset-8 rounded-full bg-accent/30 blur-3xl transition-opacity duration-700 ${
                player.playing ? 'opacity-60' : 'opacity-20'
              }`}
            />
            <div
              className={`relative flex h-44 w-44 items-center justify-center rounded-full border-[10px] border-white/10 bg-gradient-to-br from-[#2a2f42] to-[#191c29] shadow-[0_18px_60px_rgba(0,0,0,.5)] md:h-60 md:w-60 ${
                player.playing ? 'disc-spinning' : ''
              }`}
            >
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/90 text-white shadow-inner md:h-20 md:w-20">
                <UIcon name="audio" size={30} />
              </div>
            </div>
          </div>
        </div>

        {/* 歌词 / 队列 */}
        <div className="flex min-h-0 w-full flex-1 flex-col max-md:max-w-md md:h-[62vh] md:max-w-sm">
          <div className="mb-2 flex shrink-0 justify-center">
            <div className="flex gap-1 rounded-full bg-white/[0.07] p-1 text-[12.5px] font-medium">
              <button
                className={`rounded-full px-3.5 py-1 transition ${
                  view === 'lyrics' ? 'bg-white text-ink' : 'text-white/55 hover:text-white'
                }`}
                onClick={() => setView('lyrics')}
              >
                歌词
              </button>
              <button
                className={`rounded-full px-3.5 py-1 transition ${
                  view === 'queue' ? 'bg-white text-ink' : 'text-white/55 hover:text-white'
                }`}
                onClick={() => setView('queue')}
              >
                队列 {player.queue.length}
              </button>
            </div>
          </div>

          {view === 'lyrics' ? (
            <LyricsPanel
              lyrics={lyrics}
              state={lyricsState}
              active={active}
              listRef={listRef}
              lineRefs={lineRefs}
              userScrollUntil={userScrollUntil}
              clickLine={clickLine}
            />
          ) : (
            <QueueList listRef={listRef} />
          )}
        </div>
      </div>

      {/* 底部：进度 + 控制 */}
      <div className="mx-auto w-full max-w-xl shrink-0 px-6 pb-7 max-sm:px-5 max-sm:pb-5">
        <div className="text-white">
          <SeekBar duration={player.duration} currentTime={player.currentTime} barClass="h-1" />
        </div>
        <div className="flex justify-between px-1 text-[12px] tabular-nums text-white/45">
          <span>{fmtTimeSec(player.currentTime)}</span>
          <span>{player.duration ? fmtTimeSec(player.duration) : '--:--'}</span>
        </div>

        <div className="mt-3 flex items-center justify-center gap-4 max-sm:gap-3">
          <button
            className="flex h-11 w-11 items-center justify-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white"
            onClick={() => setMode(nextMode.value)}
            title={mode.title}
          >
            <UIcon name={mode.icon} size={18} />
          </button>
          <button
            className="flex h-12 w-12 items-center justify-center rounded-full text-white transition hover:bg-white/10 active:scale-95"
            onClick={prev}
            title="上一首"
          >
            <UIcon name="prev" size={22} />
          </button>
          <button
            className="flex h-16 w-16 items-center justify-center rounded-full bg-white text-ink shadow-[0_8px_28px_rgba(255,255,255,.18)] transition hover:brightness-95 active:scale-95 max-sm:h-14 max-sm:w-14"
            onClick={togglePlay}
            title={player.playing ? '暂停' : '播放'}
          >
            <UIcon name={player.playing ? 'pause' : 'play'} size={26} />
          </button>
          <button
            className="flex h-12 w-12 items-center justify-center rounded-full text-white transition hover:bg-white/10 active:scale-95"
            onClick={() => next(false)}
            title="下一首"
          >
            <UIcon name="next" size={22} />
          </button>
          <button
            className={`flex h-11 w-11 items-center justify-center rounded-full transition hover:bg-white/10 ${
              view === 'queue' ? 'text-white' : 'text-white/60 hover:text-white'
            }`}
            onClick={() => setView(view === 'queue' ? 'lyrics' : 'queue')}
            title="播放队列"
          >
            <UIcon name="queue" size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- 歌词面板 ----------
function LyricsPanel({ lyrics, state, active, listRef, lineRefs, userScrollUntil, clickLine }) {
  if (state === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-white/35">
        <span className="animate-pulse">加载歌词…</span>
      </div>
    )
  }
  if (state !== 'ok' || !lyrics?.lines?.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <UIcon name="audio" size={28} className="text-white/15" />
        <div className="text-[13px] text-white/35">未找到同名 .lrc 歌词</div>
        <div className="text-[11.5px] text-white/25">把 foo.mp3 对应的 foo.lrc 上传到同目录即可</div>
      </div>
    )
  }
  return (
    <div
      ref={listRef}
      className="lyrics-scroll relative min-h-0 flex-1 overflow-y-auto py-[38%] max-sm:py-[30%]"
      onWheel={() => (userScrollUntil.current = Date.now() + 3500)}
      onTouchMove={() => (userScrollUntil.current = Date.now() + 3500)}
    >
      {lyrics.lines.map((l, i) => (
        <div
          key={i}
          ref={(el) => (lineRefs.current[i] = el)}
          className={`cursor-pointer px-2 py-[9px] text-[16px] leading-snug transition-all duration-300 max-sm:text-[15px] ${
            i === active
              ? 'scale-[1.02] font-semibold text-white'
              : 'text-white/40 hover:text-white/70'
          }`}
          onClick={() => clickLine(i)}
        >
          {l.text || <span className="italic text-white/30">♪</span>}
        </div>
      ))}
    </div>
  )
}

// ---------- 队列面板 ----------
function QueueList({ listRef }) {
  const player = useStore((s) => s.player)
  return (
    <div ref={listRef} className="lyrics-scroll min-h-0 flex-1 overflow-y-auto pb-2">
      {player.queue.map((t, i) => {
        const cur = i === player.index
        return (
          <button
            key={`${t.bucket}/${t.path}`}
            className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition ${
              cur ? 'bg-white/10' : 'hover:bg-white/[0.06]'
            }`}
            onClick={() => playIndex(i)}
          >
            <span
              className={`w-6 shrink-0 text-center text-[12px] tabular-nums ${
                cur ? 'text-accent' : 'text-white/30'
              }`}
            >
              {cur && player.playing ? <EqBars /> : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[13.5px] ${cur ? 'font-medium text-white' : 'text-white/70'}`}>
                {t.name}
              </span>
              <span className="block truncate text-[11px] text-white/35">{t.bucket}</span>
            </span>
            {cur && <span className="shrink-0 text-[11px] text-accent">播放中</span>}
          </button>
        )
      })}
    </div>
  )
}

function EqBars() {
  return (
    <span className="eq inline-flex h-3.5 items-end gap-[2px]">
      <i /><i /><i />
    </span>
  )
}
