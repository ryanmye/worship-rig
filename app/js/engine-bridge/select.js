// Engine selection for main.js (proposal in native/docs/SHELL.md: replace
//   import { AudioEngine } from './engine/index.js';
// with
//   import { AudioEngine } from './engine-bridge/select.js';
// ). Inside the native shell (window.webkit.messageHandlers.rig exists) `new AudioEngine(opts)` is a BridgeEngine over
// the WKWebView transport; with ?engine=bridge-mock it is a BridgeEngine over MockNative (Chromium dev boot); anywhere
// else it is the Web Audio engine, loaded lazily so the native shell never parses its 0.5 MB. Both bridge boots give a
// page without Web MIDI (WKWebView) a navigator.requestMIDIAccess over the bridge (native-midi.js, lane NMA); a page
// that has Web MIDI (Chromium) keeps its own.
import { webkitAvailable } from './transports.js';

const flag = (() => {
  try {
    return new URLSearchParams(globalThis.location.search).get('engine');
  } catch {
    return null;
  }
})();

let Impl;
if (webkitAvailable()) {
  const { BridgeEngine } = await import('./bridge-engine.js');
  const { installNativeMidi } = await import('./native-midi.js');
  // lane NMA: WKWebView has no Web MIDI; midi.js's requestMIDIAccess() is served by the bridge (native-midi.js)
  Impl = function AudioEngine(opts) {
    const engine = new BridgeEngine(opts);
    installNativeMidi(engine);
    return engine;
  };
} else if (flag === 'bridge-mock') {
  ({ AudioEngine: Impl } = await import('./boot-mock.js'));
} else {
  ({ AudioEngine: Impl } = await import('../engine/index.js'));
}

export const AudioEngine = Impl;
