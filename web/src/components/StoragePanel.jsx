import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { fmtNum, fmtSize } from '../lib/format'
import { useStore } from '../lib/store'
import { t, useT } from '../lib/i18n'
import { FIcon } from './icons'

// 套餐：free（免费版）/ paid（付费版）/ unknown（未配置 CF API Token）
function usePlan(activeId, reloadKey) {
  const [plan, setPlan] = useState(null)
  useEffect(() => {
    let cancelled = false
    api('/api/plan')
      .then((d) => !cancelled && setPlan(d))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [activeId, reloadKey])
  return plan
}

// 分类配色（亮/暗主题下都可读）
const TYPES = [
  { key: 'image', name: '图片', color: '#3b82f6' },
  { key: 'video', name: '视频', color: '#f59e0b' },
  { key: 'audio', name: '音频', color: '#8b5cf6' },
  { key: 'document', name: '文档', color: '#10b981' },
  { key: 'other', name: '其他', color: '#94a3b8' },
]

// 聚合所有桶的统计（后端有 1 小时缓存，重复拉取代价很低）
function useAggregatedStats(buckets) {
  const [data, setData] = useState(null)
  const [pending, setPending] = useState(0)
  const failed = useRef(new Set())

  useEffect(() => {
    failed.current = new Set()
    if (!buckets.length) {
      setData({ objects: 0, size: 0, byType: {} })
      setPending(0)
      return
    }
    let cancelled = false
    setData(null)
    setPending(buckets.length)
    const acc = { objects: 0, size: 0, byType: {} }
    const timers = buckets.map((b, i) =>
      setTimeout(async () => {
        if (cancelled) return
        try {
          const res = await api('/api/stats?bucket=' + encodeURIComponent(b.name))
          const st = res.stats
          if (st) {
            acc.objects += st.objects || 0
            acc.size += st.size || 0
            for (const [k, v] of Object.entries(st.byType || {})) {
              const t = (acc.byType[k] ||= { count: 0, size: 0 })
              t.count += v.count || 0
              t.size += v.size || 0
            }
          }
        } catch (e) {
          if (e.message === 'unauthorized') cancelled = true
          else failed.current.add(b.name)
        }
        if (cancelled) return
        // 每回来一个桶的结果就刷新，进度是渐进的
        setData({ objects: acc.objects, size: acc.size, byType: { ...acc.byType } })
        setPending((p) => p - 1)
      }, i * 120)
    )
    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [buckets])

  return { data, pending, failed }
}

function Donut({ byType, total, loading }) {
  const R = 46
  const C = 2 * Math.PI * R
  const segs = TYPES.filter((t) => (byType[t.key]?.size || 0) > 0)
  const totalSize = segs.reduce((s, t) => s + byType[t.key].size, 0)
  let offset = 0

  return (
    <div className="relative mx-auto h-[150px] w-[150px]">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        {/* 底环 */}
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth="15" className="stroke-line" />
        {segs.map((t) => {
          const frac = totalSize ? byType[t.key].size / totalSize : 0
          const len = frac * C
          const el = (
            <circle
              key={t.key}
              cx="60"
              cy="60"
              r={R}
              fill="none"
              stroke={t.color}
              strokeWidth="15"
              strokeDasharray={`${Math.max(len - 1.5, 0.5)} ${C - Math.max(len - 1.5, 0.5)}`}
              strokeDashoffset={-offset}
              className="transition-all duration-700"
            />
          )
          offset += len
          return el
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {loading ? (
          <div className="text-[12px] text-ink2">{t('统计中…')}</div>
        ) : (
          <>
            <div className="text-[11px] text-ink2">{t('已用空间')}</div>
            <div className="mt-0.5 text-[17px] font-semibold leading-tight">{fmtSize(total)}</div>
          </>
        )}
      </div>
    </div>
  )
}

export default function StoragePanel({ buckets }) {
  const t = useT()
  const { data, pending, failed } = useAggregatedStats(buckets)
  const activeId = useStore((s) => s.activeId)
  const accounts = useStore((s) => s.accounts)
  const plan = usePlan(activeId, accounts)
  const loading = !data || pending > 0
  const byType = data?.byType || {}
  const rows = TYPES.map((t) => ({ ...t, ...(byType[t.key] || { count: 0, size: 0 }) }))
  const totalSize = data?.size || 0
  const hasFail = failed.current.size > 0 && pending === 0

  // 套餐徽标文案
  const planBadge =
    plan?.plan === 'free'
      ? { text: t('免费版'), cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' }
      : plan?.plan === 'paid'
        ? { text: t('付费版'), cls: 'bg-accent-soft text-accent' }
        : null

  return (
    <div className="card p-5 lg:sticky lg:top-[72px]">
      {planBadge && (
        <div className="mb-3 flex justify-end">
          <span className={'rounded-md px-1.5 py-px text-[11px] font-medium ' + planBadge.cls}>{planBadge.text}</span>
        </div>
      )}

      {buckets.length === 0 ? (
        <div className="flex flex-col items-center py-10 text-[13px] text-ink2">
          <FIcon type="bucket" size={44} />
          <div className="mt-3">{t('还没有存储桶')}</div>
        </div>
      ) : (
        <>
          <div>
            <Donut byType={byType} total={data?.size || 0} loading={!data} />
          </div>

          <div className="mt-2 text-center text-[12px] text-ink2">
            {t('共 {n} 个文件', { n: loading ? '…' : fmtNum(data.objects) })}
            {hasFail && <span className="ml-1 text-danger">{t('（{n} 个桶统计失败）', { n: failed.current.size })}</span>}
          </div>

          <div className="mt-4 space-y-3.5">
            {rows.map((r) => {
              const pct = totalSize ? (r.size / totalSize) * 100 : 0
              return (
                <div key={r.key}>
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
                      <span className="text-[13px] font-medium">{t(r.name)}</span>
                      <span className="truncate text-[12px] text-ink2">{r.count ? t('{n} 个', { n: fmtNum(r.count) }) : ''}</span>
                    </div>
                    <span className="shrink-0 text-[12px] text-ink2">{r.size ? fmtSize(r.size) : ''}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line/70">
                    <div
                      className="h-full rounded-full transition-all duration-700"
                      style={{ width: pct + '%', background: r.color }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
