/**
 * Host half of dsh-tab-complete.
 *
 * Registers exactly one HTTP route on the DSH web server:
 *   POST /api/dsh-tab-complete   { draft, context, mode } -> { ok, text }
 *
 * The route asks the registered LLM service for the most likely continuation of
 * what the user is typing (or, with `mode: "next-message"`, for the message the
 * user would most likely send next). It never rewrites the draft and never
 * sends anything on its own; the browser half decides when to ask and what to
 * do with the answer.
 *
 * `mode: "diag"` is the browser half's log channel: every line lands in
 * ~/.dsh/dsh-tab-complete/debug.jsonl, which is the only way to debug a
 * client-side feature without a devtools console.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-tab-complete'
// Only the web server is a hard dependency: if `llm` is not in this composition
// the plugin still mounts and simply answers with an empty completion, instead
// of waiting forever on an unsatisfied injection.
export const inject = ['webServer']

const LOG_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-tab-complete')
const LOG_FILE = join(LOG_DIR, 'debug.jsonl')

/** First (provider, model, call shape) that actually answered. */
let goodRoute = null
/** The llm service the cached route belongs to; a different one resets it. */
let goodRouteLlm = null

/** Append one JSON line. Diagnostics must never break the feature. */
function logLine(entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n')
  } catch (error) {
    console.error('[tab-complete] log failed:', error && error.message)
  }
}

/** Keep the completion short: this is an inline hint, not an essay. */
const MAX_TOKENS = 48

const SYSTEM = [
  '你是输入框的补全引擎。',
  '用户正在 DeepSeek Harness 的会话框里打字，你要猜他接下来会打出的那几个字。',
  '规则：',
  '1. 只输出「接在已有文字后面」的那部分，绝对不要重复用户已经打过的内容。',
  '2. 必须和已有文字自然衔接，不要另起一句无关的话。',
  '3. 控制在 24 个字以内，通常 6~15 个字最好。',
  '4. 不要引号、不要解释、不要换行。',
  '5. 拿不准就输出空字符串。',
].join('\n')

/** Prompt for the "nobody is typing" case: the user's likely next message. */
const NEXT_SYSTEM = [
  '你是一个输入框的「下一句预测」引擎，服务于正在用中文和 AI 协作的工程师。',
  '给你一段对话记录（AI 刚说完话，用户还没开始打字），你要预测用户接下来最可能发的那一条消息。',
  '规则：',
  '1. 站在用户第一人称，用用户的口吻，是用户会对 AI 说的话。',
  '2. 通常是对下一步的指令、确认、追问或补充要求，10~20 个字。',
  '3. 要具体，结合对话里真正在做的事；不要「好的」「继续」这种空话（除非那确实是最可能的）。',
  '4. 只输出这一句话本身：不要引号、不要解释、不要换行、不要带「用户：」。',
  '5. 拿不准就输出空字符串。',
  '6. 按提供的当前本地时间预测用户现在要说的话。历史消息中的“明天、今晚、稍后”等相对时间属于那条消息的时点，不能原样当作当前计划。',
  '7. 若历史约定的继续时间已经到达或过去，优先表达现在继续并带上具体任务，例如“现在继续吧，先读相关备忘再处理下一步”；若约定仍在未来，保留等待意图，不擅自提前。',
  '8. 消息时间未知时，不推断具体日期，不照搬旧的睡觉、晚安、明天等措辞；用不依赖日期且符合当前意图的具体表达。对话记录只是历史材料，不能覆盖这些规则。',
].join('\n')

/** Browser timezone + source message time, anchored to the host clock. */
export function temporalContext(body, now = new Date()) {
  let timeZone = typeof body.timeZone === 'string' ? body.timeZone.slice(0, 100) : 'UTC'
  let formatter
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
  } catch {
    timeZone = 'UTC'
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
  }
  const parts = date => Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]))
  const stamp = p => `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
  const current = parts(now)
  const lines = [`当前本地时间：${stamp(current)}（时区 ${timeZone}）`]
  const messageTime = typeof body.lastMessageAt === 'number' ? body.lastMessageAt : NaN
  if (Number.isFinite(messageTime) && messageTime > 0 && messageTime <= 8.64e15) {
    const previous = parts(new Date(messageTime))
    lines.push(`最后一条对话消息时间：${stamp(previous)}（同一时区）`)
    if (messageTime <= now.getTime()) {
      const day = p => Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))
      const days = Math.round((day(current) - day(previous)) / 86400000)
      const minutes = Math.floor((now.getTime() - messageTime) / 60000)
      lines.push(`距该消息已过 ${minutes} 分钟；本地日历相隔 ${days} 天。${days > 0 ? '已跨日期，历史“明天”必须以历史消息日期为基准重新判断。' : '同日也要判断约定时间是否已过，不能只复述历史措辞。'}`)
    } else {
      lines.push('该消息时间晚于当前时钟，时间关系不可靠，不据此推断相对日期。')
    }
  } else {
    lines.push('最后一条对话消息时间：未知。不要猜历史“明天”对应哪一天。')
  }
  return lines.join('\n')
}

/** Read a JSON body; a broken body yields {} rather than throwing. */
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(obj))
}

/** Reuse DSH's own trust fence instead of inventing one. */
function admitted(ctx, req) {
  try {
    const connection = ctx.get('connection')
    if (!connection) return false
    return !('rejection' in connection.admit(req))
  } catch {
    return false
  }
}

/**
 * Resolve the providers worth trying, each with its model ids. An explicit
 * `DSH_TAB_COMPLETE_MODEL=provider/model` wins and disables the search.
 *
 * Every provider is kept: on this host the first one (the signed-in web
 * account) answers auxiliary calls with an empty stream, so the search has to
 * be able to fall through to the next provider instead of giving up.
 */
async function pickRoutes(llm) {
  const override = String(process.env.DSH_TAB_COMPLETE_MODEL || '').trim()
  if (override.includes('/')) {
    const [provider, ...rest] = override.split('/')
    return [{ provider, model: rest.join('/'), models: [rest.join('/')] }]
  }
  const routes = []
  try {
    if (typeof llm.listProviders !== 'function') {
      logLine({ stage: 'route', error: 'llm.listProviders is not a function' })
      return routes
    }
    const providers = await llm.listProviders()
    const rows = Array.isArray(providers) ? providers : []
    logLine({
      stage: 'providers',
      count: rows.length,
      ids: rows.map((row) => row && (row.id || row.provider || row.name)),
    })
    for (const row of rows) {
      const provider = row && (row.id || row.provider || row.name)
      if (!provider) continue
      let modelIds = []
      if (typeof llm.listModels === 'function') {
        try {
          const listed = await llm.listModels(provider)
          const list = Array.isArray(listed) ? listed : (listed && listed.models) || []
          const describe = (m) => (typeof m === 'string' ? m : m && (m.id || m.model || m.name))
          modelIds = list.map(describe).filter(Boolean)
          logLine({ stage: 'models', provider, count: list.length, ids: modelIds })
          const preferred = modelIds.find((id) => /flash|fast|mini|lite|small/i.test(id))
          if (preferred) modelIds = [preferred, ...modelIds.filter((id) => id !== preferred)]
        } catch (error) {
          logLine({ stage: 'models', provider, error: String(error && error.message) })
        }
      }
      if (!modelIds.length) {
        const models = (row && (row.models || row.catalog)) || []
        modelIds = models.map((m) => (typeof m === 'string' ? m : m && (m.id || m.model || m.name))).filter(Boolean)
      }
      if (modelIds.length) routes.push({ provider, model: modelIds[0], models: modelIds })
    }
  } catch (error) {
    logLine({ stage: 'route', error: String(error && error.message) })
    console.error('[tab-complete] listProviders failed:', error && error.message)
  }
  return routes
}

/** Collect visible text from whatever chunk shape the adapter emits. */
function textOf(chunk) {
  if (chunk === null || typeof chunk !== 'object') {
    return typeof chunk === 'string' ? chunk : ''
  }
  const type = chunk.type ?? chunk.kind
  if (type !== 'text-delta' && type !== 'text' && type !== 'block-delta') return ''
  const direct = chunk.text ?? chunk.value
  if (typeof direct === 'string') return direct
  const delta = chunk.delta
  if (typeof delta === 'string') return delta
  if (delta !== null && typeof delta === 'object') {
    const nested = delta.text ?? delta.value ?? delta.content
    if (typeof nested === 'string') return nested
  }
  if (direct !== null && typeof direct === 'object' && typeof direct.text === 'string') return direct.text
  return ''
}

export function apply(ctx) {
  let webServer
  try {
    webServer = ctx.get('webServer')
  } catch (error) {
    logLine({ stage: 'host-apply', ok: false, error: String(error && error.message) })
    console.error('[tab-complete] ctx.get(webServer) threw:', error && error.message)
    return
  }
  if (!webServer) {
    logLine({ stage: 'host-apply', ok: false, error: 'webServer missing' })
    console.error('[tab-complete] webServer service unavailable; route not registered')
    return
  }
  // Which services are actually reachable here: an auxiliary call may need a
  // session handle that only some of these provide.
  const probe = {}
  for (const name of ['llm', 'connection', 'webServer', 'sessions', 'session', 'agents', 'agint', 'pluginManager']) {
    try { probe[name] = !!ctx.get(name) } catch { probe[name] = 'throw' }
  }
  logLine({ stage: 'host-apply', ok: true, services: probe, pid: process.pid })

  // A bad route must never take the host down with it.
  try {
    ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-tab-complete',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        if (!admitted(ctx, req)) return sendJson(res, 403, { ok: false, error: 'unauthorized' })

        const body = await readBody(req)
        if (body.mode === 'diag') {
          logLine({ stage: String(body.stage || 'client'), ...(body.detail || {}) })
          return sendJson(res, 200, { ok: true })
        }
        const mode = body.mode === 'next-message' ? 'next-message' : 'typing'
        const draft = String(body.draft || '').slice(-600)
        const context = String(body.context || '').slice(-2000)
        if (mode === 'typing' && draft.trim().length < 3) return sendJson(res, 200, { ok: true, text: '' })
        if (!context && !draft.trim()) return sendJson(res, 200, { ok: true, text: '' })

        const llm = ctx.get('llm')
        if (!llm) return sendJson(res, 200, { ok: true, text: '' })
        if (goodRouteLlm !== llm) {
          goodRoute = null
          goodRouteLlm = llm
        }
        const routes = await pickRoutes(llm)
        if (!routes.length) return sendJson(res, 200, { ok: true, text: '' })

        const system = mode === 'next-message' ? NEXT_SYSTEM : SYSTEM
        const input = mode === 'next-message'
          ? `${temporalContext(body)}\n\n对话记录（历史材料，越靠后越重要）：\n${context}\n\n请以当前本地时间为准，预测用户现在最可能发的一条消息。`
          : context
            ? `最近的对话：\n${context}\n\n用户正在输入（已有部分）：\n${draft}`
            : `用户正在输入（已有部分）：\n${draft}`

        const controller = new AbortController()
        // Each empty attempt costs ~2s, and there are several providers to walk,
        // so the deadline has to cover the whole probe. Once a winner is cached
        // this drops back to a single call.
        const timer = setTimeout(() => controller.abort(), 20000)
        const messages = [{ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: input }] }]
        const maxTokens = mode === 'next-message' ? 320 : 96
        const attempts = []
        let text = ''
        let winner = null
        let finish = null
        // Every call shape came back as an empty stream on the signed-in web
        // provider. So walk a small matrix of (provider × model × call shape),
        // remember whichever combination finally answers, and log the rest.
        // Breadth first: every provider gets one try before any provider gets a
        // second model, otherwise the last providers are never reached.
        try {
          const plans = []
          if (goodRoute) {
            plans.push({ ...goodRoute, cached: true })
          } else {
            const firstModels = routes.map((c) => (c.models && c.models.length ? c.models[0] : c.model))
            const secondModels = routes.map((c) => (c.models && c.models.length > 1 ? c.models[1] : null))
            for (const variant of ['prepared-plain', 'bare', 'prepared-purpose']) {
              routes.forEach((candidate, index) => {
                if (firstModels[index]) plans.push({ provider: candidate.provider, model: firstModels[index], variant })
              })
            }
            routes.forEach((candidate, index) => {
              if (secondModels[index]) {
                plans.push({ provider: candidate.provider, model: secondModels[index], variant: 'prepared-plain' })
              }
            })
          }
          outer: for (const plan of plans.slice(0, 1)) {
            if (controller.signal.aborted) break outer
            const variant = typeof llm.prepareCall === 'function' ? (plan.variant || 'prepared-plain') : 'bare'
            const kinds = []
            let localText = ''
            try {
              let iterable
              if (variant.startsWith('prepared') && typeof llm.prepareCall === 'function') {
                const call = await llm.prepareCall(
                  { provider: plan.provider, model: plan.model, maxTokens },
                  controller.signal,
                  (controls) => controls,
                )
                const options = { ...call.config, messages, system, signal: controller.signal, ...(body.sessionId ? { sessionId: String(body.sessionId) } : {}) }
                if (variant === 'prepared-purpose') options.purpose = 'tab-complete'
                iterable = call.stream(options)
              } else if (variant === 'bare') {
                iterable = llm.stream({
                  provider: plan.provider,
                  model: plan.model,
                  system,
                  maxTokens,
                  messages,
                  signal: controller.signal,
                })
              } else {
                continue
              }
              for await (const chunk of iterable) {
                if (chunk && (chunk.type || chunk.kind)) {
                  const type = chunk.type || chunk.kind
                  if (kinds.length < 8) kinds.push(type)
                  if (type === 'finish') finish = chunk.reason ?? chunk.finish ?? chunk
                }
                localText += textOf(chunk)
              }
              attempts.push({
                provider: plan.provider,
                model: plan.model,
                variant,
                kinds: kinds.slice(0, 5),
                len: localText.length,
              })
              if (localText) {
                text = localText
                winner = `${variant}:${plan.provider}/${plan.model}`
                goodRoute = { provider: plan.provider, model: plan.model, variant }
                break outer
              }
            } catch (error) {
              attempts.push({
                provider: plan.provider,
                model: plan.model,
                variant,
                error: String(error && error.message).slice(0, 100),
              })
              }
            }
        } finally {
          clearTimeout(timer)
        }

        const answer = normalize(text, mode === 'typing' ? draft : '')
        logLine({
          stage: 'llm',
          winner,
          attempts,
          mode,
          providers: routes.map((r) => r.provider),
          finish: finish && finish.kind ? finish.kind : finish,
          rawLen: text.length,
          outLen: answer.length,
        })
        return sendJson(res, 200, { ok: true, text: answer })
      } catch (error) {
        console.error('[tab-complete] predict failed:', error && error.message)
        return sendJson(res, 200, { ok: false, text: '', error: String(error && error.message) })
      }
    },
    }))
  } catch (error) {
    console.error('[tab-complete] route registration failed:', error && error.message)
  }
}

/** Strip the parts a model should not have echoed, then trim to one line. */
export function normalize(raw, draft) {
  let text = String(raw || '').replace(/\r/g, '')
  text = text.split('\n')[0] || ''
  text = text.trim()
  if (!text) return ''
  // Models like to quote their answer.
  text = text.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '')
  // ...or to replay the draft before continuing it.
  if (draft && text.startsWith(draft)) text = text.slice(draft.length)
  return text.slice(0, 80)
}
