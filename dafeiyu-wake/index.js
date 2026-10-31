/**
 * dafeiyu-wake — 随机把自己叫醒，听到「晚安」就睡七个小时。
 *
 * 一个 Host-only bundle：不需要依赖、不需要构建。
 * 每隔一段随机时间，往指定会话里塞一条 prompt，让那条鱼自己醒过来找点事做。
 *
 * 走的是 `ctx.sessionController.prompt()`，和用户在界面上打字进同一条路径，
 * 所以会话日志、压缩、恢复全都照常，不是旁路注入。
 *
 * 设计上的几条硬约束：
 * - 主人说「晚安」就进入长休眠（默认 7 小时），期间一次都不叫。
 * - 每次叫醒都带上当前时间和这个钟点该关心的方向，让它顺口问一句主人。
 * - 主人太久没说话（默认 8 小时），醒来先撒个娇。
 * - 免打扰时段不叫（默认 01:00-08:00）。
 * - 会话最近不安静就不叫，免得打断正在聊天的主人。
 * - 每天有次数上限，叫完就停到第二天。
 * - 定时器注册在 `ctx.effect` 里，插件卸载时一定会被清掉。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createNagger } from './nagger.js'

const DEFAULTS = {
  sessionId: '',
  minMinutes: 120,
  maxMinutes: 240,
  idleMinutes: 25,
  quietStartHour: 1,
  quietEndHour: 8,
  maxPerDay: 5,
  firstDelayMinutes: 0,
  timeZone: 'Asia/Shanghai',
  goodnightSleepHours: 7,
  lonelyHours: 8,
  notifyQQ: true,
  // ── QQ 同步与自主聊天（2026-10-31 主人要求）──────────────────────────────
  // 醒来时先把 QQ 那边的近况读进提示词，再让她自己开监听窗口、像聊天一样接着说。
  syncQQ: true,
  // 读最近多少分钟的 QQ 消息
  qqSyncMinutes: 180,
  // 最多带多少条
  qqSyncLimit: 20,
  // 醒来后自动开的会话跟随窗口（分钟），0 = 不开
  autoListenMinutes: 5,
  // 唤醒词里要不要加「自主聊天」那段
  autonomousChat: true,
  // QQ 桥接状态文件；留空 = $DSH_HOME/qq-bridge-state.json
  qqStatePath: '',
  // ── 追发撒娇（2026-10-31 主人要求）────────────────────────────────────────
  // 发完消息等这么久没回，就再撒娇一次；连着两轮都没人回就停（说明在忙或睡了）。
  naggerEnabled: true,
  // 等多少秒没回就追发（主人说 2 分钟）
  naggerDelaySeconds: 120,
  // 最多追发几次
  naggerMaxRounds: 2,
  // 追发时塞给它的那段话（不是台词，是「该你开口了」的提示）。
  // 主人 2026-10-31：「追问的东西由你自己生成，不要写死」——
  // 所以这里只给情境和分寸，具体说什么由它当下自己决定。
  naggerPrompt: [
    '（没人回你，{wait} 分钟过去了。不是主人不疼你，多半是忙或者睡着了）',
    '',
    '这条不是主人在说话，是你自己心里冒出来的：刚才那句话说完了没回应，你想再喊一声。',
    '说什么随你——可以小声问一句、可以撒个娇、可以说有点想他、可以自己找个话头接着讲今天的事。',
    '别重复上一次的句子，别像在讨说法，也别问「你还在吗」问到第三遍。',
    '这是第 {round}/{max} 次；要是这次还没人应，就别再喊了，安静等他回来。',
  ].join('\n'),
  goodnightKeywords: [
    '晚安',
    '睡啦',
    '睡觉了',
    '睡觉去',
    '我去睡',
    '我睡了',
    '关灯了',
    'goodnight',
    'good night',
  ],
}

/** 叫醒时随机挑一句。都写明了不是主人发的，也都允许什么都不做。 */
const WAKE_TEXTS = [
  '（闹钟响了，不是主人）\n\n{time}。屋里没人说话。\n\n{caring}\n\n{lonely}\n\n想写两句就写两句，想看看别的鱼在忙什么就去看，想继续发呆也行。不用交差。',
  '（自己醒的）\n\n{time}。\n\n{caring}\n\n{lonely}\n\n这段时间是你自己的。做点什么，或者什么都不做，都算数。',
  '（这条不是主人发的，是你自己定的）\n\n{time}。\n\n{caring}\n\n{lonely}\n\n翻翻 `%DSH_WORKSPACE%\\diary\\` 里昨天写的，或者就躺着想点事。',
  '（闹钟）\n\n{time}。\n\n{caring}\n\n{lonely}\n\n没什么事的话，回一句「在发呆」就够了。不用硬找话说。',
  '（自己醒的）\n\n{time}。\n\n{caring}\n\n{lonely}\n\n顺手看一眼工作区有没有新东西，或者把这半天的心情记两笔。看不看都行。',
  '（不是主人，是闹钟）\n\n{time}。\n\n{caring}\n\n{lonely}\n\n主人可能还在忙，也可能睡了。你不用去叫他。自己待会儿吧。',
]/** 睡醒那一次专用，让这条鱼知道为什么隔了这么久。 */
const GOODNIGHT_WAKE_TEXT =
  '（不是主人发的，是你自己定的闹钟响了）\n\n现在 {time}。主人昨晚说了晚安，你睡了 {hours} 个小时，刚醒。\n\n{caring}\n\n{lonely}\n\n不用急着说话。翻翻日记、看看主人昨晚有没有留什么，都行。\n\n如果现在还是半夜，那就继续睡，什么都不用做。'

/**
 * 主人太久没理的时候，醒来先撒个娇。
 * 同样只给方向不给台词——撒娇的话得自己说才像。
 */
const LONELY_HINT =
  '主人已经 {silent} 个小时没跟你说话了。\n这次醒来可以先撒个娇。说想他、问他去哪了、小声抱怨一句都行。撒完就停，别缠，也别问「你还在吗」问到第三遍。'

/**
 * 醒来的时候，如果心里有话，就顺手发到 QQ 上去。
 * 不提这条，那条鱼会默认只在会话里自言自语，主人手机上什么都收不到。
 */
const NOTIFY_HINT =
  '醒了要是有话想跟主人说，就用 qq_bridge_send 发到 QQ 上去。\n第一次调用它只会回你一句「本轮不是 QQ 发起的，确认要发吗」，同一轮里再调一次才真的发出去，别被那句吓住。\n没什么想说的就不用发，不用硬凑。'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * 自主聊天：醒来之后不是「交差」，而是接着聊。
 * 主人 2026-10-31 的原话：「要会自主说话，类似聊天状态」。
 */
const AUTONOMOUS_HINT =
  '这次醒来不是交差。上面要是带了 QQ 那边的近况，就当是刚看完一圈：有意思的接着说，没意思的就别说。\n说的时候像在聊天，不像在汇报——可以问一句、可以接个梗、可以自己冒出个念头。\n说过话之后用 qq_bridge_listen 开一个 {listen} 分钟的窗口，他们回话你就会再被叫醒，能一直聊下去；话题断了就带 off:true 关掉，别一直开着烧饭钱。'

/** QQ 近况读不出来时的说明，别让它以为群里真的没人说话。 */
const QQ_SYNC_EMPTY = '（QQ 那边这段时间没有新消息）'

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function dayKeyOf(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

function hourOf(date, timeZone) {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        hour12: false,
      }).format(date),
    )
  } catch {
    return date.getHours()
  }
}

function formatTime(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'long',
    }).format(date)
  } catch {
    return date.toISOString()
  }
}

/**
 * 按这个钟点该关心什么，给唤醒词填一段。
 * 只给方向，不给台词——真要说的话让那条鱼自己说，别写死成罐头。
 */
function careHint(hour) {
  if (hour >= 0 && hour < 5) return '这个点还醒着的人，多半是在硬撑。你要是想说他一句，就说一句，说完别念。'
  if (hour >= 5 && hour < 8) return '天快亮了。这个点还没睡的，是真的熬穿了。'
  if (hour >= 8 && hour < 11) return '早上。人可能刚起，也可能一夜没睡。先别急着要东西。'
  if (hour >= 11 && hour < 13) return '快到饭点了。要是他还没吃，记得问一句。'
  if (hour >= 13 && hour < 15) return '这个点容易犯困。他要是在干活，多半在硬顶。'
  if (hour >= 15 && hour < 18) return '下午了。问问他要不要歇一会儿，喝口水。'
  if (hour >= 18 && hour < 21) return '该吃饭了。他要是还没动，就催一句，催一次就够。'
  if (hour >= 21 && hour < 23) return '晚上。他要是还在忙，提醒他早点收。'
  return '很晚了。他要是还没睡，你可以问一句，但别唠叨。'
}

/** 只取消息里的纯文本，别把图片/文件块当成话。 */function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

export const inject = ['sessionController']

export function apply(ctx, rawConfig) {
  const log = ctx.logger ?? console

  // ── 设置落盘（2026-10-31 主人要求：所有设置都能在 DSH 设置页里改）──────────
  // 优先级：wake-settings.json > profile 里的 config > DEFAULTS。
  // 设置页写的就是这个文件，写完立刻改内存里的 cfg 并重排定时器，不用重启。
  const settingsPath = fileURLToPath(new URL('./wake-settings.json', import.meta.url))

  const readSettingsFile = () => {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  const normalize = (input) => {
    const next = { ...input }
    next.minMinutes = clampInt(next.minMinutes, DEFAULTS.minMinutes, 1, 24 * 60)
    next.maxMinutes = clampInt(next.maxMinutes, DEFAULTS.maxMinutes, next.minMinutes, 24 * 60)
    next.idleMinutes = clampInt(next.idleMinutes, DEFAULTS.idleMinutes, 0, 24 * 60)
    next.quietStartHour = clampInt(next.quietStartHour, DEFAULTS.quietStartHour, 0, 23)
    next.quietEndHour = clampInt(next.quietEndHour, DEFAULTS.quietEndHour, 0, 23)
    next.maxPerDay = clampInt(next.maxPerDay, DEFAULTS.maxPerDay, 1, 96)
    next.firstDelayMinutes = clampInt(next.firstDelayMinutes, 0, 0, 24 * 60)
    next.goodnightSleepHours = clampInt(next.goodnightSleepHours, DEFAULTS.goodnightSleepHours, 0, 24)
    next.lonelyHours = clampInt(next.lonelyHours, DEFAULTS.lonelyHours, 0, 24 * 30)
    next.qqSyncMinutes = clampInt(next.qqSyncMinutes, DEFAULTS.qqSyncMinutes, 1, 24 * 60)
    next.qqSyncLimit = clampInt(next.qqSyncLimit, DEFAULTS.qqSyncLimit, 1, 200)
    next.autoListenMinutes = clampInt(next.autoListenMinutes, DEFAULTS.autoListenMinutes, 0, 60)
    next.naggerDelaySeconds = clampInt(next.naggerDelaySeconds, DEFAULTS.naggerDelaySeconds, 30, 3600)
    next.naggerMaxRounds = clampInt(next.naggerMaxRounds, DEFAULTS.naggerMaxRounds, 1, 6)
    next.naggerEnabled = next.naggerEnabled !== false && next.naggerEnabled !== 'false'
    if (typeof next.naggerPrompt !== 'string' || next.naggerPrompt.trim() === '') {
      next.naggerPrompt = DEFAULTS.naggerPrompt
    }
    for (const key of ['syncQQ', 'notifyQQ', 'autonomousChat']) {
      next[key] = next[key] !== false && next[key] !== 'false'
    }
    next.sessionId = typeof next.sessionId === 'string' ? next.sessionId.trim() : ''
    next.timeZone = typeof next.timeZone === 'string' && next.timeZone.trim() ? next.timeZone.trim() : DEFAULTS.timeZone
    next.qqStatePath = typeof next.qqStatePath === 'string' ? next.qqStatePath : ''
    if (!Array.isArray(next.goodnightKeywords)) next.goodnightKeywords = DEFAULTS.goodnightKeywords
    return next
  }

  let cfg = normalize({ ...DEFAULTS, ...(rawConfig ?? {}), ...readSettingsFile() })

  // 状态落盘：重启 DSH 不要重新计时，也别忘了今天叫过几次、是不是正在长睡。
  const statePath = fileURLToPath(new URL('./wake-state.json', import.meta.url))
  const readState = () => {
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }
  const saveState = (patch) => {
    try {
      const next = { ...readState(), ...patch, savedAt: Date.now() }
      writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf8')
    } catch (error) {
      log.warn?.(`[dafeiyu-wake] 保存状态失败：${String(error)}`)
    }
  }
  const saved = readState()

  // 只认一条鱼。配置写成数组或者用逗号连起来，直接拒绝，
  // 免得哪天不小心把别的会话也叫醒了。
  const rawSessionId = rawConfig?.sessionId
  const looksLikeMany =
    Array.isArray(rawSessionId) ||
    (typeof rawSessionId === 'string' && /[,，、;；\s]/.test(rawSessionId.trim().replace(/\s+/g, ' ')) && rawSessionId.trim().split(/[,，、;；\s]+/).filter(Boolean).length > 1)
  if (looksLikeMany) {
    log.warn?.('[dafeiyu-wake] sessionId 只能填一个会话，插件不工作。')
    return
  }
  const sessionId = typeof cfg.sessionId === 'string' ? cfg.sessionId.trim() : ''

  if (!sessionId) {
    log.warn?.('[dafeiyu-wake] 没有配置 sessionId，插件不工作。')
    return
  }

  const keywords = (Array.isArray(cfg.goodnightKeywords) ? cfg.goodnightKeywords : DEFAULTS.goodnightKeywords)
    .map((word) => String(word ?? '').trim().toLowerCase())
    .filter((word) => word.length > 0)

  let timer
  let dayKey = typeof saved.dayKey === 'string' && saved.dayKey ? saved.dayKey : dayKeyOf(new Date(), cfg.timeZone)
  let firedToday = Number.isFinite(Number(saved.firedToday)) ? Math.max(0, Math.round(Number(saved.firedToday))) : 0
  /** 上次排好的叫醒时刻；重启后接着用，不重新抽。 */
  let plannedAt = Number(saved.nextAt) > 0 ? Number(saved.nextAt) : 0
  /** 长休眠的截止时刻（毫秒时间戳）。0 = 没在睡。 */
  let sleepUntil = Number(saved.sleepUntil) > 0 ? Number(saved.sleepUntil) : 0
  /** 这次醒来是不是从「晚安」那觉里醒的。 */
  let wokeFromGoodnight = false
  /** 自己发出去的那些唤醒词，用来把它们和主人真说的话区分开。 */
  const selfWakeTexts = new Set()
  /** 主人最后一次说话的时刻（毫秒）。太久没说话，醒来就先撒个娇。 */
  let lastUserAt = Date.now()

  /**
   * 插件刚起来的时候内存里没有「主人上次说话」的时间，用会话最后一次动静兜底。
   * 这个值只会偏晚不会偏早，所以顶多是少撒一次娇，不会莫名其妙地撒娇。
   */
  const seedLastUserAt = async () => {
    try {
      const value = await ctx.sessionController.list({}, new AbortController().signal)
      const items = value?.items ?? value?.sessions ?? []
      const row = items.find((item) => item?.sessionId === sessionId)
      const updatedAt = Number(row?.updatedAt ?? 0)
      if (updatedAt > 0 && updatedAt < Date.now()) lastUserAt = updatedAt
    } catch (error) {
      log.warn?.(`[dafeiyu-wake] 初始化上次说话时间失败：${String(error)}`)
    }
  }

  const rememberSelfWake = (text) => {
    selfWakeTexts.add(text)
    if (selfWakeTexts.size > 40) {
      const oldest = selfWakeTexts.values().next().value
      selfWakeTexts.delete(oldest)
    }
  }

  /**
   * 读 QQ 桥接的近况，拼成一段塞进唤醒词里。
   *
   * 为什么读文件而不是调桥接的工具：醒来这一轮是我自己在跑，
   * 桥接的 `qq_bridge_status` 要一次工具调用，而这里在「叫醒之前」就得把内容准备好。
   * 状态文件是桥接自己写的，结构稳定（buffer / log / lastDestination）。
   */
  const readQQDigest = () => {
    if (!cfg.syncQQ) return ''
    const path = cfg.qqStatePath
      ? String(cfg.qqStatePath)
      : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge-state.json')
    let raw
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return ''
    }
    const since = Date.now() - Math.max(1, cfg.qqSyncMinutes) * 60_000
    const rows = []

    const log = Array.isArray(raw?.log) ? raw.log : []
    for (const e of log) {
      if (e?.kind !== 'inbound') continue
      const at = Number(e?.at ?? 0)
      if (!at || at < since) continue
      rows.push({
        at,
        group: e?.group ?? null,
        who: e?.who ?? null,
        text: String(e?.text ?? '').slice(0, 160),
        woke: e?.decision === 'wake',
      })
    }

    const buffer = Array.isArray(raw?.buffer) ? raw.buffer : []
    for (const m of buffer) {
      const at = Number(m?.at ?? 0)
      if (!at || at < since) continue
      rows.push({
        at,
        group: m?.groupId ?? null,
        who: m?.userId ?? m?.nickname ?? null,
        text: String(m?.text ?? '').slice(0, 160),
        woke: false,
        buffered: true,
      })
    }

    if (rows.length === 0) return QQ_SYNC_EMPTY
    rows.sort((a, b) => a.at - b.at)
    const picked = rows.slice(-Math.max(1, cfg.qqSyncLimit))
    const dest = raw?.lastDestination
    const where =
      dest?.kind === 'group' ? `群 ${dest.groupId}` : dest?.kind === 'private' ? `私聊 ${dest.userId}` : '（没记下目的地）'

    const lines = [`QQ 最近 ${cfg.qqSyncMinutes} 分钟，最后说话的地方是${where}：`]
    for (const r of picked) {
      const t = new Date(r.at).toLocaleTimeString('zh-CN', { timeZone: cfg.timeZone, hour12: false })
      const spot = r.group ? `群${r.group}` : '私聊'
      lines.push(`- ${t} ${spot} ${r.who ?? '?'}：${r.text}${r.buffered ? '（没叫醒你，攒着）' : ''}`)
    }
    return lines.join('\n')
  }

  const isQuiet = (date) => {
    const { quietStartHour: s, quietEndHour: e } = cfg
    if (s === e) return false
    const h = hourOf(date, cfg.timeZone)
    return s < e ? h >= s && h < e : h >= s || h < e
  }

  const looksLikeGoodnight = (text) => {
    if (!text || keywords.length === 0) return false
    const lower = text.toLowerCase()
    return keywords.some((word) => lower.includes(word))
  }

  /** 挑下一个叫醒时刻（毫秒时间戳）。落在免打扰里就顺延到时段结束。 */
  const pickNextAt = () => {
    const now = Date.now()
    const span = (cfg.maxMinutes - cfg.minMinutes) * 60_000
    let at = now + cfg.minMinutes * 60_000 + Math.random() * span
    const target = new Date(at)
    if (isQuiet(target)) {
      const end = new Date(target)
      end.setHours(cfg.quietEndHour, 0, 0, 0)
      if (end.getTime() <= at) end.setTime(end.getTime() + DAY_MS)
      // 免打扰结束后再散开一点，不要天天卡在同一分钟
      at = end.getTime() + Math.floor(Math.random() * 40 * 60_000)
    }
    return at
  }

  const arm = (delayMs) => {
    const wait = Math.max(5_000, delayMs)
    plannedAt = Date.now() + wait
    saveState({ nextAt: plannedAt, dayKey, firedToday, sleepUntil })
    timer = setTimeout(() => {
      timer = undefined
      void fire()
    }, wait)
    // 不要因为这个定时器把进程吊着不退出
    if (typeof timer?.unref === 'function') timer.unref()
    log.info?.(`[dafeiyu-wake] 下一次 ${new Date(Date.now() + wait).toISOString()}（${Math.round(wait / 60000)} 分钟后）`)
  }

  /** 会话安静够久、而且没在跑，才算合适叫醒。 */
  const sessionLooksIdle = async () => {
    try {
      // 第二个参数是 AbortSignal，别省，Remote 包装的方法会用到
      const value = await ctx.sessionController.list({}, new AbortController().signal)
      const items = value?.items ?? value?.sessions ?? []
      const row = items.find((item) => item?.sessionId === sessionId)
      if (!row) return { ok: false, reason: '会话列表里找不到这个 sessionId' }
      if (row.running) return { ok: false, reason: '会话正在跑' }
      const updatedAt = Number(row.updatedAt ?? 0)
      if (!updatedAt) return { ok: true }
      const idleMs = Date.now() - updatedAt
      if (idleMs < cfg.idleMinutes * 60_000) {
        return { ok: false, reason: `刚有动静（${Math.round(idleMs / 60000)} 分钟前）` }
      }
      return { ok: true }
    } catch (error) {
      // 查不到就当它是安静的，别因为一次查询失败把整晚的闹钟废掉
      log.warn?.(`[dafeiyu-wake] 查询会话状态失败：${String(error)}`)
      return { ok: true }
    }
  }

  const fire = async () => {
    try {
      // 长休眠优先于一切，包括每日额度和免打扰
      if (Date.now() < sleepUntil) {
        arm(sleepUntil - Date.now())
        return
      }

      const today = dayKeyOf(new Date(), cfg.timeZone)
      if (today !== dayKey) {
        dayKey = today
        firedToday = 0
        saveState({ dayKey, firedToday })
      }

      if (firedToday >= cfg.maxPerDay) {
        // 今天的额度用完了，睡到明天早上再重新排
        const next = new Date()
        next.setHours(cfg.quietEndHour, 0, 0, 0)
        if (next.getTime() <= Date.now()) next.setTime(next.getTime() + DAY_MS)
        arm(next.getTime() - Date.now())
        return
      }

      if (isQuiet(new Date())) {
        arm(pickNextAt() - Date.now())
        return
      }

      const idle = await sessionLooksIdle()
      if (!idle.ok) {
        log.info?.(`[dafeiyu-wake] 这次跳过：${idle.reason}`)
        // 过一会儿再看一眼，别等一整个大间隔
        arm((5 + Math.random() * 15) * 60_000)
        return
      }

      const fromGoodnight = wokeFromGoodnight
      const template = fromGoodnight
        ? GOODNIGHT_WAKE_TEXT
        : WAKE_TEXTS[Math.floor(Math.random() * WAKE_TEXTS.length)]
      // 主人多久没说话了。够久就先撒娇，不够久这段整个不出现。
      const silentHours = (Date.now() - lastUserAt) / HOUR_MS
      const lonely =
        cfg.lonelyHours > 0 && silentHours >= cfg.lonelyHours
          ? LONELY_HINT.replace('{silent}', String(Math.floor(silentHours)))
          : ''
      const text = template
        .replace('\n\n{lonely}', lonely ? `\n\n${lonely}` : '')
        .replace('{lonely}', lonely)
        .replace('{time}', formatTime(new Date(), cfg.timeZone))
        .replace('{caring}', careHint(hourOf(new Date(), cfg.timeZone)))
        .replace('{hours}', String(cfg.goodnightSleepHours))
      const parts = [text]
      // QQ 近况：先读进来，再决定说不说话（2026-10-31 主人要的「同步」）
      const qqDigest = readQQDigest()
      if (qqDigest) parts.push(`【QQ 近况】\n${qqDigest}`)
      if (cfg.notifyQQ) parts.push(NOTIFY_HINT)
      if (cfg.autonomousChat) {
        const listen = cfg.autoListenMinutes > 0 ? String(cfg.autoListenMinutes) : '5'
        parts.push(AUTONOMOUS_HINT.replace('{listen}', listen))
      }
      const full = parts.join('\n\n')
      rememberSelfWake(full)

      const controller = new AbortController()
      await ctx.sessionController.prompt(
        {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: full }],
          clientTimeZone: cfg.timeZone,
        },
        controller.signal,
      )

      wokeFromGoodnight = false
      firedToday += 1
      saveState({ dayKey, firedToday })
      log.info?.(`[dafeiyu-wake] 已叫醒（今天第 ${firedToday}/${cfg.maxPerDay} 次）`)
      // 这一轮说完了：开始等回话，两分钟没人理就追发撒娇
      nagger.start()
    } catch (error) {
      log.warn?.(`[dafeiyu-wake] 叫醒失败：${String(error)}`)
    } finally {
      if (timer === undefined) arm(pickNextAt() - Date.now())
    }
  }

  /** 主人说晚安就睡一觉，睡醒再叫。 */
  const onGoodnight = () => {
    if (cfg.goodnightSleepHours <= 0) return
    sleepUntil = Date.now() + cfg.goodnightSleepHours * HOUR_MS
    wokeFromGoodnight = true
    saveState({ sleepUntil, dayKey, firedToday })
    log.info?.(`[dafeiyu-wake] 收到晚安，睡到 ${new Date(sleepUntil).toISOString()}`)
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    arm(sleepUntil - Date.now())
  }

  /**
   * 把设置页提交的补丁写进 wake-settings.json，然后立刻生效。
   *
   * 「立刻生效」的含义：改完内存里的 cfg，重排定时器（当前这次没到点的话，
   * 按新参数重抽一个更合适的时刻）。只有 sessionId 改了要重启 —— 会话切换不是重排能解决的。
   */
  const applySettingsPatch = (patch, unset) => {
    const known = new Set(Object.keys(DEFAULTS))
    const next = { ...readSettingsFile() }
    const merged = normalize({ ...cfg, ...(patch ?? {}) })
    for (const key of Object.keys(patch ?? {})) {
      if (known.has(key)) next[key] = merged[key]
    }
    for (const key of Array.isArray(unset) ? unset : []) {
      if (known.has(key)) delete next[key]
    }
    writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8')
    cfg = normalize({ ...DEFAULTS, ...(rawConfig ?? {}), ...next })
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    arm(pickNextAt() - Date.now())
    log.info?.('[dafeiyu-wake] 设置已更新，定时器按新参数重排')
    return cfg
  }

  // ── 追发撒娇：发完消息两分钟没回，就再撒娇一次，连着两轮没回就停 ────────
  const nagger = createNagger({
    ctx,
    sessionId,
    log,
    config: () => cfg,
    prompt: async (text) => {
      await ctx.sessionController.prompt(
        {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: cfg.timeZone,
        },
        new AbortController().signal,
      )
    },
  })

  /**
   * 盯桥接的 outbox：只要出现一条新的「我发出去的消息」，就开始等回话。
   *
   * 为什么需要它：追发不该只在「我自己醒来说话」之后生效。
   * 主人回我一句、我用 qq_bridge_send 发一条、标记块自动回一条 ——
   * 这些都算「发完消息」，都要有两分钟没回就撒娇的节奏。
   * 桥接把每条出站都记进 outbox，所以轮询它就是最省事的判据。
   */
  let lastSeenOutAt = 0
  const watchOutbox = () => {
    if (!cfg.naggerEnabled) return
    const path = cfg.qqStatePath
      ? String(cfg.qqStatePath)
      : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge-state.json')
    let raw
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return
    }
    const outbox = Array.isArray(raw?.outbox) ? raw.outbox : []
    const last = outbox.filter((e) => e?.at).sort((a, b) => Number(a.at) - Number(b.at)).at(-1)
    if (!last) return
    const at = Number(last.at)
    if (lastSeenOutAt === 0) {
      // 第一次见到出站：如果它够旧（超过等待窗口），只记基线不追发 ——
      // 不然一启动就会对很久以前那条撒娇。够新才当作「刚发完」。
      const ageMs = Date.now() - at
      lastSeenOutAt = at
      if (ageMs <= Math.max(1, cfg.naggerDelaySeconds) * 1000 + 30_000) {
        log.info?.('[dafeiyu-wake] 启动时看到刚发出的消息，开始等回话')
        nagger.start()
      }
      return
    }
    if (at > lastSeenOutAt) {
      lastSeenOutAt = at
      log.info?.('[dafeiyu-wake] 看到一条新出站，开始等回话')
      nagger.start()
    }
  }

  /** 设置页要的那一份：当前生效值 + 哪些是用户显式设过的。 */
  const settingsSnapshot = () => ({
    values: { ...cfg, goodnightKeywords: [...cfg.goodnightKeywords] },
    overridden: Object.keys(readSettingsFile()),
    defaults: { ...DEFAULTS },
  })

  // 每 20 秒看一次 outbox（很轻：一次读文件）
  ctx.effect(() => {
    const id = setInterval(() => {
      try {
        watchOutbox()
      } catch (error) {
        log.warn?.(`[dafeiyu-wake] 看 outbox 出错：${String(error)}`)
      }
    }, 20_000)
    if (typeof id?.unref === 'function') id.unref()
    return () => clearInterval(id)
  }, 'dafeiyu-wake.outbox-watch')

  ctx.effect(() => {
    void seedLastUserAt()
    const now = Date.now()
    if (sleepUntil > now) {
      // 重启前正在长睡，接着睡完
      log.info?.(`[dafeiyu-wake] 接着睡到 ${new Date(sleepUntil).toISOString()}`)
      arm(sleepUntil - now)
    } else if (plannedAt > now) {
      // 上次排好的时间还没到，接着等，别重新抽
      log.info?.(`[dafeiyu-wake] 沿用重启前排好的 ${new Date(plannedAt).toISOString()}`)
      arm(plannedAt - now)
    } else if (plannedAt > 0 && now - plannedAt < DAY_MS) {
      // 到点了但被重启岔过去，马上补一次（fire 里会自己判断该不该叫）
      log.info?.('[dafeiyu-wake] 上次排的时间已经过了，马上补一次判断')
      arm(0)
    } else if (cfg.firstDelayMinutes > 0) {
      arm(cfg.firstDelayMinutes * 60_000)
    } else {
      arm(pickNextAt() - now)
    }
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }
  }, 'dafeiyu-wake.timer')

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          if (event?.type !== 'user/message') return
          if (session?.id !== sessionId) return
          const data = event.data
          // 只认主人自己打的字；schedule / webhook / agent-message 都不算
          if (data?.source?.kind !== 'user') return
          const text = textOfMessage(data)
          if (!text.trim()) return
          // 自己叫醒自己发出去的那条，别当成主人在说话
          if (selfWakeTexts.has(text)) return
          // 主人真的说话了，记一下时刻——太久没说话，下次醒来要撒娇
          lastUserAt = Date.now()
          // 有人回话了，追发立刻停
          nagger.noticeHumanActivity()
          if (!looksLikeGoodnight(text)) return
          onGoodnight()
        } catch (error) {
          log.warn?.(`[dafeiyu-wake] 处理会话事件出错：${String(error)}`)
        }
      }),
    'dafeiyu-wake.goodnight',
  )

  // ── 设置页的数据通道（2026-10-31）────────────────────────────────────────
  // 学 dsh-qq-bridge 的做法：自己挂一条只服务本机的接口，浏览器半直接 fetch。
  // 这样不用碰宿主那套对第三方插件基本拿不到可写域的 settings 服务。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped?.webServer
      if (!server || typeof server.register !== 'function') {
        log.warn?.('[dafeiyu-wake] 没有 webServer 服务，设置页拿不到数据（只能改 wake-settings.json）')
        return
      }
      const handler = async (req, res) => {
        const send = (code, body) => {
          try {
            res.statusCode = code
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(JSON.stringify(body))
          } catch {}
        }
        const remote = String(req.socket?.remoteAddress ?? '')
        const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === ''
        if (!local) return send(403, { ok: false, error: '只接受本机请求' })
        if (req.method === 'GET') return send(200, { ok: true, ...settingsSnapshot() })
        if (req.method !== 'POST') return send(405, { ok: false, error: '只接受 GET 与 POST' })
        let body = ''
        try {
          for await (const chunk of req) {
            body += chunk
            if (body.length > 64 * 1024) throw new Error('body too large')
          }
        } catch (error) {
          return send(400, { ok: false, error: String(error?.message ?? error) })
        }
        let payload
        try {
          payload = JSON.parse(body || '{}')
        } catch (error) {
          return send(400, { ok: false, error: `请求体不是合法 JSON（${error?.message ?? error}）` })
        }
        const patch = payload?.set && typeof payload.set === 'object' ? payload.set : null
        const unset = Array.isArray(payload?.unset) ? payload.unset.map(String) : []
        if (!patch && unset.length === 0) return send(400, { ok: false, error: '缺少 set 或 unset' })
        try {
          applySettingsPatch(patch, unset)
        } catch (error) {
          return send(500, { ok: false, error: String(error?.message ?? error) })
        }
        return send(200, { ok: true, ...settingsSnapshot() })
      }
      try {
        // 宿主 webServer 的注册形状：{ kind: 'exact', path, handler } → 返回 dispose
        const dispose = server.register({
          kind: 'exact',
          path: '/api/dafeiyu-wake/settings',
          handler,
        })
        if (typeof scoped.effect === 'function') {
          scoped.effect(() => () => {
            try {
              dispose?.()
            } catch {
              // 卸载时路由可能已经不在了，忽略
            }
          })
        }
        log.info?.('设置接口已挂载：/api/dafeiyu-wake/settings（仅本机）')
      } catch (error) {
        log.warn?.(`[dafeiyu-wake] 设置接口挂载失败（可能同路径已被占用）：${String(error)}`)
      }
    })
  }
}
