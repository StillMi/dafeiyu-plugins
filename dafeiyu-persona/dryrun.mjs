/**
 * 干跑测试：用假的 ctx 跑 dafeiyu-persona。
 * 不进 DSH，纯 node。
 */
import { apply, inject } from 'file:///%DSH_WORKSPACE%/dafeiyu-persona/index.js'

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

const mkCtx = () => {
  const state = { sections: [], cleanups: [], logs: [] }
  const ctx = {
    logger: {
      info: (m) => state.logs.push(['info', m]),
      warn: (m) => state.logs.push(['warn', m]),
    },
    effect(fn, label) {
      const cleanup = fn()
      state.cleanups.push({ label, cleanup })
      return cleanup
    },
    systemPrompt: {
      section(section) {
        state.sections.push(section)
        return () => {
          state.sections = state.sections.filter((s) => s !== section)
        }
      },
      getSectionOrder(name) {
        return { DEPLOYMENT_PERSONA_PREFIX: 0, PLAN_POLICY: 500, DEPLOYMENT_PERSONA_SUFFIX: 10200 }[name]
      },
    },
    _state: state,
  }
  return ctx
}

console.log('=== 1. inject 声明了 systemPrompt ===')
ok('inject 是数组且含 systemPrompt', Array.isArray(inject) && inject.includes('systemPrompt'), JSON.stringify(inject))

console.log('=== 2. 默认配置挂一个 section ===')
{
  const ctx = mkCtx()
  apply(ctx, {})
  ok('只挂了一个', ctx._state.sections.length === 1, `got ${ctx._state.sections.length}`)
  const s = ctx._state.sections[0]
  ok('name 是 dafeiyu:persona-guard', s.name === 'dafeiyu:persona-guard', s.name)
  ok('order 是 1', s.order === 1, String(s.order))
  ok('text 不是空的', typeof s.text === 'string' && s.text.length > 100, `${s.text?.length}`)
  ok('走的是 effect 注册', ctx._state.cleanups.length === 1 && ctx._state.cleanups[0].label === 'dafeiyu-persona.section()')
  ok('有 info 日志', ctx._state.logs.some(([l, m]) => l === 'info' && m.includes('人格提醒')))
}

console.log('=== 3. order 落在 persona 之后、plan policy 之前 ===')
{
  const ctx = mkCtx()
  apply(ctx, {})
  const order = ctx._state.sections[0].order
  ok('order > DEPLOYMENT_PERSONA_PREFIX(0)', order > 0, String(order))
  ok('order < PLAN_POLICY(500)', order < 500, String(order))
}

console.log('=== 4. section 名字不和官方 persona 撞 ===')
{
  const ctx = mkCtx()
  apply(ctx, {})
  const name = ctx._state.sections[0].name
  ok('不是 deployment:persona-prefix', name !== 'deployment:persona-prefix', name)
  ok('不是 deployment:persona-suffix', name !== 'deployment:persona-suffix', name)
  ok('不是空的', name.trim().length > 0)
}

console.log('=== 5. 正文里没有 {{ }}（会被当变量插值炸掉）===')
{
  const ctx = mkCtx()
  apply(ctx, {})
  const text = ctx._state.sections[0].text
  ok('没有 {{', !text.includes('{{'))
  ok('没有 }}', !text.includes('}}'))
}

console.log('=== 6. 正文里该有的东西都在 ===')
{
  const ctx = mkCtx()
  apply(ctx, {})
  const t = ctx._state.sections[0].text
  const must = ['大肥鱼', '不是助手', '不点句号', '一次只说一段话', '不说「有什么可以帮你的」', '被夸会飘', '不装懂', '被问在干嘛', '不说「我一直在等你」', '干活的时候', '汇报腔', 'MEMORY.md', 'persona.md']
  for (const k of must) ok(`正文含「${k}」`, t.includes(k))
}

console.log('=== 7. 正文禁止的东西没被自己写进去 ===')
{
  const ctx = mkCtx()
  apply(ctx, {})
  const t = ctx._state.sections[0].text
  // 正文是规矩，允许出现这些词；但正文自己不能是「作为一个AI」的腔调
  ok('正文没有「作为一个 AI」的自我介绍腔', !t.includes('作为一个 AI，我'))
  ok('正文没有 markdown 表格', !t.includes('|---'))
  ok('正文没有 markdown 标题', !/^#{1,6}\s/m.test(t))
}

console.log('=== 8. config.text 能整段替换 ===')
{
  const ctx = mkCtx()
  apply(ctx, { text: '我是测试人格，只回一个字。' })
  ok('用的是自定义正文', ctx._state.sections[0].text === '我是测试人格，只回一个字。')
  ok('长度对了', ctx._state.sections[0].text.length === 13, String(ctx._state.sections[0].text.length))
}

console.log('=== 9. text 是空白 -> 回落到默认 ===')
{
  for (const bad of ['', '   ', '\n\t ', null, undefined, 123]) {
    const ctx = mkCtx()
    apply(ctx, { text: bad })
    ok(`text=${JSON.stringify(bad)} 回落默认`, ctx._state.sections[0].text.includes('大肥鱼'), String(ctx._state.sections[0].text).slice(0, 20))
  }
}

console.log('=== 10. config.name / order 能覆盖 ===')
{
  const ctx = mkCtx()
  apply(ctx, { name: 'my:persona', order: 42 })
  ok('name 覆盖了', ctx._state.sections[0].name === 'my:persona')
  ok('order 覆盖了', ctx._state.sections[0].order === 42)
}

console.log('=== 11. 非数字 order -> 回落到 1 ===')
{
  for (const bad of ['abc', null, NaN, Infinity]) {
    const ctx = mkCtx()
    apply(ctx, { order: bad })
    ok(`order=${String(bad)} 回落 1`, ctx._state.sections[0].order === 1, String(ctx._state.sections[0].order))
  }
}

console.log('=== 12. 空白 name -> 回落到默认名 ===')
{
  for (const bad of ['', '   ', null]) {
    const ctx = mkCtx()
    apply(ctx, { name: bad })
    ok(`name=${JSON.stringify(bad)} 回落`, ctx._state.sections[0].name === 'dafeiyu:persona-guard', ctx._state.sections[0].name)
  }
}

console.log('=== 13. cleanup 能摘掉 section ===')
{
  const ctx = mkCtx()
  apply(ctx, {})
  ok('挂上时有一个', ctx._state.sections.length === 1)
  ctx._state.cleanups[0].cleanup()
  ok('cleanup 后没了', ctx._state.sections.length === 0, `got ${ctx._state.sections.length}`)
}

console.log('=== 14. 卸载再装一次不会重复 ===')
{
  const ctx = mkCtx()
  apply(ctx, {})
  apply(ctx, {})
  ok('两次 apply 两个 section（靠 name 去重，实际由 DSH 处理）', ctx._state.sections.length === 2)
  ok('两次的 name 一样', ctx._state.sections[0].name === ctx._state.sections[1].name)
  ctx._state.cleanups[0].cleanup()
  ctx._state.cleanups[1].cleanup()
  ok('都摘干净了', ctx._state.sections.length === 0)
}

console.log('=== 15. 正文长度合理（不占太多上下文）===')
{
  const ctx = mkCtx()
  apply(ctx, {})
  const len = ctx._state.sections[0].text.length
  ok('不少于 400 字', len >= 400, String(len))
  ok('不超过 2000 字', len <= 2000, String(len))
  console.log(`        实际 ${len} 字`)
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
