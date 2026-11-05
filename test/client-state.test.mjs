// Exercises the shipped client with React hook/slot adapters; no model or DSH calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const slots = [], listeners = new Map(), hooks = [], pending = [], timers = new Map();
let cursor = 0, draft = '', running = false, requests = 0, nextTimer = 0;
let clock = Date.parse('2026-11-05T04:30:00Z');
const messageTime = Date.parse('2026-11-04T17:53:00+08:00');
const predictions = [];
class ClockDate extends Date {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}
const suggestion = '先给我看看修改方案';
const editor = { contains: target => target === editor };
const card = { querySelector: () => editor };
const transcript = { innerText: '助手：已经完成，可以继续查看修改方案。' };
const region = { getAttribute: () => 'session', querySelector: () => transcript };
const React = {
  createElement(type, props, ...children) {
    if (props?.ref) props.ref.current = { closest: () => card };
    return { type, props, children };
  },
  useState(initial) {
    const index = cursor++;
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks[index], value => { hooks[index] = value; }];
  },
  useRef(initial) {
    const index = cursor++;
    return hooks[index] ||= { current: initial };
  },
  useEffect(effect, deps) {
    const index = cursor++, previous = hooks[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
      pending.push(() => { previous?.cleanup?.(); hooks[index] = { deps, cleanup: effect() }; });
    }
  },
};
const window = {
  // A previous OFF preference must not disable the always-on version.
  localStorage: { getItem: () => '0' },
  addEventListener: (type, fn) => listeners.set(type, fn),
  removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  __ModuleLoader__: { load: spec => spec.factory(() => React).apply({
    effect: effect => effect(),
    slots: {
      inject: (name, effect) => effect(),
      register: (spec, component) => slots.push({ spec, component }),
    },
  }) },
};
vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window, document: {
    querySelectorAll: () => [region],
    createElement: () => ({ remove() {} }), head: { append() {} },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  },
  fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.mode === 'next-message') { requests++; predictions.push(body); }
    return { json: async () => ({ ok: true, text: suggestion }) };
  },
  AbortController,
  Date: ClockDate,
  MutationObserver: class { observe() {} disconnect() {} },
  setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
  clearTimeout: id => timers.delete(id),
});
assert.deepEqual(slots.map(slot => slot.spec.name), ['conversation.input.overlay']);
const props = {
  sessionId: 'session',
  useSession: select => select({ running, nodes: [{ kind: 'assistant', time: messageTime }] }), useInput: select => select({ draft }),
  inputActions: { captureInsertion: () => ({}), insertText: text => { draft = text; return true; } },
};
function render() {
  cursor = 0;
  const tree = slots[0].component(props);
  while (pending.length) pending.shift()();
  return tree.children[0];
}
async function settle() {
  const callbacks = [...timers.values()]; timers.clear();
  for (const callback of callbacks) await callback();
  return render();
}
function key(key) {
  let prevented = false;
  listeners.get('keydown')({ key, target: editor,
    preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  return prevented;
}
render();
assert.equal(await settle(), suggestion);
assert.equal(requests, 1);
assert.equal(predictions[0].lastMessageAt, messageTime);
assert.equal(predictions[0].timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
for (let repeat = 0; repeat < 2; repeat++) {
  assert.equal(key('Tab'), true);
  assert.equal(draft, suggestion);
  render();
  assert.equal(render(), '');
  draft = ''; render();
  assert.equal(await settle(), suggestion, 'Clearing accepted draft restores prediction');
  assert.equal(requests, 1, 'Restoration uses cache');
}
draft = '自己输入'; render(); assert.equal(render(), '');
draft = ''; render(); assert.equal(await settle(), suggestion);
key('Escape'); assert.equal(render(), '');
draft = '手动输入'; render(); draft = ''; render();
assert.equal(await settle(), '', 'Esc still dismisses this suggestion');
assert.equal(requests, 1);
running = true; render(); assert.equal(render(), '');
transcript.innerText += '\n用户：继续。\n助手：新一轮已完成。';
running = false; render(); assert.equal(await settle(), suggestion);
assert.equal(requests, 2, 'A new completed turn can predict again');
clock += 86400000;
listeners.get('focus')();
assert.equal(render(), '', 'Hide stale hint when returning on a new local date');
assert.equal(await settle(), suggestion);
assert.equal(requests, 3, 'New local date refreshes the stale turn cache once');
listeners.get('visibilitychange')(); await settle();
assert.equal(requests, 3, 'Same-day visibility changes reuse the cache');
console.log('PASS: always on, Tab/clear cache, Esc, next turn, time metadata, cross-day refresh');
