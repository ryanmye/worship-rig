# native/contract

The engine contract for Worship Rig 2.0 (native engine behind the existing web UI). Prose and rationale:
`native/docs/ENGINE_CONTRACT.md`.

| file | what |
|---|---|
| `engine-api.spec.mjs` | hand-written part: engine methods/properties the app uses (with callers, sync/async, `{when}`, bridge mapping), events, not-contract list, param smoothing rules, bridge v1 (ops, events, envelope, errors, timing), Chromium quirks |
| `engine-api.json` | **generated**: the spec + every PARAMS row from `app/js/shared/params.js` (102 rows; type, range, default, coalescing key, smoothing, DSP target, source ref) + the instrument catalogue loaded from the real registry (44 entries incl. hidden `drone-osc`: params, sampler note range, sample count, decode options, gain trims) |
| `tools/build-engine-api.mjs` | builds the JSON; `--check` exits 1 when the JSON is stale (a PARAMS row or the catalogue changed) or a PARAMS row has no smoothing rule |

```sh
node native/contract/tools/build-engine-api.mjs          # regenerate after editing the spec or params.js
node native/contract/tools/build-engine-api.mjs --check  # CI guard (no network, no browser)
```

## Bridge v1 in one screen

Envelope `{v:1, op, id?, ...}` JS → native (with `id` ⇒ one reply `{v, re, ok, result|error}`; without ⇒
fire-and-forget), `{v:1, ev, ...}` native → JS. Engine time `t` = frames rendered / sample rate, monotonic; `when`
is engine time (absent = next block).

JS → native ops: `hello`, `audio` (start/restart/output/sleep/wake), `prepare`, `commit`, `cache`
(preload/estimate/retainReverb), `set` (params, batchable), `song` (transpose/routing/tempo/timeSig/key), `drone`
(key/files/config), `play` (on/off/pedal/wheel/bend/swell/panic/fade/input), `click`, `config`
(mono/lowResource/eqAudition/meters/midiClock/polyphony/voiceLimit/droneFreeze/dynamicRange), `get`
(instruments/stats/devices/sampleStatus/state/param), `midi`
(listen/route/send), `rec`.

Native → JS events: `state`, `tick` (clock + meters, 30 Hz default), `notes`, `wheel`, `load`, `click`, `warn`,
`midi`, `rec`.

## Rules for changing the contract

- Additive change (new field, op action, event field): bump `minor` in `hello`, add a capability string, log it in
  `CONTRACT_CHANGES.md` (repo root) as for any interface change.
- Breaking change: bump `PROTOCOL` (the `v` of every message) and `CONTRACT_VERSION` major.
- A new PARAMS row needs a `PARAM_BEHAVIOUR` rule here, or the build fails.
