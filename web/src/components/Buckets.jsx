import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { fmtNum, fmtTime } from '../lib/format'
import { navigate } from '../lib/hash'
import { loadAccountsAndBuckets } from '../lib/loader'
import { useStore } from '../lib/store'
import { FIcon, UIcon } from './icons'
import DeleteBucket from './DeleteBucket'

function BucketCard({ bucket, index, onDelete }) {
  const [stats, setStats] = useState(bucket.stats || null)
  const failed = useRef(false)

  useEffect(() => {
    if (stats || failed.current) return
    const t = setTimeout(async () => {
      try {
        const data = await api('/api/stats?bucket=' + encodeURIComponent(bucket.name))
        setStats(data.stats)
      } catch (e) {
        if (e.message !== 'unauthorized') failed.current = true
      }
    }, index * 150)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      role="button"
      tabIndex={0}
      className="card group relative cursor-pointer p-5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(16,24,40,.09)] active:translate-y-0"
      onClick={() => navigate(bucket.name, '')}
      onKeyDown={(e) => e.key === 'Enter' && navigate(bucket.name, '')}
    >
      <button
        title="删除存储桶"
        aria-label={'删除存储桶 ' + bucket.name}
        className="absolute right-3 top-3 rounded-lg p-1.5 text-ink2/50 opacity-0 transition-all hover:bg-danger-soft hover:text-danger focus:opacity-100 group-hover:opacity-100 max-sm:opacity-60"
        onClick={(e) => {
          e.stopPropagation()
          onDelete({ ...bucket, stats })
        }}
      >
        <UIcon name="trash" size={15} />
      </button>
      <div className="flex items-center gap-3">
        <FIcon type="bucket" size={34} />
        <div className="truncate font-medium text-[15px] group-hover:text-accent transition-colors">{bucket.name}</div>
      </div>
      <div className="mt-4 flex items-baseline justify-between text-[13px] text-ink2">
        <span>{stats ? fmtNum(stats.objects) + ' 个对象' : '统计中…'}</span>
        <span className="font-medium text-ink">{stats ? stats.sizeText : ''}</span>
      </div>
      <div className="mt-1 text-[12px] text-ink2/70">
        {failed.current ? '统计失败' : stats ? (stats.modifiedText ? '更新 ' + fmtTime(stats.lastModified) : '空桶') : ''}
      </div>
    </div>
  )
}

export default function Buckets() {
  const buckets = useStore((s) => s.buckets)
  const setCreateBucketOpen = useStore((s) => s.setCreateBucketOpen)
  const [deleteTarget, setDeleteTarget] = useState(null)

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-[17px] font-semibold">存储桶</h1>
        <button className="btn-primary" onClick={() => setCreateBucketOpen(true)}>
          <UIcon name="plus" size={15} />
          新建存储桶
        </button>
      </div>
      {buckets.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center text-[14px] text-ink2">
          <FIcon type="bucket" size={56} />
          <div className="mt-3 leading-relaxed">
            账号下没有找到 R2 存储桶
            <br />
            点击右上角「新建存储桶」创建一个
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {buckets.map((b, i) => (
            <BucketCard key={b.name} bucket={b} index={i} onDelete={setDeleteTarget} />
          ))}
        </div>
      )}
      {deleteTarget && (
        <DeleteBucket
          bucket={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => loadAccountsAndBuckets().catch(() => {})}
        />
      )}
    </div>
  )
}
