/**
 * dafeiyu-qq-panel —— 浏览器半。
 *
 * 在「设置 → 插件」里加一页「QQ 桥接面板」，直接读写 dsh-qq-bridge 自己的本机接口
 * `/api/qq-bridge/settings`（GET 读、POST 写）。不碰宿主的 settings 服务 ——
 * 那套对第三方插件在 0.2.x 上基本拿不到可写域，绕开它最省事。
 *
 * 格式说明：DSH 的 client 半没有对外发布的打包预设，只能手写
 * `window.__ModuleLoader__.load({ id, factory })`。id 必须等于包名。
 */
window.__ModuleLoader__.load({
  id: 'dafeiyu-qq-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const API = '/api/qq-bridge/settings'
    const NAPCAT_API = '/api/qq-bridge/napcat'

    // ── 表单定义：加一项 = 加一行 ───────────────────────────────────────────
    const FIELDS = [
      { key: 'targetSessionId', label: '目标会话', kind: 'text', hint: 'QQ 的消息都注入这一个会话' },
      { key: 'onebotUrl', label: 'OneBot 地址', kind: 'text', hint: '如 ws://127.0.0.1:3002' },
      { key: 'accessTokenEnv', label: 'token 凭据名', kind: 'text', hint: '凭据引用名，不是明文 token' },
      { key: 'selfId', label: '机器人 QQ 号', kind: 'text' },
      { key: 'whitelist', label: '私聊白名单', kind: 'list', hint: '一行一个 QQ 号' },
      { key: 'groupWhitelist', label: '群白名单', kind: 'list', hint: '一行一个群号' },
      { key: 'nicknames', label: '唤醒昵称', kind: 'list', hint: '叫这些名字也算叫我' },
      { key: 'atOnlyInGroup', label: '群里只认 @', kind: 'boolean' },
      { key: 'wakeProbability', label: '概率唤醒', kind: 'number', hint: '0~1，1 = 每条都醒' },
      { key: 'replyMode', label: '出站方式', kind: 'select', options: ['marker', 'tool', 'always'] },
      { key: 'delivery', label: '投递方式', kind: 'select', options: ['auto', 'followup', 'steer'] },
      { key: 'replyMaxChars', label: '单条字数上限', kind: 'number' },
      { key: 'attachRecentChat', label: '附带最近聊天', kind: 'boolean' },
      { key: 'recentChatLimit', label: '附带条数', kind: 'number' },
      { key: 'stripMarkdown', label: '去掉 Markdown', kind: 'boolean' },
      { key: 'replyWithQuote', label: '引用原消息', kind: 'boolean' },
      { key: 'heartbeatTimeoutMs', label: '心跳超时(ms)', kind: 'number' },
      { key: 'visionModel', label: '识图模型', kind: 'text', hint: '留空 = 自动挑' },
      { key: 'onebotPort', label: 'NapCat WS 端口', kind: 'number' },
      { key: 'qqNumber', label: 'NapCat 登录号', kind: 'text' },
    ]

    const S = {
      wrap: { padding: '4px 2px', fontSize: 13, lineHeight: 1.6 },
      head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
      title: { fontSize: 14, fontWeight: 600 },
      sub: { opacity: 0.66, fontSize: 12 },
      row: { display: 'grid', gridTemplateColumns: '180px 1fr', gap: 10, alignItems: 'center', padding: '6px 0' },
      label: { opacity: 0.85 },
      input: {
        width: '100%',
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        boxSizing: 'border-box',
      },
      area: {
        width: '100%',
        minHeight: 64,
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        boxSizing: 'border-box',
      },
      hint: { opacity: 0.5, fontSize: 11, marginTop: 2 },
      btn: {
        padding: '6px 14px',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,0.4)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      btnPrimary: {
        padding: '6px 14px',
        borderRadius: 6,
        border: '1px solid rgba(80,140,255,0.6)',
        background: 'rgba(80,140,255,0.16)',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      err: { color: '#e05a5a', fontSize: 12, marginTop: 6 },
      ok: { color: '#3fa96a', fontSize: 12, marginTop: 6 },
      foot: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 },
      badge: { fontSize: 11, opacity: 0.55, marginLeft: 'auto' },
    }

    function toDraft(values) {
      const d = {}
      for (const f of FIELDS) {
        const v = values?.[f.key]
        if (f.kind === 'list') d[f.key] = Array.isArray(v) ? v.join('\n') : ''
        else if (f.kind === 'boolean') d[f.key] = v === true
        else if (f.kind === 'number') d[f.key] = v === undefined || v === null ? '' : String(v)
        else d[f.key] = v === undefined || v === null ? '' : String(v)
      }
      return d
    }

    /** 把草稿转回接口要的值；空字符串的数字/文本一律跳过（= 不改）。 */
    function toPatch(draft) {
      const patch = {}
      for (const f of FIELDS) {
        const raw = draft[f.key]
        if (f.kind === 'list') {
          patch[f.key] = String(raw ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        } else if (f.kind === 'boolean') {
          patch[f.key] = raw === true
        } else if (f.kind === 'number') {
          if (raw === '' || raw === null || raw === undefined) continue
          const n = Number(raw)
          if (Number.isFinite(n)) patch[f.key] = n
        } else {
          patch[f.key] = String(raw ?? '')
        }
      }
      return patch
    }

    async function apiGet() {
      const res = await fetch(API, { cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
      return body
    }

    async function apiPost(payload) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
      return body
    }

    // ── 卡片 ────────────────────────────────────────────────────────────────
    function Panel() {
      const [loading, setLoading] = react.useState(true)
      const [draft, setDraft] = react.useState(null)
      const [base, setBase] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [note, setNote] = react.useState('')

      const reload = react.useCallback(async () => {
        setError('')
        try {
          const body = await apiGet()
          const d = toDraft(body.values)
          setDraft(d)
          setBase(d)
          setLoading(false)
        } catch (e) {
          setLoading(false)
          setError(String(e?.message ?? e))
        }
      }, [])

      react.useEffect(() => {
        void reload()
      }, [reload])

      if (loading) return h('div', { style: S.wrap }, h('div', { style: S.sub }, '读取桥接设置中…'))
      if (error && !draft) {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.title }, 'QQ 桥接面板'),
          h('div', { style: S.err }, `读不到设置：${error}`),
          h('div', { style: S.hint }, `接口是 ${API}。确认 dsh-qq-bridge 装着、DSH 的 webServer 服务在。`),
          h('div', { style: S.foot }, h('button', { style: S.btn, onClick: () => void reload() }, '重试')),
        )
      }

      const set = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }))
      const dirty = base && draft && JSON.stringify(base) !== JSON.stringify(draft)

      const save = async () => {
        setBusy(true)
        setError('')
        setNote('')
        try {
          const body = await apiPost({ set: toPatch(draft) })
          const d = toDraft(body.values)
          setDraft(d)
          setBase(d)
          setNote('已保存，改动立刻生效（地址变了会自动重连）')
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }

      const reset = () => {
        setDraft(base)
        setError('')
        setNote('')
      }

      const rows = FIELDS.map((f) => {
        const value = draft[f.key]
        let control
        if (f.kind === 'boolean') {
          control = h('input', {
            type: 'checkbox',
            checked: value === true,
            onChange: (e) => set(f.key, e.target.checked),
          })
        } else if (f.kind === 'list') {
          control = h('textarea', {
            style: S.area,
            value,
            onChange: (e) => set(f.key, e.target.value),
          })
        } else if (f.kind === 'select') {
          control = h(
            'select',
            { style: S.input, value, onChange: (e) => set(f.key, e.target.value) },
            f.options.map((o) => h('option', { key: o, value: o }, o)),
          )
        } else {
          control = h('input', {
            style: S.input,
            type: f.kind === 'number' ? 'number' : 'text',
            value,
            onChange: (e) => set(f.key, e.target.value),
          })
        }
        return h(
          'div',
          { key: f.key, style: S.row },
          h('div', null, h('div', { style: S.label }, f.label), f.hint ? h('div', { style: S.hint }, f.hint) : null),
          control,
        )
      })

      return h(
        'div',
        { style: S.wrap },
        h(
          'div',
          { style: S.head },
          h('div', { style: S.title }, 'QQ 桥接面板'),
          h('div', { style: S.sub }, '改的是 dsh-qq-bridge 自己的设置文件，存了立刻生效'),
          h('span', { style: S.badge }, dirty ? '有未保存的改动' : ''),
        ),
        rows,
        h(
          'div',
          { style: S.foot },
          h('button', { style: S.btnPrimary, disabled: busy || !dirty, onClick: () => void save() }, busy ? '保存中…' : '保存'),
          h('button', { style: S.btn, disabled: busy || !dirty, onClick: reset }, '还原'),
          h('button', { style: S.btn, disabled: busy, onClick: () => void reload() }, '重新读取'),
        ),
        error ? h('div', { style: S.err }, error) : null,
        note ? h('div', { style: S.ok }, note) : null,
        h(
          'div',
          { style: S.hint },
          '想改 NapCat 那边（安装目录、启动）用 qq_bridge_napcat 工具；这里只管桥接自己的参数。',
        ),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      try {
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'dafeiyu-qq-panel',
              order: 110,
              label: () => 'QQ 桥接面板',
            },
            Panel,
          ),
        )
      } catch (e) {
        console?.error?.('[dafeiyu-qq-panel] 注册设置页失败：', e)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dafeiyu-qq-panel'
    exports.__test = { FIELDS, toDraft, toPatch }
    return module.exports
  },
})
