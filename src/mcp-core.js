// ---------- MCP 只读服务（/mcp）----------
// 手写 JSON-RPC 2.0（Streamable HTTP 最小合规子集），零依赖，Workers / Node 双端可用：
// - 仅 POST，无会话状态（不签发 Mcp-Session-Id），每次请求独立处理
// - 方法：initialize / notifications/* / tools/list / tools/call / ping
// - 安全：Bearer MCP_TOKEN；未配置或校验失败一律 404，不暴露端点存在性
// - 只读：v1 只注册 7 个查询类工具；写操作规划见 docs/mcp-readonly-design.md §9
//
// 用法：registerMcp(app, { version, getToken, makeBackend })
//   getToken(c)    -> string | undefined（未配置时端点整体关闭）
//   makeBackend(c) -> backend | null（每请求构建；无可用 R2 账号时为 null）
// backend 七个方法全部只读，任一失败直接 throw Error（message 会透传给 Agent 自纠错）

const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
export const TEXT_HEAD_PROBE = 8192 // 二进制探测：前 8KB 出现 NUL 即拒绝

// 常量时间字符串比较（Workers / Node 通用，避免依赖 node:crypto）
function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ---------- 参数校验（校验失败 throw，由 tools/call 包装成 isError 结果） ----------

function reqBucket(args) {
  const v = args?.bucket
  if (typeof v !== 'string' || !v.trim() || v.includes('/')) {
    throw new Error('参数 bucket 必须是非空的存储桶名（不含 /），可先用 list_buckets 查看可用桶')
  }
  return v
}

function reqKey(args) {
  const v = args?.key
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error('参数 key 必须是文件的完整路径（不含桶名，例如 "photos/cat.jpg"）')
  }
  if (v.endsWith('/')) {
    throw new Error('key 不能以 / 结尾（那是目录前缀；查看目录内容请用 list_objects）')
  }
  return v
}

function optPrefix(args) {
  const v = args?.prefix
  if (v === undefined || v === null || v === '') return ''
  if (typeof v !== 'string' || (v && !v.endsWith('/'))) {
    throw new Error('参数 prefix 是目录前缀，必须以 / 结尾（根目录不传或传空串）')
  }
  return v
}

function optInt(args, name, def, min, max) {
  const raw = args?.[name]
  if (raw === undefined || raw === null || raw === '') return def
  const v = Number(raw)
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new Error(`参数 ${name} 必须是 ${min}–${max} 之间的数字`)
  }
  return Math.round(v)
}

// ---------- 工具定义 ----------

const TOOLS = [
  {
    name: 'list_buckets',
    description:
      '列出当前激活的 Cloudflare 账号下所有 R2 存储桶。objects/sizeText 为缓存统计，缺失表示暂无缓存（可用 bucket_stats 现算）。bucket 名用于其他所有工具的 bucket 参数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, b) {
      return b.listBuckets()
    },
  },
  {
    name: 'bucket_stats',
    description:
      '获取单个存储桶的统计：对象总数、总大小、按类型（image/video/audio/document/other）分布、最后更新时间。超大桶最多扫描 5 万个对象，超出时返回 truncated: true（数字为下限估计）。',
    inputSchema: {
      type: 'object',
      properties: { bucket: { type: 'string', description: '存储桶名' } },
      required: ['bucket'],
      additionalProperties: false,
    },
    async run(args, b) {
      return b.bucketStats(reqBucket(args))
    },
  },
  {
    name: 'list_objects',
    description:
      '列出存储桶中某个目录的下一层内容。R2 没有真实目录：目录即以 / 结尾的 key 前缀。返回 dirs（子目录，path 可直接作 prefix 传入）和 files（含 size/modified/url），truncated: true 表示该层超过 1000 条，需用更深的 prefix 缩小范围。',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: { type: 'string', description: '存储桶名' },
        prefix: { type: 'string', description: '目录前缀，以 / 结尾；不传为根目录' },
      },
      required: ['bucket'],
      additionalProperties: false,
    },
    async run(args, b) {
      return b.listObjects(reqBucket(args), optPrefix(args))
    },
  },
  {
    name: 'search_objects',
    description:
      '在存储桶内递归搜索文件：按完整路径大小写不敏感子串匹配，最多扫描 5 万个对象。more: true 表示可能还有未返回的匹配，可用 prefix 缩小范围或换更精确的关键词。',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: { type: 'string', description: '存储桶名' },
        q: { type: 'string', description: '搜索关键字（匹配文件完整路径的子串）' },
        prefix: { type: 'string', description: '可选，限定搜索的目录前缀（以 / 结尾）' },
        limit: { type: 'number', description: '返回条数上限，默认 50，最大 200' },
      },
      required: ['bucket', 'q'],
      additionalProperties: false,
    },
    async run(args, b) {
      const q = args?.q
      if (typeof q !== 'string' || !q.trim()) throw new Error('参数 q（搜索关键字）不能为空')
      return b.searchObjects(reqBucket(args), q.trim(), optPrefix(args), optInt(args, 'limit', 50, 1, 200))
    },
  },
  {
    name: 'get_file_info',
    description:
      '获取单个文件的元信息：大小、Content-Type、ETag、修改时间、下载直链 url。CDN 桶返回公开直链，其他桶返回最长 7 天有效的预签名 URL。',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: { type: 'string', description: '存储桶名' },
        key: { type: 'string', description: '文件完整路径（不含桶名）' },
      },
      required: ['bucket', 'key'],
      additionalProperties: false,
    },
    async run(args, b) {
      return b.getFileInfo(reqBucket(args), reqKey(args))
    },
  },
  {
    name: 'read_text_file',
    description:
      '读取文本文件内容（utf-8）。仅支持 ≤2MB 的文件，超过 maxChars（默认 65536 字符）截断并标记 truncated: true；二进制文件会拒绝。适合 json/csv/md/txt/日志等小文本，二进制请改用 get_file_info 拿下载直链。',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: { type: 'string', description: '存储桶名' },
        key: { type: 'string', description: '文件完整路径（不含桶名）' },
        maxChars: { type: 'number', description: '返回的最大字符数，默认 65536，最大 262144' },
      },
      required: ['bucket', 'key'],
      additionalProperties: false,
    },
    async run(args, b) {
      return b.readTextFile(reqBucket(args), reqKey(args), optInt(args, 'maxChars', 65536, 1024, 262144))
    },
  },
  {
    name: 'get_file_url',
    description:
      '获取文件下载直链。配置了 CDN 映射的桶返回公开 CDN 链接（expiresIn 不生效）；其余返回预签名 URL，有效期 expiresIn 秒（3600–604800，默认 604800 即 7 天）。',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: { type: 'string', description: '存储桶名' },
        key: { type: 'string', description: '文件完整路径（不含桶名）' },
        expiresIn: { type: 'number', description: '预签名有效期（秒），默认 7 天' },
      },
      required: ['bucket', 'key'],
      additionalProperties: false,
    },
    async run(args, b) {
      return b.getFileUrl(reqBucket(args), reqKey(args), optInt(args, 'expiresIn', 604800, 3600, 604800))
    },
  },
]

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]))

// ---------- JSON-RPC 响应构造 ----------

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

// 工具结果：结构化 JSON 以 text content 返回；工具级错误走 isError（便于 Agent 自纠错）
const textContent = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] })
const errorContent = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true })

// ---------- 注册 ----------

export function registerMcp(app, { version = '1.0.0', path = '/mcp', getToken, makeBackend }) {
  const handle = async (c) => {
    // 鉴权：未配置 token 或校验失败一律 404（与「未启用」不可区分）
    const token = getToken(c)
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') || '')
    if (!token || !m || !timingSafeEqualStr(m[1].trim(), token)) return c.body(null, 404)

    // MCP 只走 POST；GET（SSE 探测）/DELETE（会话终止）明确回 405
    if (c.req.method !== 'POST') return c.body(null, 405)

    let msg
    try {
      msg = await c.req.json()
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'))
    }
    const { id, method, params } = msg || {}
    if (!method || typeof method !== 'string') {
      return c.json(rpcError(id ?? null, -32600, 'Invalid Request'))
    }

    // notification（无 id）：无需响应
    if (id === undefined || id === null) return c.body(null, 204)

    switch (method) {
      case 'initialize': {
        const pv = params?.protocolVersion
        return c.json(
          rpcResult(id, {
            protocolVersion: typeof pv === 'string' && pv ? pv : DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'r2-explorer', title: 'R2 Explorer', version },
          })
        )
      }
      case 'ping':
        return c.json(rpcResult(id, {}))
      case 'tools/list':
        return c.json(
          rpcResult(id, {
            tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          })
        )
      case 'tools/call': {
        const tool = TOOL_MAP.get(params?.name)
        if (!tool) return c.json(rpcError(id, -32602, `未知工具: ${params?.name}`))
        if (!makeBackend || !makeBackend(c)) {
          return c.json(rpcError(id, -32603, '未配置 R2 凭证（请在网页账号管理里绑定，或设置 R2_* 环境变量）'))
        }
        const args = params?.arguments
        if (args !== undefined && args !== null && typeof args !== 'object') {
          return c.json(rpcResult(id, errorContent('arguments 必须是对象')))
        }
        try {
          const out = await tool.run(args || {}, makeBackend(c))
          return c.json(rpcResult(id, textContent(out)))
        } catch (e) {
          return c.json(rpcResult(id, errorContent(String(e?.message || e))))
        }
      }
      default:
        return c.json(rpcError(id, -32601, `Method not found: ${method}`))
    }
  }

  app.on('POST', [path], handle)
  app.on('GET', [path], handle)
  app.on('DELETE', [path], handle)
}
