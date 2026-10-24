// Telegram 部署通知：成功/失败都推，推送失败不影响主流程
// 用法参考 ~/projects/notify-integration.md
const USER_AGENT = 'curl/8.7.1' // Worker 会拦脚本默认 UA，显式伪装
const TIMEOUT_MS = 10_000

function buildFields({ status, tag }) {
  const ok = status === 'success'
  return [
    { label: '事件', value: 'R2 Explorer 部署' },
    { label: '版本', value: tag && tag !== 'null' ? tag : 'manual' },
    { label: '状态', value: ok ? '✅ 成功' : '❌ 失败' },
    { label: '线上', value: 'https://r2.example.com' },
    {
      label: 'Actions',
      value: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    },
  ]
}

async function sendWebhook(url, fields) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      fields: fields.map(({ label, value }) => ({ label: String(label), value: String(value) })),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Webhook 返回 HTTP ${response.status}`)
}

async function main() {
  const url = process.env.TELEGRAM_WEBHOOK_URL
  if (!url) {
    console.error('::warning::TELEGRAM_WEBHOOK_URL 未配置，跳过推送')
    return 0
  }
  const status = process.env.JOB_STATUS || 'unknown'
  try {
    await sendWebhook(url, buildFields({ status, tag: process.env.TAG }))
    console.log('Telegram 推送已发送')
  } catch (error) {
    console.error(`::warning::Telegram 推送失败: ${error.message}`)
  }
  return 0
}

process.exit(await main())
