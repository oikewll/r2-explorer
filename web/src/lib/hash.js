export function buildHash(bucket, prefix) {
  const p = prefix.split('/').map(encodeURIComponent).join('/')
  return `#/${encodeURIComponent(bucket)}/${p}`
}

export function parseHash() {
  const h = location.hash.replace(/^#\/?/, '')
  if (!h) return { bucket: '', prefix: '' }
  const parts = h.split('/')
  const bucket = decodeURIComponent(parts[0] || '')
  const prefix = parts.slice(1).map(decodeURIComponent).join('/')
  return { bucket, prefix }
}

export function navigate(bucket, prefix) {
  location.hash = buildHash(bucket, prefix)
}

import { useEffect, useState } from 'react'

export function useHashRoute() {
  const [route, setRoute] = useState(parseHash())
  useEffect(() => {
    const fn = () => setRoute(parseHash())
    window.addEventListener('hashchange', fn)
    return () => window.removeEventListener('hashchange', fn)
  }, [])
  return route
}
