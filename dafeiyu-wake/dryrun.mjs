/**
 * 干跑测试：用假的 ctx 跑 dafeiyu-wake，验证排程/免打扰/上限/晚安休眠/清理。
 * 不进 DSH，纯 node。
 */
import { apply } from 'file:///%DSH_WORKSPACE%/dafeiyu-wake/index.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name} ${extra}`)
  }
}

const logs = []
const mkCtx = ({ running = false, updatedAt } = {}) => {
  const state = {
    prompts: [],
    cleanups: [],
    listeners: [],
  }
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
    },
    effect(fn, label) {
      const cleanup = fn()
      state.cleanups.push({ label, cleanup })
      return cleanup
    },
    on(event, listener) {
      state.listeners.push({ event, listener })
      return () => {}
    },
    sessionController: {
      async list() {
        return {
          items: [
            {
              sessionId: 'S1',
              running,
              updatedAt: updatedAt ?? Date.now() - 60 * 60_000,
            },
          ],
        }
      },
      async prompt(request, signal) {
        state.prompts.push({ request, signal })
        return { accepted: true }
      },
    },
    _state: state,
  }
  return ctx
}

/** 模拟一条 user/message 事件。 */
const userEvent = (text, { kind = 'user', sessionId = 'S1' } = {}) => ({
  type: 'user/message',
  seq: 1,
  data: {
    id: 'm-' + Math.random().toString(36).slice(2),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind, rpcId: 'r-' + Math.random().toString(36).slice(2) },
  },
  _session: sessionId,
})

const emit = (ctx, event) => {
  const session = { id: event._session }
  for (const { event: name, listener } of ctx._state.listeners) {
    if (name === 'session/event') listener(session, event)
  }
}

// --- 用假的 setTimeout / clearTimeout 抓排程 ---
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let scheduled = []
let clearedIds = []
let nextId = 1
globalThis.setTimeout = (fn, ms) => {
  const id = nextId++
  scheduled.push({ id, ms, fn })
  return { id, unref() {} }
}
globalThis.clearTimeout = (id) => {
  clearedIds.push(id)
}

const flush = () => new Promise((r) => realSetTimeout(r, 30))
const lastTimer = () => scheduled[scheduled.length - 1]
const baseCfg = (over = {}) => ({
  sessionId: 'S1',
  minMinutes: 1,
  maxMinutes: 2,
  quietStartHour: 0,
  quietEndHour: 0,
  maxPerDay: 5,
  firstDelayMinutes: 0,
  timeZone: 'Asia/Shanghai',
  ...over,
})

console.log('=== 1. 正常排程落在 [min,max] 分钟内 ===')
{
  scheduled = []
  clearedIds = []
  const ctx = mkCtx({})
  apply(ctx, baseCfg({ minMinutes: 40, maxMinutes: 150 }))
  ok('注册了一个定时器', scheduled.length === 1)
  const mins = scheduled[0].ms / 60000
  ok('间隔 >= minMinutes', mins >= 39.9, `got ${mins.toFixed(1)}`)
  ok('间隔 <= maxMinutes+免打扰顺延', mins <= 150 + 60 * 24, `got ${mins.toFixed(1)}`)
  ok('有 effect cleanup', ctx._state.cleanups.length === 2)
  ctx._state.cleanups[0].cleanup()
  ok('cleanup 清掉了定时器', clearedIds.some((h) => h && h.id === scheduled[0].id))
}

console.log('=== 2. 免打扰时段会顺延到时段外 ===')
{
  scheduled = []
  const nowHour = new Date().getHours()
  const ctx = mkCtx({})
  apply(
    ctx,
    baseCfg({
      quietStartHour: nowHour,
      quietEndHour: (nowHour + 1) % 24,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  )
  const mins = scheduled[0].ms / 60000
  ok('当前小时被设为免打扰时，会排到很久之后', mins > 10, `got ${mins.toFixed(1)} 分钟（现在 ${nowHour} 点）`)
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 3. 到点叫醒：prompt 参数正确 ===')
{
  scheduled = []
  const ctx = mkCtx({})
  apply(ctx, baseCfg())
  lastTimer().fn()
  await flush()
  const p = ctx._state.prompts[0]
  ok('真的调了 prompt', !!p)
  ok('requestId 是 uuid', /^[0-9a-f-]{36}$/.test(p?.request?.requestId ?? ''))
  ok('sessionId 对', p?.request?.sessionId === 'S1')
  ok('mode 是 queue', p?.request?.mode === 'queue')
  ok('content 是 text 块', p?.request?.content?.[0]?.type === 'text')
  ok('文本里塞了时间', /20\d\d/.test(p?.request?.content?.[0]?.text ?? ''))
  ok('带了 signal', !!p?.signal)
  ok('叫完又排了下一次', scheduled.length === 2, `got ${scheduled.length}`)
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 4. 会话正在跑 -> 跳过，不叫 ===')
{
  scheduled = []
  const ctx = mkCtx({ running: true })
  apply(ctx, baseCfg({ idleMinutes: 25 }))
  lastTimer().fn()
  await flush()
  ok('没有调 prompt', ctx._state.prompts.length === 0)
  ok('重新排了短间隔（<=20 分钟）', lastTimer().ms / 60000 <= 20.1, `got ${(lastTimer().ms / 60000).toFixed(1)}`)
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 5. 刚有动静 -> 跳过 ===')
{
  scheduled = []
  const ctx = mkCtx({ updatedAt: Date.now() - 60_000 })
  apply(ctx, baseCfg({ idleMinutes: 25 }))
  lastTimer().fn()
  await flush()
  ok('没叫', ctx._state.prompts.length === 0)
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 6. 每日上限 ===')
{
  scheduled = []
  const ctx = mkCtx({})
  apply(ctx, baseCfg({ maxPerDay: 2 }))
  for (let i = 0; i < 4; i++) {
    lastTimer().fn()
    await flush()
  }
  ok('叫了正好 2 次', ctx._state.prompts.length === 2, `got ${ctx._state.prompts.length}`)
  ok('之后排到了很久以后', lastTimer().ms / 60000 > 60, `got ${(lastTimer().ms / 60000).toFixed(1)} 分钟`)
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 7. sessionId 为空 -> 不注册任何东西 ===')
{
  scheduled = []
  const ctx = mkCtx({})
  apply(ctx, { sessionId: '   ' })
  ok('没有定时器', scheduled.length === 0)
  ok('没有 effect', ctx._state.cleanups.length === 0)
  ok('有 warn 日志', logs.some(([lvl, m]) => lvl === 'warn' && m.includes('sessionId')))
}

console.log('=== 8. prompt 抛错 -> 不会把链子断掉 ===')
{
  scheduled = []
  const ctx = mkCtx({})
  ctx.sessionController.prompt = async () => {
    throw new Error('boom')
  }
  apply(ctx, baseCfg())
  lastTimer().fn()
  await flush()
  ok('报错后仍然排了下一次', scheduled.length === 2)
  ok('有 warn 日志', logs.some(([lvl, m]) => lvl === 'warn' && m.includes('叫醒失败')))
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 9. 主人说「晚安」-> 进入 7 小时长休眠 ===')
{
  scheduled = []
  clearedIds = []
  const ctx = mkCtx({})
  apply(ctx, baseCfg({ goodnightSleepHours: 7 }))
  const before = scheduled[0].id
  emit(ctx, userEvent('晚安哟'))
  const mins = lastTimer().ms / 60000
  ok('重排到了约 7 小时后', Math.abs(mins - 420) < 2, `got ${mins.toFixed(1)} 分钟`)
  ok('旧定时器被清掉', clearedIds.some((h) => h && h.id === before))
  ok('有日志说收到晚安', logs.some(([lvl, m]) => lvl === 'info' && m.includes('收到晚安')))
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 10. 长休眠期间到点也不叫 ===')
{
  scheduled = []
  const ctx = mkCtx({})
  apply(ctx, baseCfg({ goodnightSleepHours: 7 }))
  emit(ctx, userEvent('晚安'))
  // 假装闹钟在休眠中响了
  lastTimer().fn()
  await flush()
  ok('休眠中不叫', ctx._state.prompts.length === 0)
  ok('又排回休眠结束', Math.abs(lastTimer().ms / 60000 - 420) < 2, `got ${(lastTimer().ms / 60000).toFixed(1)}`)
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 11. 各种晚安说法都能认出来 ===')
{
  for (const phrase of ['晚安哟', '我去睡了', '关灯了哦~', 'good night', 'Goodnight!', '睡觉去了']) {
    scheduled = []
    const ctx = mkCtx({})
    apply(ctx, baseCfg({ goodnightSleepHours: 7 }))
    emit(ctx, userEvent(phrase))
    const mins = lastTimer().ms / 60000
    ok(`「${phrase}」-> 7 小时`, Math.abs(mins - 420) < 2, `got ${mins.toFixed(1)}`)
    ctx._state.cleanups[0].cleanup()
  }
}

console.log('=== 12. 不是晚安的话不会触发休眠 ===')
{
  for (const phrase of ['在么', '帮我看看这个 bug', '睡了没', '今晚加班']) {
    scheduled = []
    const ctx = mkCtx({})
    apply(ctx, baseCfg({ goodnightSleepHours: 7 }))
    const before = lastTimer().ms / 60000
    emit(ctx, userEvent(phrase))
    const after = lastTimer().ms / 60000
    ok(`「${phrase}」不触发`, Math.abs(after - before) < 0.01, `before ${before.toFixed(1)} after ${after.toFixed(1)}`)
    ctx._state.cleanups[0].cleanup()
  }
}

console.log('=== 12b. 已知误判：句子里带「晚安」但意思是否定的，也会睡 ===')
{
  // 故意留着这个断言，把已知的坑钉在测试里。
  // 加否定词判断反而会误伤「不早了，晚安」这种最常见的说法，所以不做。
  scheduled = []
  const ctx = mkCtx({})
  apply(ctx, baseCfg({ goodnightSleepHours: 7 }))
  emit(ctx, userEvent('今天不跟你说晚安了'))
  const mins = lastTimer().ms / 60000
  ok('确实会误判成晚安（已知，接受）', Math.abs(mins - 420) < 2, `got ${mins.toFixed(1)}`)
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 13. 别的会话说晚安 / 非主人来源 -> 不理 ===')
{
  scheduled = []
  const ctx = mkCtx({})
  apply(ctx, baseCfg({ goodnightSleepHours: 7 }))
  const before = lastTimer().ms / 60000
  emit(ctx, userEvent('晚安', { sessionId: 'OTHER' }))
  ok('别的会话不触发', Math.abs(lastTimer().ms / 60000 - before) < 0.01)
  emit(ctx, userEvent('晚安', { kind: 'schedule' }))
  ok('schedule 来源不触发', Math.abs(lastTimer().ms / 60000 - before) < 0.01)
  emit(ctx, userEvent('晚安', { kind: 'webhook' }))
  ok('webhook 来源不触发', Math.abs(lastTimer().ms / 60000 - before) < 0.01)
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 14. 自己叫醒自己的那条不会被当成晚安 ===')
{
  scheduled = []
  const ctx = mkCtx({})
  apply(ctx, baseCfg({ goodnightSleepHours: 7 }))
  // 先叫醒一次，拿到真实发出的文本
  lastTimer().fn()
  await flush()
  const sent = ctx._state.prompts[0]?.request?.content?.[0]?.text
  ok('确实发出了一条', typeof sent === 'string' && sent.length > 10)
  const before = lastTimer().ms / 60000
  // 把这条原样当成 user/message 回灌
  emit(ctx, userEvent(sent, { kind: 'user' }))
  ok('回灌不触发休眠', Math.abs(lastTimer().ms / 60000 - before) < 0.01, `before ${before.toFixed(1)} after ${(lastTimer().ms / 60000).toFixed(1)}`)
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 15. 睡醒那一次用专门的文案 ===')
{
  scheduled = []
  const ctx = mkCtx({})
  apply(ctx, baseCfg({ goodnightSleepHours: 7 }))
  emit(ctx, userEvent('晚安'))
  // 让休眠“结束”
  const realNow = Date.now
  Date.now = () => realNow() + 8 * 3600_000
  try {
    lastTimer().fn()
    await flush()
  } finally {
    Date.now = realNow
  }
  const text = ctx._state.prompts[0]?.request?.content?.[0]?.text ?? ''
  ok('真的叫醒了', text.length > 0)
  ok('文案提到睡了 7 个小时', text.includes('7 个小时'), text.slice(0, 60))
  ok('文案提到晚安', text.includes('晚安'))
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 16. goodnightSleepHours = 0 -> 关掉这个功能 ===')
{
  scheduled = []
  const ctx = mkCtx({})
  apply(ctx, baseCfg({ goodnightSleepHours: 0 }))
  const before = lastTimer().ms / 60000
  emit(ctx, userEvent('晚安'))
  ok('不进入休眠', Math.abs(lastTimer().ms / 60000 - before) < 0.01)
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 17. 只认一条鱼：数组 / 逗号连接都拒绝 ===')
{
  for (const bad of [['S1', 'S2'], 'S1,S2', 'S1，S2']) {
    scheduled = []
    const ctx = mkCtx({})
    apply(ctx, { sessionId: bad })
    ok(`sessionId=${JSON.stringify(bad)} 不注册`, scheduled.length === 0)
    ok(`sessionId=${JSON.stringify(bad)} 有 warn`, logs.some(([lvl, m]) => lvl === 'warn' && m.includes('只能填一个')))
  }
}

console.log('=== 18. 每次唤醒都看时间、关心主人 ===')
{
  const RealDate = globalThis.Date
  const freezeAt = (iso) => {
    const fixed = new RealDate(iso).getTime()
    class FrozenDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(fixed)
        else super(...args)
      }
      static now() {
        return fixed
      }
    }
    return FrozenDate
  }

  const cases = [
    ['2026-10-26T03:30:00+08:00', '凌晨 3:30', '硬撑'],
    ['2026-10-26T06:10:00+08:00', '早上 6:10', '熬穿'],
    ['2026-10-26T09:20:00+08:00', '上午 9:20', '刚起'],
    ['2026-10-26T12:10:00+08:00', '中午 12:10', '饭点'],
    ['2026-10-26T14:30:00+08:00', '下午 14:30', '犯困'],
    ['2026-10-26T16:40:00+08:00', '下午 16:40', '歇一会儿'],
    ['2026-10-26T19:20:00+08:00', '晚上 19:20', '吃饭'],
    ['2026-10-26T22:10:00+08:00', '夜里 22:10', '早点收'],
    ['2026-10-26T23:40:00+08:00', '深夜 23:40', '别唠叨'],
  ]

  const seen = new Set()
  for (const [iso, label, must] of cases) {
    scheduled = []
    const ctx = mkCtx({})
    globalThis.Date = freezeAt(iso)
    try {
      apply(ctx, baseCfg({ firstDelayMinutes: 1 }))
      lastTimer().fn()
      await flush()
    } finally {
      globalThis.Date = RealDate
    }
    const text = ctx._state.prompts[0]?.request?.content?.[0]?.text ?? ''
    ok(`${label} 叫醒了`, text.length > 0)
    ok(`${label} 没残留 {caring}`, !text.includes('{caring}'), text.slice(0, 50))
    ok(`${label} 没残留 {time}`, !text.includes('{time}'), text.slice(0, 50))
    const hhmm = iso.slice(11, 16)
    ok(`${label} 带上了钟点 ${hhmm}`, text.includes(hhmm), text.slice(0, 40))
    ok(`${label} 关心的是「${must}」`, text.includes(must), text.slice(0, 120))
    seen.add(text)
    ctx._state.cleanups[0].cleanup()
  }

  ok('九个钟点说出了九种不同的话', seen.size === cases.length, `got ${seen.size}`)
}

console.log('=== 19. 唤醒词里都留了 {caring} 的位置 ===')
{
  scheduled = []
  const ctx = mkCtx({})
  apply(ctx, baseCfg())
  // 连着叫几次，每次都要有可替换的位置
  for (let i = 0; i < 6; i++) {
    lastTimer().fn()
    await flush()
  }
  const texts = ctx._state.prompts.map((p) => p.request?.content?.[0]?.text ?? '')
  ok('至少叫醒了三次', texts.length >= 3, `got ${texts.length}`)
  for (const [i, t] of texts.entries()) {
    ok(`第 ${i + 1} 次没有占位符残留`, !t.includes('{caring}') && !t.includes('{time}'), t.slice(0, 40))
    ok(`第 ${i + 1} 次都提到了主人或时间`, /主人|\d{4}/.test(t), t.slice(0, 40))
  }
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 20. 主人超过 8 小时没理，醒来先撒娇 ===')
{
  const realNow = Date.now

  // 8 小时以内：不撒娇
  scheduled = []
  let ctx = mkCtx({ updatedAt: realNow() - 2 * 3600_000 })
  apply(ctx, baseCfg())
  await flush()
  emit(ctx, userEvent('在吗'))
  lastTimer().fn()
  await flush()
  let text = ctx._state.prompts[0]?.request?.content?.[0]?.text ?? ''
  ok('两小时内不撒娇', !text.includes('没跟你说话'), text.slice(0, 80))
  ok('两小时内没残留 {lonely}', !text.includes('{lonely}'))
  ok('两小时内没残留 {silent}', !text.includes('{silent}'))
  ok('两小时内没有多余空行堆着', !/\n\n\n/.test(text), JSON.stringify(text.slice(-40)))
  ctx._state.cleanups[0].cleanup()

  // 9 小时没说话：撒娇
  scheduled = []
  ctx = mkCtx({ updatedAt: realNow() - 2 * 3600_000 })
  apply(ctx, baseCfg())
  await flush()
  emit(ctx, userEvent('在吗'))
  Date.now = () => realNow() + 9 * 3600_000
  try {
    lastTimer().fn()
    await flush()
  } finally {
    Date.now = realNow
  }
  text = ctx._state.prompts[0]?.request?.content?.[0]?.text ?? ''
  ok('九小时没说话就撒娇了', text.includes('没跟你说话'), text.slice(0, 200))
  ok('撒娇里带上了小时数', text.includes('9 个小时'), text.slice(0, 200))
  ok('撒娇时没残留 {silent}', !text.includes('{silent}'))
  ok('撒娇时没残留 {lonely}', !text.includes('{lonely}'))
  ok('撒娇时没残留 {caring}', !text.includes('{caring}'))
  ok('撒娇时没残留 {time}', !text.includes('{time}'))
  ok('撒娇提醒了撒完就停', text.includes('撒完就停'))
  ctx._state.cleanups[0].cleanup()
}

console.log('=== 21. lonelyHours 能改也能关 ===')
{
  const realNow = Date.now
  const wakeAfter = async (hours, over) => {
    scheduled = []
    const ctx = mkCtx({ updatedAt: realNow() - 2 * 3600_000 })
    apply(ctx, baseCfg(over))
    await flush()
    emit(ctx, userEvent('在吗'))
    Date.now = () => realNow() + hours * 3600_000
    try {
      lastTimer().fn()
      await flush()
    } finally {
      Date.now = realNow
    }
    ctx._state.cleanups[0].cleanup()
    return ctx._state.prompts[0]?.request?.content?.[0]?.text ?? ''
  }

  const short = await wakeAfter(3, { lonelyHours: 2 })
  ok('门槛改成 2 小时，3 小时就撒娇', short.includes('没跟你说话'), short.slice(0, 120))

  const off = await wakeAfter(20, { lonelyHours: 0 })
  ok('lonelyHours=0 就关掉，20 小时也不撒娇', !off.includes('没跟你说话'), off.slice(0, 120))

  const late = await wakeAfter(20, {})
  ok('默认 8 小时，20 小时当然撒娇', late.includes('没跟你说话'))
  ok('默认门槛下 20 小时报的是 20', late.includes('20 个小时'), late.slice(0, 160))
}

console.log('=== 22. 醒来说的话能顺手上 QQ ===')
{
  const wake = async (over) => {
    scheduled = []
    const ctx = mkCtx()
    apply(ctx, baseCfg(over))
    await flush()
    lastTimer().fn()
    await flush()
    ctx._state.cleanups[0].cleanup()
    return ctx._state.prompts[0]?.request?.content?.[0]?.text ?? ''
  }

  const on = await wake({})
  ok('默认提醒去 QQ 说', on.includes('qq_bridge_send'), on.slice(-160))
  ok('提醒了第一次调用只是确认', on.includes('确认要发吗'))
  ok('说了没话就别硬凑', on.includes('不用硬凑'))
  ok('没有残留占位符', !/\{[a-z]+\}/.test(on), on.slice(-120))

  const off = await wake({ notifyQQ: false })
  ok('关掉就不提 QQ', !off.includes('qq_bridge_send'), off.slice(-120))
  ok('关掉后原文照旧没有残留占位符', !/\{[a-z]+\}/.test(off), off.slice(-120))
}

globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
