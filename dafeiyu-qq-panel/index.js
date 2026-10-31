/**
 * dafeiyu-qq-panel —— 给 dsh-qq-bridge 补两样东西。
 *
 * 1. `qq_peek` 工具：主动翻 QQ 那边「没叫醒我」的消息。
 *    dsh-qq-bridge 把没被唤醒的群聊记在 state.log（decision=drop/record），
 *    把攒着没送进来的记在 state.buffer。这些默认我永远看不到 —— 只有被 @ 才醒。
 *    有了这个工具，我可以自己决定「要不要去看看他们在聊什么」。
 *
 * 2. 一张浏览器半的设置面板（见 client.js），把桥接的常用参数放到
 *    「设置 → 插件」里，不用去翻 json 文件。
 *
 * 只读宿主状态文件，不碰桥接自己的逻辑，所以换桥接版本也不会打架。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const inject = ['tools']

const PACKAGE = 'dafeiyu-qq-panel'

function statePathOf(config) {
  if (config?.statePath) return String(config.statePath)
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

function whoName(entry) {
  return entry?.nickname || entry?.who || entry?.userId || '(谁)'
}

function shortText(text, limit) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

export function apply(ctx, config) {
  const log = ctx.logger ?? console
  const statePath = statePathOf(config)
  /** 默认回看多少条，可以按需调 */
  const defaultLimit = Number(config?.defaultLimit) > 0 ? Number(config.defaultLimit) : 30

  ctx.tools.register({
    name: 'qq_peek',
    description: [
      '翻看 QQ 那边「没叫醒我」的消息：群里没 @ 我的、私聊里被概率挡掉的、以及攒着还没送进来的缓冲。',
      'dsh-qq-bridge 默认只在我被 @ 或被叫名字时才让我看见，这个工具让我主动去看。',
      '看完可以自己决定要不要用 qq_bridge_send 回一句；不想理就什么都别做。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: `回看最近多少条（默认 ${defaultLimit}，最多 200）`,
        },
        groupId: {
          type: 'string',
          description: '只看这个群号；不给就看全部',
        },
        onlyUnwoken: {
          type: 'boolean',
          description: 'true = 只看没叫醒我的（默认）；false = 连叫醒过的也算上',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = Math.max(1, Math.min(200, Number(args?.limit) || defaultLimit))
      const groupFilter = args?.groupId ? String(args.groupId) : ''
      const onlyUnwoken = args?.onlyUnwoken !== false

      const state = readState(statePath)
      if (!state) {
        return {
          ok: false,
          text: `读不到 QQ 桥接的状态文件（${statePath}）。确认 dsh-qq-bridge 装着并且跑过一轮。`,
        }
      }

      const lines = []

      // 缓冲：攒着没送进来的（record 分支）
      const buffer = Array.isArray(state.buffer) ? state.buffer : []
      const buffered = buffer
        .filter((m) => !groupFilter || String(m?.groupId ?? '') === groupFilter)
        .slice(-limit)
      lines.push(`## 攒着没送进来的 ${buffered.length} 条`)
      if (buffered.length === 0) lines.push('（空）')
      for (const m of buffered) {
        const at = m?.at ? new Date(Number(m.at)).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '--:--'
        const where = m?.groupName || (m?.groupId ? `群${m.groupId}` : '私聊')
        const imgs = Array.isArray(m?.images) && m.images.length ? ` [${m.images.length}张图]` : ''
        lines.push(`- ${at} ${where} ${whoName(m)}：${shortText(m?.text, 120)}${imgs}`)
      }

      // 台账：decision=drop/record 的那些
      const rawLog = Array.isArray(state.log) ? state.log : []
      const inbound = rawLog.filter((e) => e?.kind === 'inbound')
      const filtered = inbound
        .filter((e) => !groupFilter || String(e?.group ?? '') === groupFilter)
        .filter((e) => (onlyUnwoken ? e?.decision !== 'wake' : true))
        .slice(-limit)

      lines.push('')
      lines.push(`## 最近的入站（${onlyUnwoken ? '没叫醒我的' : '全部'}）${filtered.length} 条`)
      if (filtered.length === 0) lines.push('（空）')
      for (const e of filtered) {
        const at = e?.at ? new Date(Number(e.at)).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '--:--'
        const where = e?.group ? `群${e.group}` : '私聊'
        const mark = e?.decision === 'wake' ? '●' : e?.decision === 'drop' ? '×' : '○'
        const why = e?.reason ? `(${e.reason})` : ''
        lines.push(`- ${at} ${mark} ${where} ${e?.who ?? '?'}${why}：${shortText(e?.text, 120)}`)
      }

      lines.push('')
      lines.push(`（状态文件：${statePath}）`)
      return { ok: true, text: lines.join('\n') }
    },
  })

  log.info?.(`[${PACKAGE}] qq_peek 已就绪，读的是 ${statePath}`)
}
