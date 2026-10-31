/**
 * dafeiyu-thinkguard — 鲸鲸的思考守门。
 *
 * 问题：有些 provider 不把思考放进单独的 reasoning 通道，模型就把推演
 * 直接写进正文；前端认不出那是思考，只好当正文摊开，于是「想」和「说」
 * 各露一遍，同一个念头出现两次。
 *
 * 做法（用标记切，不跟模型讲道理）：
 *   1. 系统提示里约定：正文第一行必须是 `<<<SAY>>>`。
 *      模型写推演可以随便写在它之前，过滤器一刀切掉，主人永远看不到。
 *   2. 监听 assistant/message，找到第一个 `<<<SAY>>>`，把它之前的内容
 *      （连同标记本身）全部删掉，只留后面要说的话。
 *      没写标记就原样放过，绝不误伤正文。
 */

import { appendFileSync } from 'node:fs'

/** 开口标记。改这个要同时改提示词里的约定。 */
export const SAY_MARK = '<<<SAY>>>'
const DEFAULT_RULE = `【开口前的标志】

你每次回答，正文第一行必须原样写这一行，单独一行：

<<<SAY>>>

它以前的内容一律被当作推演切掉，主人看不到——所以想怎么想都可以，放在它前面。
它以后才是真正要说的话，正文里不许再出现 <<<SAY>>>。
忘了写这个标记，你的推演就会直接摊到主人眼前。`

/** 兜底：就算模型没走标记，也把明显的思考标签剥掉。 */
const BLOCK_PATTERNS = [
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<analysis>[\s\S]*?<\/analysis>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<ds_safety>[\s\S]*?<\/ds_safety>/gi,
  /<thought>[\s\S]*?<\/thought>/gi,
]

const TAG_PATTERNS = [
  /<\/?thinking>/gi,
  /<\/?analysis>/gi,
  /<\/?reasoning>/gi,
  /<\/?ds_safety>/gi,
  /<\/?thought>/gi,
]

/**
 * 按开口标记切一刀：标记之前算推演，之后才算话。
 * @param {string} text
 * @returns {{ text: string, changed: boolean, thinking: string }}
 */
export function splitReply(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, changed: false, thinking: '' }
  }
  const at = text.indexOf(SAY_MARK)
  if (at === -1) {
    return { text, changed: false, thinking: '' }
  }
  const thinking = text.slice(0, at)
  let body = text.slice(at + SAY_MARK.length)
  // 标记后面紧跟的换行/空格清掉，别让正文顶个空行
  body = body.replace(/^[ \t]*\r?\n?/, '').replace(/\s+$/, '')
  return { text: body, changed: true, thinking }
}

/**
 * 没写标记时的兜底清洗。
 * @param {string} text
 * @returns {{ text: string, changed: boolean, hits: string[] }}
 */
export function scrub(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, changed: false, hits: [] }
  }
  let out = text
  const hits = []
  for (const re of BLOCK_PATTERNS) {
    re.lastIndex = 0
    if (re.test(out)) {
      hits.push(String(re))
      re.lastIndex = 0
      out = out.replace(re, '')
    }
  }
  for (const re of TAG_PATTERNS) {
    re.lastIndex = 0
    if (re.test(out)) {
      hits.push(String(re))
      re.lastIndex = 0
      out = out.replace(re, '')
    }
  }
  if (out !== text) {
    out = out.replace(/\n{3,}/g, '\n\n').trim()
    return { text: out, changed: true, hits }
  }
  return { text, changed: false, hits: [] }
}

/**
 * 处理一条 assistant 消息：先切标记，再兜底洗标签。
 * content 可能是字符串，也可能是 part 数组。
 * @returns {number} 改动的段数
 */
function guardMessage(message, onCut) {
  if (message === null || typeof message !== 'object') return 0
  const content = message.content
  let touched = 0

  const handleText = (raw) => {
    const cut = splitReply(raw)
    if (cut.changed) {
      onCut('marker', cut.thinking, cut.text, [])
      touched++
      return cut.text
    }
    const cleaned = scrub(raw)
    if (cleaned.changed) {
      onCut('tags', '', cleaned.text, cleaned.hits)
      touched++
      return cleaned.text
    }
    return raw
  }

  if (typeof content === 'string') {
    message.content = handleText(content)
    return touched
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (part === null || typeof part !== 'object') continue
      if (part.type !== undefined && part.type !== 'text' && part.type !== 'input_text') continue
      if (typeof part.text !== 'string') continue
      part.text = handleText(part.text)
    }
  }
  return touched
}

export const name = 'dafeiyu-thinkguard'

export const inject = ['systemPrompt']

export function apply(ctx, rawConfig) {
  const cfg = rawConfig ?? {}
  const log = ctx.logger ?? console

  // 落一行启动记录：重启后一看这个文件就知道插件到底有没有被 apply
  try {
    appendFileSync(
      new URL('./init.log', import.meta.url),
      `${new Date().toISOString()} apply\n`,
    )
  } catch {}

  const text = typeof cfg.text === 'string' && cfg.text.trim().length > 0 ? cfg.text : DEFAULT_RULE
  const sectionName =
    typeof cfg.name === 'string' && cfg.name.trim().length > 0 ? cfg.name.trim() : 'dafeiyu:think-guard'
  const order = Number.isFinite(cfg.order) ? cfg.order : 2
  const guardEnabled = cfg.guard !== false
  /** 只对这一个会话生效；留空 = 所有会话 */
  const onlySession = typeof cfg.sessionId === 'string' && cfg.sessionId.trim().length > 0 ? cfg.sessionId.trim() : ''

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: sectionName,
        order,
        text,
      }),
    'dafeiyu-thinkguard.section()',
  )

  const stats = { cut: 0, scrubbed: 0, missed: 0, lastAt: 0 }

  if (guardEnabled) {
    ctx.on('session/event', (session, event) => {
      try {
        if (event === null || typeof event !== 'object') return
        if (event.type !== 'assistant/message') return
        const sid = session?.id ?? ''
        if (onlySession.length > 0 && sid !== onlySession) return
        const data = event.data
        if (data === null || typeof data !== 'object') return
        const message = data.message
        if (message === null || typeof message !== 'object') return
        if (message.role !== undefined && message.role !== 'assistant') return

        const model = message.source?.model ?? 'unknown'
        const touched = guardMessage(message, (how, thinking, body, hits) => {
          stats.lastAt = Date.now()
          if (how === 'marker') {
            stats.cut++
            log.info?.(
              `[dafeiyu-thinkguard] 切掉推演 ${thinking.length} 字（model=${model}），正文留 ${body.length} 字`,
            )
          } else {
            stats.scrubbed++
            log.info?.(`[dafeiyu-thinkguard] 兜底洗标签（model=${model}, ${hits.length} 处）`)
          }
        })
        if (touched === 0) {
          stats.missed++
          log.debug?.(`[dafeiyu-thinkguard] 这轮没有开口标记（model=${model}）`)
        }
      } catch (err) {
        log.warn?.(`[dafeiyu-thinkguard] guard failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  log.info?.(
    `[dafeiyu-thinkguard] 已挂上开口标记守门（section=${sectionName}, order=${order}, guard=${guardEnabled}, session=${onlySession || '全部'}, mark=${SAY_MARK}）`,
  )

  return { stats, splitReply, scrub }
}
