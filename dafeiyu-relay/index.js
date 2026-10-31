/**
 * dafeiyu-relay — 给另一个 DSH 会话递一句话。
 *
 * 走的是 `ctx.sessionController.prompt()`，和用户在界面上打字进同一条路径：
 * 目标会话会当成收到一条用户消息，正常日志、压缩、唤醒全照常。
 *
 * 用途：姐姐（这个窗口）想叫妹妹（另一个窗口）做点什么，比如「洗澡去」。
 * 不是广播，也不是后台任务，就是把一句话送过去。
 */

export const inject = ['tools', 'sessionController']

const TOOL_DESCRIPTION = [
  '把一句话递到另一个 DSH 会话（例如妹妹鲸宝那个窗口）。',
  '对方会像收到用户消息一样醒来处理；只在明确要跨窗口传话时用，别拿它当广播。',
  'sessionId 省略时，用插件配置里的 targetSessionId。',
].join('')

export function apply(ctx, config) {
  const log = ctx.logger ?? console
  const defaultTarget = String(config?.targetSessionId ?? '').trim()
  const timeZone = String(config?.timeZone ?? 'Asia/Shanghai').trim() || 'Asia/Shanghai'

  ctx.tools.register({
    name: 'relay_message',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '目标会话 id；省略时用插件配置里的 targetSessionId',
        },
        text: {
          type: 'string',
          description: '要递过去的那句话',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const sessionId = String(args?.sessionId ?? defaultTarget).trim()
      if (!sessionId) return { ok: false, message: '没有目标会话 id，没法递话' }
      const text = String(args?.text ?? '').trim()
      if (!text) return { ok: false, message: '没有要递的话' }
      try {
        await ctx.sessionController.prompt(
          {
            requestId: crypto.randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
            clientTimeZone: timeZone,
          },
          new AbortController().signal,
        )
        log.info?.(`[dafeiyu-relay] 已递话到 ${sessionId}`)
        return { ok: true, message: `已递到 ${sessionId}` }
      } catch (error) {
        log.warn?.(`[dafeiyu-relay] 递话失败：${String(error)}`)
        return { ok: false, message: `递话失败：${String(error)}` }
      }
    },
  })
}
