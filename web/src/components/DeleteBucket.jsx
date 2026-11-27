import { useState } from 'react'
import { api } from '../lib/api'
import { fmtNum } from '../lib/format'
import { useStore } from '../lib/store'
import { t, useT } from '../lib/i18n'
import Modal from './Modal'

// 删除存储桶：高危操作，要求手动输入完整桶名才能确认
export default function DeleteBucket({ bucket, onClose, onDeleted }) {
  const t = useT()
  const toast = useStore((s) => s.toast)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const matched = name.trim() === bucket.name

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await api('/api/buckets/' + encodeURIComponent(bucket.name), { method: 'DELETE' })
      toast(t('已删除存储桶：') + bucket.name)
      onDeleted(bucket.name)
      onClose()
    } catch (e) {
      if (e.message !== 'unauthorized') setError(e.message)
      setBusy(false)
    }
  }

  return (
    <Modal title={t('删除存储桶')} onClose={onClose} width="max-w-[400px]">
      <div className="px-5 py-5">
        <div className="text-[14px] leading-relaxed text-ink">
          {t('即将删除存储桶 ')}<span className="break-all font-mono font-medium text-danger">{bucket.name}</span>
          {bucket.stats ? (
            <span className="text-ink2">
              {t('（{n} 个对象，{size}）', { n: fmtNum(bucket.stats.objects), size: bucket.stats.sizeText })}
            </span>
          ) : null}
          {t('，删除后无法恢复。')}
        </div>
        <div className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[13px] leading-relaxed text-danger">
          {t('仅允许删除空桶。若桶内还有文件，请先清空后再删除。')}
        </div>
        <input
          className="input mt-4 font-mono text-[13px]"
          placeholder={bucket.name}
          value={name}
          autoFocus
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && matched && submit()}
        />
        <div className="mt-2 text-[12px] text-ink2">{t('请输入完整桶名以确认删除')}</div>
        <div className="mt-1.5 min-h-[18px] text-[13px] text-danger">{error}</div>
        <div className="flex justify-end gap-2">
          <button className="btn-plain" onClick={onClose} disabled={busy}>
            {t('取消')}
          </button>
          <button className="btn-danger" onClick={submit} disabled={busy || !matched}>
            {busy ? t('删除中…') : t('删除')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
