# samples (M10, T06)

| file | what |
|---|---|
| `decode.{h,cpp}` | MP3 (dr_mp3), WAV (dr_wav), everything else through `rig_host.decode_file` (AAC/M4A/ALAC: Apple fills it) |
| `resampler.{h,cpp}` | Chromium SincResampler port (what `decodeAudioData` runs when the file rate differs from the context) |
| `process_sample.{h,cpp}` | `processSample` + `limitMonoLoss` of `app/js/engine/sampler.js`, bit-identical on the 12 JS vectors |
| `manifest.{h,cpp}` | `normalizeManifest`, `parseNoteName`, gain trims, `SampleRegistry` (factory + `user:` manifests) |
| `buffer_cache.{h,cpp}` | `BufferCache` (LRU/pins/protect/refs/variants, one byte unit), `makeStored` (f32 or int16) |
| `decode_pool.{h,cpp}` | decode workers (`ThreadPool`) and the inline runner of offline mode |
| `cache_service.{h,cpp}`, `cache_register.cpp` | the `cache` service: preload / estimate / sampleStatus / reloadManifests, pcmOverride |

Rules: all cache state is control-thread only; workers only decode (own data) and push into a mailbox that `pump()`
drains. Nothing here runs on the audio thread. Byte unit = STORED bytes (float32 x4, int16 x2); `capMB`, `decodedMB`,
`pinnedMB`, `estimate.mb` and the 1.75 MB default per unknown sample (scaled by storage) all use it.

Tests: `tests/samples_*` (suites `samples_decode`, `samples_process`, `samples_cache`, `samples_service`). The
Chromium-side data comes from `tools/golden/decode-dump/{dump,cache-vectors}.mjs` into
`tools/golden/decode-dump/data/` (git-ignore it: ~120 MB); tests that need it print a skip message when it is absent.
