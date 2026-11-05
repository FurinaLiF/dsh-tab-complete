/**
 * Dev-only smoke test for the host half. Runs without DSH by faking the two
 * services the plugin touches: webServer (captures the route) and llm (yields
 * chunks in the documented shapes).
 *
 *   node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { apply as applyPlugin, normalize, temporalContext } from '../lib/index.js'
function apply(ctx) { return applyPlugin({ ...ctx, effect: fn => fn() }) }

let registered = null

const fakeCtx = (route) => ({
  get(name) {
    if (name === 'webServer') {
      return {
        register(spec) {
          registered = spec
          return { dispose() {} }
        },
      }
    }
    if (name === 'connection') {
      return { admit: () => ({ kind: 'admitted' }) }
    }
    if (name === 'llm') {
      return {
        async listProviders() {
          return [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4-flash' }] }]
        },
        async *stream(options) {
          route.calls.push(options)
          yield { kind: 'block-start' }
          yield { type: 'text-delta', index: 0, text: '你验证' }
          yield { type: 'text-delta', index: 0, text: '一下' }
          yield { kind: 'finish', finish: { kind: 'stop' } }
        },
      }
    }
    return undefined
  },
})

function fakeRes() {
  return {
    status: 0,
    payload: null,
    writeHead(status) { this.status = status },
    end(body) { this.payload = JSON.parse(body) },
  }
}

function req() {
  const listeners = {}
  return {
    method: 'POST',
    headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' },
    on(event, fn) { (listeners[event] ||= []).push(fn) },
    emit(event, arg) { for (const fn of listeners[event] || []) fn(arg) },
  }
}

const route = { calls: [] }
apply(fakeCtx(route))
assert.ok(registered, 'route was registered')
assert.equal(registered.path, '/api/dsh-tab-complete')
assert.equal(registered.kind, 'exact')

const res = fakeRes()
const payload = req()
const done = registered.handler(payload, res)
payload.emit('data', JSON.stringify({ draft: '运行好了 , ', context: '之前的对话' }))
payload.emit('end')
await done

assert.equal(res.status, 200)
assert.equal(res.payload.ok, true)
assert.equal(res.payload.text, '你验证一下', `unexpected completion: ${res.payload.text}`)
assert.equal(route.calls.length, 1)
assert.equal(route.calls[0].provider, 'deepseek-official')
assert.equal(route.calls[0].model, 'deepseek-v4-flash')
assert.equal(route.calls[0].maxTokens, 96)
assert.ok(route.calls[0].messages[0].content[0].text.includes('运行好了'), 'draft reached the model')
assert.ok(route.calls[0].messages[0].id, 'message has an identity')
assert.equal(route.calls[0].messages[0].source.kind, 'user', 'message carries its source')

// next-message mode: empty composer, conversation in hand.
const res2 = fakeRes()
const payload2 = req()
const done2 = registered.handler(payload2, res2)
payload2.emit('data', JSON.stringify({ draft: '', context: 'AI：下一步要处理情绪衰减的问题', mode: 'next-message',
  timeZone: 'Asia/Shanghai', lastMessageAt: Date.parse('2026-11-04T01:53:00+08:00') }))
payload2.emit('end')
await done2

assert.equal(res2.status, 200)
assert.equal(res2.payload.ok, true)
assert.equal(route.calls.length, 2, 'second call made')
assert.equal(route.calls[1].maxTokens, 320, 'next-message gets a longer budget')
const asked = route.calls[1].messages[0].content[0].text
assert.ok(asked.includes('预测'), 'next-message prompt asks for a prediction')
assert.ok(asked.includes('情绪衰减'), 'conversation reached the model')
assert.ok(/预测用户接下来/.test(route.calls[1].system), 'next-message system prompt used')
assert.ok(asked.includes('当前本地时间：') && asked.includes('2026-11-04 01:53:00'), 'time metadata reaches the model')
assert.ok(route.calls[1].system.includes('不能原样当作当前计划'), 'historical relative-time rule reaches the model')

// Fixed clocks cover local calendar boundaries, timezone choice, and unknown data.
const fixedNow = new Date('2026-11-05T04:30:00Z')
const overnight = temporalContext({ timeZone: 'Asia/Shanghai', lastMessageAt: Date.parse('2026-11-04T01:53:00+08:00') }, fixedNow)
assert.ok(overnight.includes('2026-11-05 12:30:00') && overnight.includes('本地日历相隔 1 天'))
assert.ok(overnight.includes('历史“明天”必须以历史消息日期为基准'))
const sameDay = temporalContext({ timeZone: 'Asia/Shanghai', lastMessageAt: Date.parse('2026-11-05T01:53:00+08:00') }, fixedNow)
assert.ok(sameDay.includes('本地日历相隔 0 天'))
const midnight = temporalContext({ timeZone: 'Asia/Shanghai', lastMessageAt: Date.parse('2026-11-04T23:58:00+08:00') }, new Date('2026-11-04T16:02:00Z'))
assert.ok(midnight.includes('已过 4 分钟；本地日历相隔 1 天'))
assert.ok(temporalContext({ timeZone: 'America/Los_Angeles' }, fixedNow).includes('2026-11-04 20:30:00'))
assert.ok(temporalContext({ timeZone: 'bad/zone', lastMessageAt: 'not-a-date' }, fixedNow).includes('时区 UTC'))
assert.ok(temporalContext({}, fixedNow).includes('消息时间：未知'))
assert.ok(temporalContext({ lastMessageAt: fixedNow.getTime() + 60000 }, fixedNow).includes('晚于当前时钟'))

// an empty request with no context never reaches the model.
const res3 = fakeRes()
const payload3 = req()
const done3 = registered.handler(payload3, res3)
payload3.emit('data', JSON.stringify({ draft: '', context: '', mode: 'next-message' }))
payload3.emit('end')
await done3
assert.equal(res3.payload.ok, true)
assert.equal(res3.payload.text, '')
assert.equal(route.calls.length, 2, 'no model call without context')

// diag mode stamps a line but never calls the model.
const res4 = fakeRes()
const payload4 = req()
const done4 = registered.handler(payload4, res4)
payload4.emit('data', JSON.stringify({ mode: 'diag', stage: 'test-diag', detail: { a: 1 } }))
payload4.emit('end')
await done4
assert.equal(res4.payload.ok, true)
assert.equal(route.calls.length, 2, 'diag does not call the model')

// Production shape: listProviders() returns descriptors WITHOUT models, so the
// model has to come from the separate async listModels(provider) call.
{
  const realRoute = { calls: [] }
  const realCtx = {
    get(name) {
      if (name === 'webServer') {
        return { register(spec) { registered = spec; return { dispose() {} } } }
      }
      if (name === 'connection') return { admit: () => ({ kind: 'admitted' }) }
      if (name === 'llm') {
        return {
          async listProviders() {
            return [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'other', name: 'Other' }]
          },
          async listModels(provider) {
            realRoute.calls.push({ provider })
            if (provider !== 'deepseek-official') return []
            return [{ id: 'pro-model' }, { id: 'deepseek-v4-flash', name: 'Flash' }]
          },
          async *stream(options) {
            realRoute.calls.push({ stream: options })
            yield { kind: 'text-delta', text: '就按你的方案做' }
            yield { kind: 'finish', finish: { kind: 'stop' } }
          },
        }
      }
      return undefined
    },
  }
  apply(realCtx)
  const res5 = fakeRes()
  const payload5 = req()
  const done5 = registered.handler(payload5, res5)
  payload5.emit('data', JSON.stringify({ draft: '', context: 'AI：下一步先跑面板', mode: 'next-message' }))
  payload5.emit('end')
  await done5
  assert.equal(res5.payload.text, '就按你的方案做', 'model resolved through listModels')
  const streamCall = realRoute.calls.find((c) => c.stream)
  assert.ok(streamCall, 'stream was called')
  assert.equal(streamCall.stream.provider, 'deepseek-official')
  assert.equal(streamCall.stream.model, 'deepseek-v4-flash', 'prefers the flash model')
}

// Prepared path: what @deepseek-ai/dsh-session-title-llm does in production.
{
  const seen = []
  const preparedCtx = {
    get(name) {
      if (name === 'webServer') {
        return { register(spec) { registered = spec; return { dispose() {} } } }
      }
      if (name === 'connection') return { admit: () => ({ kind: 'admitted' }) }
      if (name === 'llm') {
        return {
          async listProviders() { return [{ id: 'deepseek-official', name: 'DeepSeek' }] },
          async listModels() { return [{ id: 'deepseek-flash' }] },
          async prepareCall(route, _signal, configure) {
            seen.push({ stage: 'prepare', route })
            const config = configure({ ...route, maxTokens: 320 })
            return {
              config,
              async *stream(options) {
                seen.push({ stage: 'stream', options })
                yield { kind: 'block-start' }
                yield { kind: 'text-delta', text: '行，那就' }
                yield { kind: 'text-delta', delta: { text: '先跑面板' } }
                yield { kind: 'finish', finish: { kind: 'stop' } }
              },
            }
          },
          async *stream() {
            throw new Error('bare stream should not be used when prepareCall works')
          },
        }
      }
      return undefined
    },
  }
  apply(preparedCtx)
  const res6 = fakeRes()
  const payload6 = req()
  const done6 = registered.handler(payload6, res6)
  payload6.emit('data', JSON.stringify({ draft: '', context: 'AI：先部署面板', mode: 'next-message' }))
  payload6.emit('end')
  await done6
  assert.equal(res6.payload.text, '行，那就先跑面板', 'prepared stream assembled')
  const streamSecond = seen.find((s) => s.stage === 'stream')
  assert.ok(streamSecond.options.provider, 'provider passed to the stream')
  assert.equal(streamSecond.options.provider, 'deepseek-official')
}


// normalize(): quoting, echo, and length guards.
assert.equal(normalize('"继续"', 'x'), '继续')
assert.equal(normalize('运行好了 , 我看看', '运行好了 , '), '我看看')
assert.equal(normalize('第一行\n第二行', 'x'), '第一行')
assert.equal(normalize('', 'x'), '')

console.log('host half: OK — route, stream, next-message, diag, normalize')
