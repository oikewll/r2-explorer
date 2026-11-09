import { useEffect } from 'react'
import { api, setUnauthorizedHandler } from './lib/api'
import { useHashRoute, navigate } from './lib/hash'
import { useStore } from './lib/store'
import { loadAccountsAndBuckets } from './lib/loader'
import Login from './components/Login'
import Header from './components/Header'
import Buckets from './components/Buckets'
import Explorer from './components/Explorer'
import Accounts from './components/Accounts'
import CreateBucket from './components/CreateBucket'
import UploadPanel from './components/UploadPanel'
import Toasts from './components/Toasts'

export default function App() {
  const authed = useStore((s) => s.authed)
  const setAuthed = useStore((s) => s.setAuthed)
  const accountsOpen = useStore((s) => s.accountsOpen)
  const setAccountsOpen = useStore((s) => s.setAccountsOpen)
  const createBucketOpen = useStore((s) => s.createBucketOpen)
  const setCreateBucketOpen = useStore((s) => s.setCreateBucketOpen)
  const route = useHashRoute()

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthed(false)
      setAccountsOpen(false)
      setCreateBucketOpen(false)
    })
    api('/api/me')
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false))
  }, [])

  useEffect(() => {
    if (authed) loadAccountsAndBuckets().catch(() => {})
  }, [authed])

  if (!authed) return <Login onOk={() => setAuthed(true)} />

  return (
    <div className="min-h-dvh">
      <Header route={route} />
      <main className="mx-auto max-w-[920px] px-4 pb-28 pt-4">
        {route.bucket ? (
          <Explorer key={route.bucket + '/' + route.prefix} route={route} />
        ) : (
          <Buckets />
        )}
      </main>
      {accountsOpen && <Accounts onClose={() => setAccountsOpen(false)} />}
      {createBucketOpen && (
        <CreateBucket
          onClose={() => setCreateBucketOpen(false)}
          onCreated={async () => {
            await loadAccountsAndBuckets().catch(() => {})
          }}
        />
      )}
      <UploadPanel />
      <Toasts />
    </div>
  )
}
