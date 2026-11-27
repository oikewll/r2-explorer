import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { copyText } from '../lib/format'
import { useStore } from '../lib/store'
import { t, useT } from '../lib/i18n'
import { UIcon } from './icons'
import Modal from './Modal'

// 把文件直链画成二维码，方便手机扫码打开 / 下载。
// item: { name, url, presigned? } —— presigned 表示 7 天有效的预签名直链
export default function QrModal({ item, onClose }) {
  const t = useT()
  const toast = useStore((s) => s.toast)
  const canvasRef = useRef(null)
  const [state, setState] = useState('loading') // loading | ok | error
  const [error, setError] = useState('')

  const url = item?.url || ''
  const name = item?.name || t('文件')
  const long = url.length > 300

  useEffect(() => {
    let alive = true
    setState('loading')
    setError('')
    const canvas = canvasRef.current
    if (!url || !canvas) return
    QRCode.toCanvas(canvas, url, {
      width: 1024, // 高分辨率出图，页面上再缩放，扫码更清晰
      margin: 2,
      // 预签名直链很长，降一档纠错等级压低码密度，手机更容易识别
      errorCorrectionLevel: url.length > 300 ? 'L' : 'M',
      color: { dark: '#111318', light: '#ffffff' },
    })
      .then(() => {
        if (alive) setState('ok')
      })
      .catch((e) => {
        if (alive) {
          setError(e.message || t('生成失败'))
          setState('error')
        }
      })
    return () => {
      alive = false
    }
  }, [url]) // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async () => {
    const ok = await copyText(url)
    toast(ok ? t('直链已复制') : t('复制失败'), ok ? 'info' : 'error')
  }

  const save = () => {
    try {
      const a = document.createElement('a')
      a.href = canvasRef.current.toDataURL('image/png')
      a.download = `${name.replace(/\.[^.]+$/, '') || 'file'}-${t('二维码')}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch {
      toast(t('保存二维码失败'), 'error')
    }
  }

  return (
    <Modal
      title={t('扫码打开')}
      onClose={onClose}
      width="max-w-[400px]"
      footer={
        <div className="flex gap-2">
          <button className="btn-plain flex-1" onClick={copy}>
            <UIcon name="copy" size={15} />
            {t('复制直链')}
          </button>
          <button className="btn-primary flex-1" onClick={save} disabled={state !== 'ok'}>
            <UIcon name="download" size={15} />
            {t('保存二维码')}
          </button>
        </div>
      }
    >
      <div className="flex flex-col items-center px-5 pb-5 pt-4">
        <div className="mb-3 w-full truncate text-center text-[13.5px] font-medium" title={name}>
          {name}
        </div>

        <div
          className="relative flex shrink-0 items-center justify-center rounded-xl border border-line bg-white p-2"
          // 预签名直链很长、码更密，放大一点方便手机识别
          style={{ width: long ? 288 : 248, height: long ? 288 : 248 }}
        >
          <canvas ref={canvasRef} className={`qr-canvas ${state === 'ok' ? '' : 'invisible'}`} />
          {state === 'loading' && <div className="absolute text-[13px] text-ink2">{t('正在生成…')}</div>}
          {state === 'error' && (
            <div className="absolute px-4 text-center text-[13px] text-danger">{t('二维码生成失败：') + error}</div>
          )}
        </div>

        <div className="mt-4 w-full">
          <div className="mb-1.5 text-[12px] text-ink2">{t('直链（点击可复制）')}</div>
          <button
            className="thin-scroll max-h-24 w-full overflow-auto break-all rounded-lg border border-line bg-bg px-3 py-2 text-left text-[12px] leading-relaxed text-ink2 transition hover:border-accent/50"
            onClick={copy}
            title={t('点击复制直链')}
          >
            {url}
          </button>
        </div>

        <div className="mt-3 w-full space-y-1 text-[12px] leading-relaxed text-ink2">
          <div>{t('用手机相机或微信「扫一扫」，即可在手机上打开 / 下载这个文件。')}</div>
          {item?.presigned && (
            <div className="text-ink2/80">{t('这是 7 天有效的预签名直链，过期后请重新生成二维码。')}</div>
          )}
          {long && (
            <div className="text-ink2/80">{t('链接较长，二维码较密，建议靠近屏幕扫描，或直接复制链接发送。')}</div>
          )}
        </div>
      </div>
    </Modal>
  )
}
