/**
 * 追发撒娇：发完消息等两分钟，没人回就再撒娇一次，连着两轮都没人回就停。
 *
 * 主人 2026-10-31 的原话：「每次发完消息后，如果2分钟没回复，那就再发几回撒娇，
 * 如果还没回复，那就说明在忙或者睡着了，停止即可。」
 *
 * 怎么判断「没人回」：桥接的 state.log 里看这个目的地、这条时间之后有没有新的 inbound。
 * 有 = 回了；没有 = 没回。
 *
 * 单独放一个文件，因为它是「聊天的节奏」，和唤醒的随机节奏是两件事。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOUR_MS = 60 * 60 * 1000

function statePathOf(configured) {
  if (configured) return String(configured)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'qq-bridge-state.json')
}

function readState(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 从桥接状态里找「最后一条我自己发出去的消息」和「之后有没有人来」。
 *
 * 桥接把出站记在 outbox（via: marker / tool），入站记在 log（kind: inbound）。
 * 只看出站之后有没有入站 —— 这就是「回没回」。
 */
function lastExchange(path) {
  const state = readState(path)
  if (!state) return null
  const outbox = Array.isArray(state.outbox) ? state.outbox : []
  const log = Array.isArray(state.log) ? state.log : []

  const lastOut = outbox
    .filter((e) => e?.at)
    .sort((a, b) => Number(a.at) - Number(b.at))
    .at(-1)
  if (!lastOut) return null

  const sentAt = Number(lastOut.at)
  const dest = lastOut.to ?? null
  const after = log.filter((e) => {
    if (e?.kind !== 'inbound') return false
    if (Number(e?.at ?? 0) <= sentAt) return false
    if (!dest) return true
    if (dest.kind === 'group') return String(e?.group ?? '') === String(dest.groupId ?? '')
    if (dest.kind === 'private') return String(e?.who ?? '') === String(dest.userId ?? '')
    return true
  })

  return {
    sentAt,
    dest,
    replied: after.length > 0,
    repliedAt: after.length ? Number(after[0].at) : 0,
    replyText: after.length ? String(after[0].text ?? '') : '',
  }
}

export function createNagger(options) {
  const {
    ctx,
    sessionId,
    log,
    /** 读当前配置（要能拿到最新的，所以传函数而不是值） */
    config,
    /** 往会话里塞一条 prompt */
    prompt,
    /** 最短等待秒数（防止配置写成 0 把自己刷屏）；测试里可以调小 */
    minDelaySeconds = 30,
  } = options

  /** 每次追发的定时器；同一时间只该有一个 */
  let timer
  /** 这一轮追发到第几次了 */
  let round = 0
  /** 这一轮是从哪条出站开始的 */
  let anchorSentAt = 0
  /** 追发期间是不是已经确认有人回了 */
  let satisfied = true

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const stop = (why) => {
    clear()
    round = 0
    satisfied = true
    if (why) log.info?.(`[dafeiyu-wake] 追发结束：${why}`)
  }

  /**
   * 收到任何一条真人消息（不管是不是回我），都算「有人在」—— 立刻停。
   * 主人说的「如果还没回复就说明在忙或睡着了」，反过来说有人说话就不打扰。
   */
  const noticeHumanActivity = () => {
    if (!satisfied) {
      satisfied = true
      stop('有人说话了')
    }
  }

  const armNext = () => {
    const cfg = config()
    if (!cfg.naggerEnabled) return
    const waitMs = Math.max(1, minDelaySeconds, cfg.naggerDelaySeconds) * 1000
    timer = setTimeout(() => {
      timer = undefined
      void check()
    }, waitMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  const check = async () => {
    const cfg = config()
    if (!cfg.naggerEnabled) return
    if (round >= cfg.naggerMaxRounds) {
      stop(`连着 ${round} 次没人回，多半在忙或睡了`)
      return
    }

    const exchange = lastExchange(statePathOf(cfg.qqStatePath))
    if (!exchange) {
      stop('桥接那边没有出站记录')
      return
    }

    // 出站之后有人说话 = 回了
    if (exchange.sentAt > anchorSentAt && exchange.replied) {
      stop('有人回了')
      return
    }
    if (exchange.replied) {
      stop('有人回了')
      return
    }

    round += 1
    const text = (cfg.naggerTexts[Math.min(round - 1, cfg.naggerTexts.length - 1)] ?? '')
      .replace('{round}', String(round))
      .replace('{max}', String(cfg.naggerMaxRounds))

    try {
      await prompt(text)
      log.info?.(`[dafeiyu-wake] 追发第 ${round}/${cfg.naggerMaxRounds} 次`)
    } catch (error) {
      log.warn?.(`[dafeiyu-wake] 追发失败：${String(error)}`)
      stop('追发失败')
      return
    }
    armNext()
  }

  /**
   * 我自己发完一条消息之后调这个，开始计时。
   * 时间锚点取出站记录里的时间，所以晚几秒调也没关系。
   */
  const start = () => {
    const cfg = config()
    if (!cfg.naggerEnabled) return
    const exchange = lastExchange(statePathOf(cfg.qqStatePath))
    anchorSentAt = exchange?.sentAt ?? Date.now()
    round = 0
    satisfied = false
    clear()
    armNext()
    log.info?.(`[dafeiyu-wake] 开始等回话，${cfg.naggerDelaySeconds} 秒没动静就撒娇`)
  }

  return { start, stop, noticeHumanActivity, state: () => ({ round, anchorSentAt, satisfied }) }
}
