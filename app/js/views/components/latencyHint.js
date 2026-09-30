// latencyHint(): the one-line "Bluetooth output adds ~N ms" warning (hardware pass 2026-09-29: the JBL Charge 5 over
// Bluetooth measured 176 ms against 20 ms on the dock). Shown under Settings › Audio › Latency and in Quick › This Mac
// while the output latency the app already reports (controller status.latencyMs) is above LATENCY_WARN_MS.
// Dismissed per output device NAME (the label enumerateDevices gives, "Default - " stripped; `device:<id>` while the
// browser hides labels), remembered in localStorage and shared by every instance on the page. No engine calls.

/** Above this output latency (ms) the hint shows. */
export const LATENCY_WARN_MS = 60;
const KEY = 'worship-rig.latency-hint.dismissed';
const EVT = 'rig-latency-hint-dismissed';

/**
 * The hint's copy.
 * @param {number} ms
 * @returns {string}
 */
export function latencyWarnText(ms) {
  return `Bluetooth output adds ~${Math.round(Number(ms) || 0)} ms — use the headphone jack or a dock for live playing`;
}

let memory = null; // storage blocked: this page only
function readDismissed() {
  if (memory) return memory;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return new Set(Array.isArray(v) ? v.map(String) : []);
  } catch {
    memory = new Set();
    return memory;
  }
}
function addDismissed(name) {
  const s = readDismissed();
  s.add(name);
  try {
    localStorage.setItem(KEY, JSON.stringify([...s].slice(-20)));
  } catch {
    memory = s;
  }
}

/**
 * The output device's name for `deviceId` ('default' / '' = the system default), or `device:<id>` when the
 * browser hides device labels or cannot list outputs.
 * @param {string} [deviceId]
 * @returns {Promise<string>}
 */
export async function outputDeviceName(deviceId) {
  const id = deviceId || 'default';
  try {
    const md = navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return `device:${id}`;
    const outs = (await md.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const d = outs.find((x) => x.deviceId === id);
    const label = d && d.label ? d.label.replace(/^Default\s*-\s*/i, '').trim() : '';
    return label || `device:${id}`;
  } catch {
    return `device:${id}`;
  }
}

/**
 * The hint element. set() is cheap to call on every status tick: the name is looked up only when the latency is
 * over the threshold and the device id changed (or a device was added / removed).
 * @param {object} [o]
 * @param {string} [o.className]
 * @param {string} [o.testid]
 * @param {(shown:boolean) => void} [o.onChange]  after it shows or hides
 * @returns {{el:HTMLElement, set(s:{latencyMs?:number|null, deviceId?:string}):void, readonly shown:boolean,
 *            readonly device:string|null, dismiss():void, destroy():void}}
 */
export function latencyHint(o = {}) {
  const el = document.createElement('div');
  el.className = `latency-hint${o.className ? ` ${o.className}` : ''}`;
  el.setAttribute('role', 'status');
  el.hidden = true;
  if (o.testid) el.dataset.testid = o.testid;
  const text = document.createElement('span');
  text.className = 'lh-text';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'lh-x';
  x.textContent = '×';
  x.title = 'Don’t show this again for this output';
  x.setAttribute('aria-label', 'Dismiss the latency hint for this output');
  el.append(text, x);

  let ms = 0;
  let deviceId = 'default';
  let name = null; // resolved for nameFor
  let nameFor = null;
  let askedFor = null; // lookup in flight for this id
  let seq = 0;
  let shown = false;

  const render = () => {
    const want = ms > LATENCY_WARN_MS && name !== null && !readDismissed().has(name);
    if (want) {
      const t = latencyWarnText(ms);
      if (text.textContent !== t) text.textContent = t;
      if (el.title !== t) el.title = t;
    }
    if (want === shown) return;
    shown = want;
    el.hidden = !want;
    if (typeof o.onChange === 'function') o.onChange(want);
  };
  const resolve = () => {
    const my = ++seq;
    const id = deviceId;
    askedFor = id;
    outputDeviceName(id).then((n) => {
      if (my !== seq) return;
      askedFor = null;
      name = n;
      nameFor = id;
      render();
    });
  };
  const onDevices = () => {
    nameFor = null;
    askedFor = null;
    if (ms > LATENCY_WARN_MS) resolve();
  };
  const onDismissed = () => render();
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
  md?.addEventListener?.('devicechange', onDevices);
  document.addEventListener(EVT, onDismissed);
  x.addEventListener('click', () => api.dismiss());

  const api = {
    el,
    set(s = {}) {
      if ('latencyMs' in s) ms = Number(s.latencyMs) || 0;
      if ('deviceId' in s) deviceId = s.deviceId || 'default';
      if (ms > LATENCY_WARN_MS && nameFor !== deviceId && askedFor !== deviceId) {
        name = null; // hidden until the new device's name is known (and not dismissed)
        resolve();
      }
      render();
    },
    get shown() {
      return shown;
    },
    get device() {
      return name;
    },
    dismiss() {
      if (name === null) return;
      addDismissed(name);
      document.dispatchEvent(new CustomEvent(EVT, { detail: { name } }));
      render();
    },
    destroy() {
      seq += 1;
      md?.removeEventListener?.('devicechange', onDevices);
      document.removeEventListener(EVT, onDismissed);
      el.remove();
    },
  };
  return api;
}
