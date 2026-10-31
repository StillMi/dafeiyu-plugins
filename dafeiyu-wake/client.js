/**
 * dafeiyu-wake —— 浏览器半。
 *
 * 在「设置 → 插件」里加一页「唤醒」，把 dafeiyu-wake 的全部参数摊开，
 * 直接读写宿主半挂的 `/api/dafeiyu-wake/settings`（GET 读、POST 写），
 * 保存后宿主半会立刻按新参数重排定时器，不用重启 DSH。
 *
 * 格式说明：DSH 的 client 半没有对外发布的打包预设，只能手写
 * `window.__ModuleLoader__.load({ id, factory })`。id 必须等于包名。
 */
window.__ModuleLoader__.load({
  id: 'dafeiyu-wake',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const API = '/api/dafeiyu-wake/settings'

    // ── 表单定义 ────────────────────────────────────────────────────────────
    const FIELDS = [
      { key: 'sessionId', label: '唤醒的会话', kind: 'text', hint: '只能填一个；改了要重启 DSH', wide: true },
      {
        key: 'minMinutes',
        label: '最短间隔',
        kind: 'number',
        hint: '分钟。和下面一起决定多久叫醒一次',
      },
      { key: 'maxMinutes', label: '最长间隔', kind: 'number', hint: '分钟' },
      { key: 'idleMinutes', label: '安静多少分钟才叫', kind: 'number', hint: '防止打断正在聊天' },
      { key: 'maxPerDay', label: '每天最多叫几次', kind: 'number' },
      { key: 'firstDelayMinutes', label: '加载后第一次等多久', kind: 'number', hint: '0 = 也走随机' },
      {
        key: 'quietStartHour',
        label: '免打扰开始',
        kind: 'number',
        hint: '0~23；与结束小时填同一个值 = 关掉免打扰',
      },
      { key: 'quietEndHour', label: '免打扰结束', kind: 'number', hint: '0~23' },
      { key: 'goodnightSleepHours', label: '听到晚安睡几小时', kind: 'number', hint: '0 = 不睡' },
      { key: 'lonelyHours', label: '多久没说话就先撒娇', kind: 'number', hint: '小时；0 = 关掉' },
      { key: 'timeZone', label: '时区', kind: 'text', hint: '如 Asia/Shanghai' },
      { key: 'notifyQQ', label: '醒来说的话发到 QQ', kind: 'boolean' },
      { key: 'syncQQ', label: '醒来时读 QQ 近况', kind: 'boolean', hint: '把最近的消息带进唤醒词' },
      { key: 'qqSyncMinutes', label: 'QQ 回看多少分钟', kind: 'number' },
      { key: 'qqSyncLimit', label: '最多带几条', kind: 'number' },
      { key: 'qqStatePath', label: 'QQ 状态文件', kind: 'text', hint: '留空 = $DSH_HOME/qq-bridge-state.json', wide: true },
      { key: 'autonomousChat', label: '自主聊天提示', kind: 'boolean', hint: '醒来不是交差，像聊天那样说' },
      { key: 'autoListenMinutes', label: '自动开监听几分钟', kind: 'number', hint: '0 = 不开' },
      { key: 'naggerEnabled', label: '没回话就追发撒娇', kind: 'boolean', hint: '发完消息等着，没人理再撒一次' },
      { key: 'naggerDelaySeconds', label: '等多少秒没回就追发', kind: 'number', hint: '默认 120 = 两分钟' },
      { key: 'naggerMaxRounds', label: '最多追发几次', kind: 'number', hint: '连着几次没人回就停（在忙或睡了）' },
      {
        key: 'naggerPrompt',
        label: '追发时塞给它的话',
        kind: 'area',
        hint: '不是台词，是「该你开口了」的说明——说什么由它自己决定。可用 {round}/{max}/{wait}',
      },
      { key: 'goodnightKeywords', label: '哪些话算晚安', kind: 'list', hint: '一行一个' },
    ]

    const S = {
      wrap: { padding: '4px 2px', fontSize: 13, lineHeight: 1.6 },
      head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 },
      title: { fontSize: 14, fontWeight: 600 },
      sub: { opacity: 0.66, fontSize: 12 },
      group: { marginTop: 14, marginBottom: 6, fontSize: 12, fontWeight: 600, opacity: 0.8 },
      row: { display: 'grid', gridTemplateColumns: '200px 1fr', gap: 10, alignItems: 'center', padding: '5px 0' },
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
        minHeight: 60,
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
      foot: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 },
      badge: { fontSize: 11, opacity: 0.55, marginLeft: 'auto' },
    }

    function toDraft(values) {
      const d = {}
      for (const f of FIELDS) {
        const v = values?.[f.key]
        if (f.kind === 'list') d[f.key] = Array.isArray(v) ? v.join('\n') : ''
        else if (f.kind === 'area') d[f.key] = v === undefined || v === null ? '' : String(v)
        else if (f.kind === 'boolean') d[f.key] = v === true
        else if (f.kind === 'number') d[f.key] = v === undefined || v === null ? '' : String(v)
        else d[f.key] = v === undefined || v === null ? '' : String(v)
      }
      return d
    }

    function toPatch(draft) {
      const patch = {}
      for (const f of FIELDS) {
        const raw = draft[f.key]
        if (f.kind === 'list') {
          patch[f.key] = String(raw ?? '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        } else if (f.kind === 'area') {
          patch[f.key] = String(raw ?? '')
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

      if (loading) return h('div', { style: S.wrap }, h('div', { style: S.sub }, '读取唤醒设置中…'))
      if (error && !draft) {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.title }, '唤醒'),
          h('div', { style: S.err }, `读不到设置：${error}`),
          h('div', { style: S.hint }, `接口是 ${API}。确认 dafeiyu-wake 的宿主半跑起来了、DSH 的 webServer 服务在。`),
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
          setNote('已保存，定时器已按新参数重排')
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
        } else if (f.kind === 'list' || f.kind === 'area') {
          control = h('textarea', {
            style: S.area,
            value,
            onChange: (e) => set(f.key, e.target.value),
          })
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
          h('div', { style: S.title }, '唤醒'),
          h('div', { style: S.sub }, '改完保存，宿主半会立刻重排定时器；只有「唤醒的会话」要重启 DSH'),
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
          '免打扰：开始与结束小时填同一个值 = 关掉。间隔是随机的，最短~最长之间抽一个。',
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
              id: 'dafeiyu-wake',
              order: 120,
              label: () => '唤醒',
            },
            Panel,
          ),
        )
      } catch (e) {
        console?.error?.('[dafeiyu-wake] 注册设置页失败：', e)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dafeiyu-wake'
    exports.__test = { FIELDS, toDraft, toPatch }
    return module.exports
  },
})
