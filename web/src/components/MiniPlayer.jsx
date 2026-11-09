import { useStore } from '../lib/store'
import {
  MODES,
  togglePlay,
  next,
  prev,
  setMode,
  closePlayer,
  openFullscreen,
  fmtTimeSec,
} from '../lib/player'
import { UIcon, FIcon } from './icons'
import SeekBar from './SeekBar'

export default function MiniPlayer() {
  const player = useStore((s) => s.player)
  const track = player.queue[player.index]

  if (!player.visible || !track) return null
  const modeIdx = MODES.findIndex((m) => m.value === player.mode)
  const mode = MODES[modeIdx < 0 ? 0 : modeIdx]
  const nextMode = MODES[(modeIdx + 1) % MODES.length]

  return (
    <div className="pop-in fixed bottom-3 left-1/2 z-40 w-[min(680px,calc(100vw-24px))] -translate-x-1/2 max-sm:bottom-2">
      <div className="relative overflow-hidden rounded-2xl border border-line bg-card/95 shadow-[0_8px_32px_rgba(16,24,40,.16)] backdrop-blur-md">
        <div className="flex items-center gap-3 px-3.5 pb-3.5 pt-2.5">
          {/* 碟片（点击进全屏） */}
          <button
            className={`disc transition-transform duration-200 hover:scale-105 ${player.playing ? 'disc-spinning' : ''}`}
            onClick={openFullscreen}
            title="打开播放页"
          >
            <FIcon type="audio" size={34} />
          </button>

          <button className="min-w-0 flex-1 text-left" onClick={openFullscreen} title="打开播放页">
            <div className="truncate text-[13.5px] font-medium leading-tight" title={track.name}>
              {track.name}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] tabular-nums text-ink2/80">
              {fmtTimeSec(player.currentTime)} / {player.duration ? fmtTimeSec(player.duration) : '--:--'}
              <span className="max-sm:hidden"> · {track.bucket}</span>
              {player.restored && <span className="text-accent/80"> · 点播放继续</span>}
            </div>
          </button>

          {/* 控制 */}
          <div className="flex shrink-0 items-center gap-0.5">
            <button className="icon-btn h-8 w-8" onClick={prev} title="上一首">
              <UIcon name="prev" size={16} />
            </button>
            <button
              className="mx-0.5 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-white shadow-[0_2px_10px_rgba(79,110,247,.4)] transition hover:brightness-105 active:scale-95"
              onClick={togglePlay}
              title={player.playing ? '暂停' : '播放'}
            >
              <UIcon name={player.playing ? 'pause' : 'play'} size={18} />
            </button>
            <button className="icon-btn h-8 w-8" onClick={() => next(false)} title="下一首">
              <UIcon name="next" size={16} />
            </button>
            <button className="icon-btn h-8 w-8 max-sm:hidden" onClick={() => setMode(nextMode.value)} title={mode.title}>
              <UIcon name={mode.icon} size={16} />
            </button>
            <button
              className="icon-btn h-8 w-8 max-sm:hidden"
              onClick={openFullscreen}
              title="播放页（歌词 / 队列）"
            >
              <UIcon name="expand" size={16} />
            </button>
            <button
              className="icon-btn h-8 w-8 text-ink2/70 hover:text-danger hover:!bg-danger-soft"
              onClick={closePlayer}
              title="关闭播放器"
            >
              <UIcon name="close" size={15} />
            </button>
          </div>
        </div>

        {/* 进度条：贴卡片底边，hover 显示圆点，可点击/拖动 */}
        <SeekBar
          duration={player.duration}
          currentTime={player.currentTime}
          align="bottom"
          className="absolute inset-x-3 bottom-0 text-accent"
          barClass="h-[3px] group-hover/bar:h-[5px]"
        />
      </div>
    </div>
  )
}
