import { api } from './api'
import { useStore } from './store'

// 拉取账号列表 + 桶列表，写入 store
export async function loadAccountsAndBuckets() {
  try {
    const acc = await api('/api/accounts')
    useStore.getState().setAccounts(acc.accounts || [], acc.activeId || '')
  } catch (e) {
    if (e.message !== 'unauthorized') throw e
    return
  }
  try {
    const data = await api('/api/buckets')
    useStore.getState().setBuckets(data.buckets || [])
  } catch (e) {
    if (e.message !== 'unauthorized') throw e
  }
}
