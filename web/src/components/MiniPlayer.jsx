import { useCallback, useRef } from 'react'
import { useStore } from '../lib/store'
import { fmtTimeSec } from '../lib/player'
import { seek, seekStart, seekPreview, togglePlay, next, prev, setMode, closePlayer } from '../lib/player'
import { FIcon, UIcon } from './icons'

const MODES = [
  { value: 'order', icon: 'repeat', title: '顺序循环' },
  { value: 'one', icon: 'repeat1', title: '单曲循环' },
  { value: 'shuffle', icon: 'shuffle', title: '随机播放' },
]

export default function MiniPlayer() {
  const player = useStore((s) => s.player)
  const barRef = useRef(null)

  const track = player.queue[player.index]

  const onBarSeek = useCallback(
    (e) => {
      const bar = barRef.current
      if (!bar || !player.duration) return
      const rect = bar.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      seek(ratio * player.duration)
    },
    [player.duration]
  )

  if (!player.visible || !track) return null
  const modeIdx = MODES.findIndex((m) => m.value === player.mode)
  const mode = MODES[modeIdx < 0 ? 0 : modeIdx]
  const nextMode = MODES[(modeIdx + 1) % MODES.length]

  return (
    <div className="pop-in fixed bottom-3 left-1/2 z-40 w-[min(680px,calc(100vw-24px))] -translate-x-1/2 max-sm:bottom-2">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-card shadow-[0_10px_36px_rgba(16,24,40,.16)]">
        {/* 进度条（贴卡片顶部，点击/拖动跳转） */}
        <div
          ref={barRef}
          className="group/bar absolute inset-x-0 top-0 z-10 h-4 cursor-pointer"
          onMouseDown={(e) => {
            seekStart()
            onBarSeek(e)
            const move = (ev) => seekPreview(Math.min(1, Math.max(0, (ev.clientX - barRef.current.getBoundingClientRect().left) / barRef.current.getBoundingClientRect().width)) * player.duration)
            const up = (ev) => {
              document.removeEventListener('mousemove', move)
              document.removeEventListener('mouseup', up)
              const rect = barRef.current.getBoundingClientRect()
              seek(Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)) * player.duration)
            }
            document.addEventListener('mousemove', move)
            document.addEventListener('mouseup', up)
          }}
        >
          <div
            className={`absolute inset-x-0 top-0 h-1 transition-[height] group-hover/bar:h-1.5 ${player.playing ? '' : ''}`}
          >
            <div className="h-full rounded-full bg-accent/25">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: player.duration ? (player.currentTime / player.duration) * 100 + '%' : '0%' }}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 px-3.5 pb-2.5 pt-3">
          {/* 转动的碟片 */}
          <div className={`disc ${player.playing ? 'disc-spinning' : ''}`}>
            <FIcon type="audio" size={34} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium leading-tight" title={track.name}>
              {track.name}
            </div>
            <div className="mt-0.5 text-[11.5px] tabular-nums text-ink2/80">
              {fmtTimeSec(player.currentTime)} / {player.duration ? fmtTimeSec(player.duration) : '--:--'}
              <span className="max-sm:hidden"> · {track.bucket}</span>
              {player.restored && <span className="text-accent/80"> · 点播放继续</span>}
            </div>
          </div>

          {/* 控制 */}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              className="icon-btn h-8 w-8"
              onClick={prev}
              title="上一首"
            >
              <UIcon name="prev" size={16} />
            </button>
            <button
              className="mx-0.5 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-white shadow-[0_2px_10px_rgba(79,110,247,.4)] transition active:scale-95 hover:brightness-105"
              onClick={togglePlay}
              title={player.playing ? '暂停' : '播放'}
            >
              <UIcon name={player.playing ? 'pause' : 'play'} size={18} />
            </button>
            <button
              className="icon-btn h-8 w-8"
              onClick={() => next(false)}
              title="下一首"
            >
              <UIcon name="next" size={16} />
            </button>
            <button className="icon-btn h-8 w-8 max-sm:hidden" onClick={() => setMode(nextMode.value)} title={mode.title}>
              <UIcon name={mode.icon} size={16} />
            </button>
            <button className="icon-btn h-8 w-8 text-ink2/70 hover:text-danger hover:!bg-danger-soft" onClick={closePlayer} title="关闭播放器">
              <UIcon name="close" size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
