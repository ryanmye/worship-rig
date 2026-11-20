# runtime (M3, T08): threads, reliable paths, rate changes

## Threads

| thread | created | runs |
|---|---|---|
| control | `rig_create` (realtime) | bridge, Model, services, timers, MIDI drain, watchdog, rec level events, ticks (`Engine::controlLoop`, 4 ms wake) |
| device | first `audio start` (realtime with a host) | `rig_host.audio_start` / `audio_stop`, in order; may block without stalling the control thread (SETUP_REVIEW 25) |
| rec writer | `rec start` (realtime) | ring -> 16/24-bit WAV, header refresh every 1 s (`rec/rec.cpp`) |
| audio (host's) | the platform | `rig_render`: FIFO adapter, graph, meter/rec sinks, clock-map publish |

Offline (`RIG_MODE_OFFLINE`) has none of them: the caller's thread runs everything, the recorder writes per quantum.

## Audio -> control, never lossy where it matters

- `Garbage` has its own ring (`Graph::popGarbage`, 32768 entries) plus a 1024-entry stash retried every quantum
  (INTERFACE-CHANGE(T08) in `graph/graph.{h,cpp}`). `Engine::send` drains it every 1024 commands, so the pointers in
  flight stay below ring + stash; `GraphStats::garbageLost` counts what could still be lost (0 in every test).
- `VoiceEnded` lost to a full event ring sets the slot's bit (`Graph::takeEndedSlots`); on the following `Dropped`
  event the engine delivers one synthesized `VoiceEnded {sub: 1, a: slot, b: -1}` per slot ("rescan that slot").

## What a sample-rate change rebuilds (contract 6.3, SETUP_REVIEW 16 / 21d)

`rig_host_audio_started` with a new rate -> the audio thread adopts it between quanta (`Graph::adoptRate`):
frame' = ceil(frame * new / old), pending command frames rescaled the same way, `Unit::setSampleRate` on every unit
(coefficients only, no allocation), then a `RateChanged` event. On the control thread (`Model::onAudioEvent`):
`UnitEnv::sampleRate` = new rate (every unit built from then on uses it), then `Service::onRateChanged` on every
service, in registration order:

| service | rebuild on a rate change | test |
|---|---|---|
| `reverb` (T04) | drops idle kernels and prebuilt IRs, rebuilds the playing IR at the new rate and swaps the unit | T04 |
| `cache` (T06) | `BufferCache::setEngineRate`: sizes and natural lengths rescaled, decoded buffers re-resampled | T06 |
| `meter` (T08) | RTA smoothing restarts from silence (a new analyser); slot windows are 256 frames at any rate | `unit.meter` |
| `rec` (T08) | the take ends (`rec {state:'stopped', message:'sample rate changed...'}`): a WAV has one rate | `unit.rec` |
| every service | called exactly once with the new rate | `unit.runtime` (probe service) |
| not yet landed | instruments' wavetables (T11), click buffers (T07), drone (T16) must implement `onRateChanged` | their tasks |

Engine side: the `state` event carries the new `sampleRate`; the clock map takes the new rate from the next
`rig_render`; engine time never goes backwards (`unit.clock`, `unit.runtime`, `unit.soak`).

## Device lifecycle

`audio start|restart|output` -> `state` event (G9) -> `load {phase:'start'}` once -> reply; the host call runs on
the device thread; no `rig_host_audio_started` / `rig_host_audio_state` within 5 s -> `state closed` + `warn
{code:'device'}`. `restart`/`output` while a start is pending -> `busy`; `rig_host_audio_state(SUSPENDED)` (audio_stop's
completion, sent before a restart's reopen) keeps the start pending, CLOSED / INTERRUPTED / RUNNING end it, and
RUNNING resumes rendering. `rig_destroy` drops device jobs not yet started (no audio_start after the platform's
stop). `restart` invalidates prepared tokens (`superseded`). `sleep` (realtime, started, awake) -> Model ramp
(T14) -> rendering suspends after lead + ramp (`sleeping` -> `asleep`); `wake` resumes (`wakeMs`). Ticks:
none while asleep or before the device runs.
