let onUnauthorized = () => {}

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
}

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { ...opts, headers })
  if (res.status === 401) {
    onUnauthorized()
    throw new Error('unauthorized')
  }
  let data = null
  try {
    data = await res.json()
  } catch {}
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败 (${res.status})`)
  }
  return data
}
