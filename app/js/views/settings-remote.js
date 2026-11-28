// Settings › Mac › Remote (remote lane, D34 / D45; native/docs/lanes/REMOTE.md §2.6): the browser remote's switch,
// the address and QR code a phone opens, the pairing code, "New code" and "Forget phones". Native Mac app only: shown
// when window.rig.remote exists (app/js/native-shell/40-bus.js → RigBus.swift → rig_remote). Off by default; the
// setting lives in the shell (UserDefaults), not in the library, because it belongs to this Mac, not to the songs.
// Everything shown comes from rig.remote.info() / onInfo(): {on, port, code, paired, pausedSec, addresses, url,
// pairUrl, qr:{size, modules}}. The QR code is drawn from the module matrix the core made (no QR code in JS).

/** Plain words for what the remote can do (D34), shown under the switch. */
export const REMOTE_HINT = 'Phones on this Wi-Fi can open a page that shows the song and snapshot, steps them, '
  + 'switches the drone and has PANIC. Nothing else. Lock blocks everything but PANIC.';

/**
 * Draw a QR module matrix on a canvas: dark modules black on white, a 4-module quiet zone.
 * @param {HTMLCanvasElement} canvas
 * @param {{size:number, modules:string}|null} qr
 * @param {number} [px] pixels per module
 */
export function drawQr(canvas, qr, px = 4) {
  if (!qr || !Number.isInteger(qr.size) || typeof qr.modules !== 'string' || qr.modules.length !== qr.size * qr.size) {
    canvas.hidden = true;
    return;
  }
  const n = qr.size + 8;
  canvas.width = n * px;
  canvas.height = n * px;
  canvas.hidden = false;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules.charCodeAt(y * qr.size + x) === 49) g.fillRect((x + 4) * px, (y + 4) * px, px, px);
    }
  }
}

/**
 * Mount the Remote section.
 * @param {{rig:object, h:Function, btn:Function, row:Function, toggle:Function}} d  settings.js's helpers
 * @returns {{el:HTMLElement, refresh:() => Promise<void>, destroy:() => void}}
 */
export function mountRemote(d) {
  const { rig, h, btn, row } = d;
  let info = { on: false };
  let busy = false;
  let error = '';
  const onToggle = d.toggle({ label: 'Remote', onChange: (v) => setEnabled(v) });
  onToggle.el.dataset.testid = 'setting-remote';
  const url = h('p.st-remote-url', { 'data-testid': 'remote-url' });
  const qr = h('canvas.st-remote-qr', { 'data-testid': 'remote-qr', role: 'img',
    'aria-label': 'QR code: scan it with the phone’s camera to open the remote and pair it' });
  const code = h('p.st-remote-code', { 'data-testid': 'remote-code' });
  const paired = h('p.st-hint.st-remote-paired', { 'data-testid': 'remote-paired' });
  const status = h('p.st-status.st-remote-status', { 'data-testid': 'remote-status', role: 'status' });
  const newCode = btn('New code', () => run(() => rig.remote.newCode()), { 'data-testid': 'remote-new-code',
    title: 'A new pairing code; phones already paired stay paired' });
  const forget = btn('Forget phones', () => run(() => rig.remote.forgetAll()), { 'data-testid': 'remote-forget',
    title: 'Every paired phone has to enter the code again' });
  const details = h('div.st-remote-details', { 'data-testid': 'remote-details' }, url, qr, code,
    h('div.st-inline', {}, newCode, forget), paired);
  const el = h('section.st-section.st-remote', { 'aria-label': 'Remote', 'data-section': 'remote',
    'data-testid': 'settings-remote' },
  h('h2.st-h2', { text: 'Remote' }),
  row('Phone remote', onToggle.el, REMOTE_HINT),
  details, status);

  function render() {
    onToggle.set(!!info.on);
    onToggle.setDisabled(busy);
    newCode.disabled = busy || !info.on;
    forget.disabled = busy || !info.on || !(info.paired > 0);
    details.hidden = !info.on;
    if (info.on) {
      url.textContent = info.url ? `On a phone on the same Wi-Fi, open ${info.url}` : 'This Mac has no Wi-Fi or network '
        + 'address. Connect it to the same network as the phones.';
      drawQr(qr, info.url ? info.qr : null);
      code.textContent = `Code ${info.code || '—'}`;
      paired.textContent = info.paired === 1 ? '1 phone paired' : `${info.paired || 0} phones paired`;
    }
    let s = error;
    if (!s && info.on && info.pausedSec > 0) {
      s = `Too many wrong codes: pairing paused for ${info.pausedSec} s, and the code changed.`;
    }
    status.textContent = s;
    status.hidden = !s;
  }

  async function run(fn) {
    busy = true;
    render();
    try {
      const r = await fn();
      if (r && typeof r === 'object' && !r.error) info = r;
      error = r && r.error ? String(r.error) : '';
    } finally {
      busy = false;
      render();
    }
  }

  function setEnabled(on) {
    return run(async () => {
      const r = await rig.remote.setEnabled(on);
      if (r && r.error) return { error: `Couldn’t switch the remote on: ${r.error}` };
      return r;
    });
  }

  const off = rig.remote.onInfo((i) => {
    if (i && typeof i === 'object') {
      info = i;
      render();
    }
  });
  render();
  const refresh = () => run(() => rig.remote.info());
  refresh();
  return {
    el,
    refresh,
    destroy() {
      off();
      onToggle.destroy();
    },
  };
}
