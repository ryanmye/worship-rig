// An `audio` reply's state snapshot must not undo a `state` event delivered after it in the same turn (T09 review:
// against rig-devhost under Node's WebSocket, `[... re:2 {state:'suspended'}]` and `{ev:'state', state:'running'}`
// arrived in one read, the event was applied first, then start()'s continuation put ctx.state back to 'suspended').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';

const ST = { sleep: 'awake', latencyMs: 0, sampleRate: 48000, deviceId: 'default', channels: 2 };

/** A transport that answers by script; `audio` replies are followed, in the same delivery, by `after(m)`. */
function scripted(after) {
  let cb = null;
  const out = (batch) => queueMicrotask(() => cb && cb(batch));
  return {
    post(m) {
      const hello = { protocol: 1, engine: 'test', sampleRate: 48000 };
      if (m.op === 'hello') out({ v: 1, re: m.id, ok: true, result: hello });
      else if (m.op === 'audio') {
        out([{ v: 1, re: m.id, ok: true, result: { state: 'suspended', ...ST } }, ...after(m)]);
      } else if (m.id !== undefined) out({ v: 1, re: m.id, ok: true, result: [] });
    },
    onMessage(f) {
      cb = f;
      return () => {
        cb = null;
      };
    },
    close() {},
  };
}

test('start(): a state event batched after the reply wins over the reply snapshot', async () => {
  const e = new BridgeEngine({ transport: scripted(() => [{ v: 1, ev: 'state', state: 'running', ...ST }]) });
  await e.start();
  assert.equal(e.ctx.state, 'running');
  e._dispose();
});

test('start(): without any state event the reply snapshot is applied', async () => {
  const e = new BridgeEngine({ transport: scripted(() => []) });
  await e.start();
  assert.equal(e.ctx.state, 'suspended');
  e._dispose();
});

test('restart()/setSinkId(): the same rule', async () => {
  const e = new BridgeEngine({
    transport: scripted((m) => (m.action === 'start' ? [] : [{ v: 1, ev: 'state', state: 'running', ...ST }])),
  });
  await e.start();
  assert.equal(e.ctx.state, 'suspended');
  await e.restart();
  assert.equal(e.ctx.state, 'running');
  await e.setSinkId('default');
  assert.equal(e.ctx.state, 'running');
  e._dispose();
});
