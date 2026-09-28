# ui-core findings (Phase 2)

These are things found while integrating the UI with store / controller / engine / midi / recorder. None of them
was fixed outside ui-core's files. Workarounds live in `app/js/main.js` and `app/js/views/perform.js`.

## Worth fixing (other owners)

1. **controller.toggleView() ignores `settings.performLock`** (controller.js `toggleView`). ⌘E in Chrome, and the
   Electron menu's `toggleView`, switch to Edit even when Perform lock is on.
   *Workaround:* main.js watches `settings.view`. If it becomes `edit` while locked, main.js puts it back to
   `perform` and shows a toast. *Suggested fix:* return early in `toggleView` when `performLock` is true.

2. **Loudness differs between factory songs** (calibration / presets, SPEC §12). I measured each factory song in
   headless Chromium: drones off, C-E-G at velocity 96, output RMS averaged 1.0–2.5 s after note-on, one run.

   | Song | dBFS |
   |---|---|
   | Felt Piano | −18.7 |
   | Building Swell | −21.4 |
   | Prayer Wash | −21.5 |
   | Glass Ocean | −23.6 |
   | Organ Swell | −24.2 |
   | Dusty Piano | −24.2 |
   | Sunday Pad + Piano | −24.6 |
   | Sub + Shimmer | −25.4 |
   | Lofi Rhodes | −27.2 |
   | Rhodes | −29.0 |
   | Grand Piano | −29.4 |

   That is a spread of about 10.7 dB. Grand Piano → Felt Piano (the same sampler) jumps by about 10 dB. The piano
   decays inside the measurement window, so treat the piano numbers as approximate. The spread is still well
   beyond the "no volume jump at song change" goal.

3. **`params.LEARNABLE` still lacks `swell`.** This is CONTRACT_CHANGES shell #4, still open. It only affects
   ui-edit's MIDI Learn table.

## Contract notes / decisions (for ui-edit and integration)

4. **Slot mute.** The model has no mute field, but SPEC §10 asks for a mute toggle in Perform. It is implemented
   with an extra slot field, which the store keeps as an unknown field:
   - Mute: `songs.<id>.patch.slots.<i>.mutedGain = gain`, then `gain = 0`.
   - Unmute: `gain = mutedGain`, then `mutedGain` is deleted (`store.set(path, undefined)`).
   - Perform treats a slot as muted only when `gain === 0 && mutedGain !== undefined`. While muted, the fader shows
     the remembered level greyed out. Moving the Perform fader unmutes.
   - The engine only ever sees `gain`, so a muted slot is silent and the state is persisted.
   - **ui-edit:** if Edit writes a slot gain, it may also clear `mutedGain`. If it doesn't, a stale value is harmless.
   - A first-class `muted` flag in the store and engine would be cleaner later.

5. **Esc while Settings is open closes Settings and does not panic.** main.js intercepts Esc on `window` in the
   capture phase, and the controller skips events that are `defaultPrevented`. Everywhere else, Esc is still Panic.

6. **Key grid semantics.** Clicking a key sets the song's **Hear-In** to that key and moves **Play-In** by the
   same amount, so the transpose amount doesn't change. The grid means "the key the room hears", and the drone
   follows it. Transpose −/+ goes through `controller.transposeUp/Down`, which only changes Hear-In.

7. **The on-screen keyboard uses `controller.perform.noteOn`.** That path applies the `'normal'` velocity curve,
   not `settings.velocitySens`. Velocity comes from where you click on the key: lower on the key is louder,
   40..127. This looks intended, but the setting has no effect on on-screen notes.

8. **Menu `openSettings`.** The controller already subscribes to `window.rig.onMenu` and re-emits unknown ids as
   `controller` `'menu'` events. main.js opens Settings on `{id:'openSettings'}` and does **not** subscribe to
   `rig.onMenu` a second time, which would double-fire Panic and other actions.

9. **Settings module hooks.** When they exist, main.js calls `settingsView.open?.(opts)` and
   `settingsView.close?.()`. `ctx.openSettings({section:'pads'})` is used by Perform's pad-folder button.

## Environment observations (not bugs)

- Headless Chromium reports `engine.latencyMs` = 42 ms at `'interactive'`, so CI screenshots show the ≥ 40 ms
  latency warning. Real Mac hardware should be far lower.
- Headless Chromium's MIDI is either a pending prompt ("Waiting…") or denied ("Blocked"), even after
  `context.grantPermissions(['midi'])`. The UI shows it and gives a hint toast.
- **Electron.** I booted the real app with `RIG_SELFTEST=1 xvfb-run -a npx electron . --no-sandbox` and a temp
  userData directory. Result: 0 console errors and 1 warning (`[midi] MIDI unavailable (failed): Platform dependent
  initialization failed`, from Linux/xvfb). Electron's "Insecure Content-Security-Policy" warning is gone: index.html
  now sets a CSP (`default-src 'self'`, `script-src 'self' blob:` for the recorder worklet's blob fallback,
  `style-src 'self' 'unsafe-inline'`, and `media-src`/`img-src`/`connect-src` also allow `blob:` and `data:`).
