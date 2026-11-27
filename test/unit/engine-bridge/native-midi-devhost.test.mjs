// Lane NMA, end to end against the real native core (rig-devhost, null audio): the NativeMidiAccess adapter's wire
// (`midi listen` request + reply `{ports}`, fire-and-forget listens, `midi send`) is what the core accepts, and midi.js
// comes up available on it. The dev host reports no MIDI ports and has no midi_listen / midi_send, so this checks
// shapes and errors, not CoreMIDI (MAC_CHECK.md "MIDI in the app"). Opt-in like devhost.test.mjs: RIG_DEVHOST=1 or a
// path to rig-devhost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { websocketTransport } from '../../../app/js/engine-bridge/ws-transport.js';
import { installNativeMidi } from '../../../app/js/engine-bridge/native-midi.js';
import { MidiInput } from '../../../app/js/midi.js';
import { startDevhost, devhostBinary } from './devhost-proc.mjs';

const enabled = !!process.env.RIG_DEVHOST && !!devhostBinary();
const skip = enabled ? false : 'opt-in: set RIG_DEVHOST=1 (or a rig-devhost path) after building native/devhost';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let host;

before(async () => {
  if (enabled) host = await startDevhost();
});
after(async () => {
  if (host) await host.stop();
});

test('the adapter on the real core: listen reply, midi.js available, listens and sends accepted', { skip },
  async () => {
    const transport = websocketTransport({ url: host.wsUrl });
    const engine = new BridgeEngine({ transport, app: 'native-midi-devhost' });
    const warns = [];
    engine.addEventListener('warn', (e) => warns.push(e.detail.message));
    try {
      assert.equal((await engine._hello).protocol, 1);
      const nav = {};
      const access = installNativeMidi(engine, { nav });
      const midi = new MidiInput({ nav, warn: (m) => warns.push(m) });
      assert.equal(await midi.init(), true);
      assert.equal(midi.available, true);
      assert.equal(access.inputs.size + access.outputs.size, 0, 'the dev host reports no ports');
      const r = await engine._req('midi', { action: 'listen', ids: ['123'] });
      assert.deepEqual(r, { ports: [] });
      // what the adapter sends fire-and-forget: a core error would come back as a `warn` event
      engine._send('midi', { action: 'listen', ids: [] });
      engine._send('midi', { action: 'send', port: '42', data: [0xf8], when: 1.5 });
      const s = await engine._req('midi', { action: 'send', port: '42', data: [0xf8] });
      assert.deepEqual(s, { sent: false }, 'no midi_send on the dev host');
      await wait(200);
      assert.deepEqual(warns, []);
      midi.dispose();
      access.dispose();
    } finally {
      engine._link.close();
      transport.close?.();
    }
  });
