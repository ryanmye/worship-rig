/*
 * rig_engine.h: the C API of the Worship Rig native engine core (2.0).
 *
 * This is the ONLY surface that the Apple shell (Swift), the test/golden tools and a future Windows shell use. The
 * core behind it is portable C++20 (native/core/src) with no platform dependencies; device I/O and MIDI ports live in
 * the platform layers (native/apple, later native/windows) and talk to the core through the functions below.
 *
 * Design (native/docs/ARCHITECTURE.md):
 *  - Commands: one JSON entry point, rig_post(), carrying BRIDGE v1 messages exactly as the WebView sends them
 *    (native/docs/ENGINE_CONTRACT.md section 6, native/contract/engine-api.json `messages`). Replies and events come
 *    back as JSON through the event callback.
 *  - Typed fast paths for what must not go through JSON: the audio render callback (rig_render), raw MIDI input with
 *    host timestamps (rig_midi_in), a lock-free meter snapshot (rig_get_meters) and the engine clock.
 *  - Host services: the core never opens audio devices or MIDI ports itself. It asks the platform layer through the
 *    rig_host vtable (start/stop output, list devices, send MIDI) and the platform layer reports back with the
 *    rig_host_* notification functions.
 *  - Offline mode (RIG_MODE_OFFLINE): no threads at all. Every rig_post() executes synchronously (decodes and IR
 *    builds included) and rig_offline_render() advances time, running engine timers on 128-frame quanta exactly like
 *    an OfflineAudioContext. This is what the golden parity tests use.
 *
 * Threading summary (see each function):
 *  - [any]      callable from any thread, never blocks for long (may take a short mutex; NOT real-time safe).
 *  - [rt]       real-time safe: no allocation, no locks, no syscalls. Intended for the audio / MIDI threads.
 *  - [control]  must not be called concurrently with itself or rig_destroy(); usually the shell's main thread.
 *
 * Strings are UTF-8. JSON passed in is not retained after the call returns. Pointers returned by the core stay valid
 * as documented per function. All times called "engine time" are seconds = frames rendered / sample rate since
 * rig_create() (monotonic, keeps running across device restarts, pauses while the engine sleeps; contract 6.3).
 *
 * Status: header frozen for wave 0 of native/docs/BUILD_PLAN.md. Additive changes only (new functions, new fields at
 * the END of structs guarded by struct_size); a breaking change bumps RIG_API_VERSION_MAJOR.
 */
#ifndef RIG_ENGINE_H
#define RIG_ENGINE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32) && defined(RIG_BUILD_SHARED)
#  define RIG_API __declspec(dllexport)
#elif defined(_WIN32) && defined(RIG_USE_SHARED)
#  define RIG_API __declspec(dllimport)
#elif defined(__GNUC__) || defined(__clang__)
#  define RIG_API __attribute__((visibility("default")))
#else
#  define RIG_API
#endif

/** C API version (independent of the bridge protocol version, which is BRIDGE v1). */
#define RIG_API_VERSION_MAJOR 1
#define RIG_API_VERSION_MINOR 0

/** The bridge protocol this core speaks (`v` of every JSON message; contract 6.2). */
#define RIG_BRIDGE_PROTOCOL 1

/** Internal render quantum in frames. Timers, k-rate parameters and the offline renderer step on this grid. */
#define RIG_QUANTUM_FRAMES 128

/** Maximum output channels the core renders (1-2 music, 3-4 aux click; contract 3.10). */
#define RIG_MAX_OUTPUT_CHANNELS 4

/** Opaque engine handle. One per process is the normal case; several are allowed (tests render in parallel). */
typedef struct rig_engine rig_engine;

/** Return codes. Negative = error. */
typedef enum rig_status {
  RIG_OK = 0,
  RIG_E_INVALID = -1,      /**< bad argument, malformed JSON envelope, wrong struct_size */
  RIG_E_STATE = -2,        /**< call not valid in this mode/state (e.g. rig_offline_render on a realtime engine) */
  RIG_E_NOMEM = -3,        /**< allocation failed (never returned by [rt] functions: they drop instead) */
  RIG_E_UNSUPPORTED = -4,  /**< capability missing (e.g. test hooks compiled out, 4-ch request on a 2-ch device) */
  RIG_E_FULL = -5,         /**< a bounded queue is full; the message was dropped (counted in stats) */
  RIG_E_IO = -6,           /**< file or path error (manifests, app_dir) */
  RIG_E_PROTOCOL = -7      /**< JSON message with another major `v` (also reported as a reply/warn) */
} rig_status;

/** Human-readable name of a status ("ok", "invalid", ...). Static storage. [any] */
RIG_API const char *rig_status_string(rig_status s);

/** RIG_API_VERSION_MAJOR << 16 | RIG_API_VERSION_MINOR of the linked library. [any] */
RIG_API uint32_t rig_api_version(void);

/** "worship-rig-core <semver> (<git>)", the `engine` field of the hello reply. Static storage. [any] */
RIG_API const char *rig_version_string(void);

/* -------------------------------------------------------------------------------------------------------------- */
/* Configuration                                                                                                    */
/* -------------------------------------------------------------------------------------------------------------- */

typedef enum rig_mode {
  RIG_MODE_REALTIME = 0, /**< control thread + worker threads; the platform layer calls rig_render() */
  RIG_MODE_OFFLINE = 1   /**< no threads; rig_post() is synchronous; rig_offline_render() drives time */
} rig_mode;

/** Resource profile (ARCHITECTURE.md "iPad profile"). Overridable per field in the config. */
typedef enum rig_profile {
  RIG_PROFILE_DESKTOP = 0, /**< cache 700 MB float32, 10 reverb units, neighbour preload as the JS engine */
  RIG_PROFILE_IPAD = 1     /**< cache 320 MB int16, 4 reverb units, current +-1 pins, warm-ups only when idle */
} rig_profile;

/** How decoded sample data is stored in the cache. */
typedef enum rig_sample_storage {
  RIG_SAMPLES_DEFAULT = 0, /**< profile decides */
  RIG_SAMPLES_F32 = 1,     /**< float32: Chromium parity (goldens) */
  RIG_SAMPLES_I16 = 2      /**< int16 + per-buffer scale: half the memory; goldens at statistical tolerance */
} rig_sample_storage;

/** Constructor switches that mirror the JS engine's options (contract 1.1 constructor). */
enum {
  RIG_FLAG_NO_LOFI = 1u << 0,             /**< `lofi: false` (tools/tests) */
  RIG_FLAG_NO_GLUE = 1u << 1,             /**< `glue: false` */
  RIG_FLAG_NO_INSTRUMENT_MODULES = 1u << 2, /**< `instrumentModules: false` (fallback synth only) */
  RIG_FLAG_CLIP_OVERSAMPLE_2X = 1u << 3,  /**< `clipOversample: '2x'` */
  RIG_FLAG_CLIP_OVERSAMPLE_4X = 1u << 4,  /**< `clipOversample: '4x'` */
  RIG_FLAG_TEST_API = 1u << 8,            /**< enable rig_test_* hooks (offline mode only) */
  RIG_FLAG_NO_DIRECT_MIDI = 1u << 9       /**< ignore `midi route` (every MIDI message goes to JS) */
};

/**
 * Event / reply sink. `json` is a UTF-8 JSON value that is either one message object or an array of messages in
 * delivery order (BRIDGE v1 envelope: `{v, ev, ...}` events and `{v, re, ok, result|error}` replies). The buffer is
 * valid only during the call. Realtime mode: called on the engine's control thread, batched per control-loop turn
 * (at most every 4 ms, plus immediately for replies); the shell hops to its main thread and hands the string to
 * `window.__rigNative.receive(...)` unchanged. Offline mode: called synchronously from inside rig_post() /
 * rig_offline_render(). Must not call rig_destroy(); may call rig_post().
 */
typedef void (*rig_event_fn)(void *user, const char *json, size_t len);

/** Log sink (warnings and diagnostics that are not bridge `warn` events). level: 0 debug, 1 info, 2 warn, 3 error. */
typedef void (*rig_log_fn)(void *user, int level, const char *msg);

/** PCM handed to the core by a host decoder (non-interleaved float32 at the file's own rate). */
typedef struct rig_decoded_audio {
  uint32_t struct_size;
  double sample_rate;
  uint32_t channels;   /**< 1 or 2 (more: the core keeps the first two) */
  uint64_t frames;
  float **data;        /**< data[ch][frame]; owned by the host until free_decoded is called */
  void *host_cookie;   /**< opaque, passed back to free_decoded */
} rig_decoded_audio;

/**
 * Platform services. Every member may be NULL (then the matching op replies `unsupported`). Called on the control
 * thread (realtime) or inline (offline) unless noted; implementations must not block for long and must not call
 * rig_destroy(). Results that take time are reported later with the rig_host_* functions.
 */
typedef struct rig_host {
  uint32_t struct_size;
  void *user;

  /**
   * Open or reopen the output device and start calling rig_render(). `device_id` NULL/"" = system default.
   * `latency_sec` 0 = "interactive" (smallest stable buffer), else the requested buffer duration. `channels` is 2,
   * or 4 when the aux click output is requested (the host may open fewer; it reports what it got). Completion:
   * rig_host_audio_started() or rig_host_audio_state(... RIG_DEVICE_CLOSED, "error text").
   */
  void (*audio_start)(void *user, const char *device_id, double latency_sec, uint32_t channels);
  /** Stop calling rig_render() (sleep, shutdown). Completion: rig_host_audio_state(RIG_DEVICE_SUSPENDED). */
  void (*audio_stop)(void *user);
  /**
   * Write the output device list as a JSON array `[{id, name, channels, default, sampleRates:[..]}]` (contract 6.4
   * `get devices`) into buf (cap bytes, NUL-terminated). Return the length needed (excluding NUL).
   */
  size_t (*audio_list_devices)(void *user, char *buf, size_t cap);

  /** Start/stop delivering input from these MIDI source ids (JSON array of strings; `midi listen`). */
  void (*midi_listen)(void *user, const char *ids_json);
  /**
   * Send MIDI bytes to an output port (MIDI clock out, `midi send`). `host_time_ns` 0 = now. Called from the
   * control thread; the core computes host times from engine times with the render timestamps, so clock pulses are
   * scheduled ahead (CoreMIDI MIDISend with a timestamp; contract 3.10).
   */
  void (*midi_send)(void *user, const char *port_id, const uint8_t *bytes, size_t len, uint64_t host_time_ns);

  /**
   * Decode an audio file the core cannot decode itself (AAC/M4A, ALAC; contract 4 "Samples"). Return 0 on success.
   * Called on a worker thread (realtime) or inline (offline); must be thread-safe. NULL = such files fail with a
   * `decode` warning.
   */
  int (*decode_file)(void *user, const char *path, rig_decoded_audio *out);
  void (*free_decoded)(void *user, rig_decoded_audio *audio);

  /** Current host clock in ns, same timebase as rig_render()/rig_midi_in() timestamps (mach_absolute_time in ns). */
  uint64_t (*host_time_ns)(void *user);
} rig_host;

/** Engine configuration. Initialise with rig_config_init() and then override fields. */
typedef struct rig_config {
  uint32_t struct_size;        /**< = sizeof(rig_config); lets older callers link against newer cores */
  rig_mode mode;
  rig_profile profile;
  uint32_t flags;              /**< RIG_FLAG_* */

  double sample_rate;          /**< initial rate; realtime engines adopt the device rate on rig_host_audio_started */
  uint32_t max_block_frames;   /**< largest `frames` passed to rig_render (preallocation); default 4096 */
  uint32_t output_channels;    /**< 2 (default) or 4; changes later with the device */

  uint32_t seed;               /**< engine seed (contract 0 Determinism); 0 = derive from time (realtime only) */
  const char *seed_string;     /**< if non-NULL, seed = hashSeed(seed_string) (FNV-1a, as `new AudioEngine({seed})`) */

  const char *app_dir;         /**< path of app/ (reads samples/manifest.json, js/engine/gain-trims.json) */
  const char *user_manifest;   /**< merged My Samples manifest (JSON file path) or NULL */
  const char *pads_dir;        /**< pad folder for drone files; NULL = none */
  const char *recordings_dir;  /**< default `rec` directory; NULL = no default */

  uint32_t cache_mb;           /**< decoded-sample cache cap; 0 = profile default (700 desktop, 320 iPad) */
  rig_sample_storage sample_storage;
  uint32_t reverb_units_max;   /**< 0 = profile default (10 desktop, 4 iPad) */
  uint32_t decode_threads;     /**< 0 = auto (min(2, cores-1) desktop, 1 iPad); ignored offline */

  rig_event_fn on_event;
  void *event_user;
  rig_log_fn on_log;
  void *log_user;
  const rig_host *host;        /**< copied at create; NULL in offline tools */
} rig_config;

/** Fill defaults (realtime, desktop, 48000 Hz, 2 ch, 4096 max block). [any] */
RIG_API void rig_config_init(rig_config *cfg);

/* -------------------------------------------------------------------------------------------------------------- */
/* Lifecycle                                                                                                        */
/* -------------------------------------------------------------------------------------------------------------- */

/**
 * Create an engine. Loads the instrument registry (manifests, gain trims) synchronously, allocates every real-time
 * pool, starts the control and worker threads (realtime). Produces no audio until the bridge `audio start` (or, in
 * offline mode, until rendering). Returns NULL on failure with *err set (err may be NULL). [control]
 */
RIG_API rig_engine *rig_create(const rig_config *cfg, rig_status *err);

/**
 * Destroy. The platform layer must have stopped calling rig_render() / rig_midi_in() first (audio_stop completed).
 * Joins threads, finalises an open recording (valid WAV), frees everything. NULL is a no-op. [control]
 */
RIG_API void rig_destroy(rig_engine *e);

/* -------------------------------------------------------------------------------------------------------------- */
/* Bridge v1: JSON command entry point                                                                              */
/* -------------------------------------------------------------------------------------------------------------- */

/**
 * Submit one BRIDGE v1 message (`{v:1, op, id?, ...}`) or a JSON array of them, exactly as posted by the WebView.
 * Messages are processed strictly FIFO on the control queue (contract 6.1); async work (decode, IR build, device
 * open) starts in order and completes later. Replies/events go to cfg.on_event.
 *
 * Returns RIG_OK when queued (realtime) or executed (offline); RIG_E_INVALID when `json` is not a JSON object/array
 * (no reply can be produced); RIG_E_FULL when the control queue is full (16384 messages). Schema errors inside a
 * well-formed message are NOT return codes: they produce `{ok:false, error:{code:'bad-request'}}` replies or `warn`
 * events, like the JS engine. [any]
 */
RIG_API rig_status rig_post(rig_engine *e, const char *json, size_t len);

/* -------------------------------------------------------------------------------------------------------------- */
/* Audio fast path (platform audio layer)                                                                           */
/* -------------------------------------------------------------------------------------------------------------- */

/**
 * Render `frames` frames into non-interleaved float buffers out[0..channels-1]. Called from the device's real-time
 * IO thread (AUHAL/RemoteIO render callback, WASAPI event thread). `host_time_ns` is the host time at which the first
 * frame reaches the output (AudioTimeStamp.mHostTime + output latency, in ns); 0 if unknown. Any `frames` up to
 * cfg.max_block_frames works: the core renders 128-frame quanta through an internal FIFO, which adds latency only
 * when `frames` is not a multiple of 128. Channels 3-4 carry the aux click when configured, else silence; channels
 * beyond the configured count are zeroed. Writes silence when the engine is asleep/not started.
 * Realtime mode only (RIG_E_STATE otherwise; buffers are then zeroed). [rt]
 */
RIG_API rig_status rig_render(rig_engine *e, float *const *out, uint32_t channels, uint32_t frames,
                              uint64_t host_time_ns);

/** Device status as reported by the platform layer (maps to the bridge `state` event, contract 6.5). */
typedef enum rig_device_state {
  RIG_DEVICE_RUNNING = 0,
  RIG_DEVICE_SUSPENDED = 1,   /**< stopped on purpose (sleep) or not yet started */
  RIG_DEVICE_INTERRUPTED = 2, /**< iPad session interruption (call, Siri), macOS device vanished */
  RIG_DEVICE_CLOSED = 3       /**< failed to open / fatal */
} rig_device_state;

/** What the platform layer actually opened. */
typedef struct rig_device_info {
  uint32_t struct_size;
  const char *device_id;      /**< stable id (macOS AudioDevice UID, iPad port UID); copied */
  const char *device_name;    /**< copied */
  double sample_rate;
  uint32_t channels;          /**< opened output channels (2 or 4) */
  uint32_t buffer_frames;     /**< nominal frames per rig_render call */
  double output_latency_sec;  /**< device + safety-offset + stream latency (contract latencyMs = base + output) */
} rig_device_info;

/**
 * The device is open and rig_render() calls are about to start (or a route change re-opened it). A sample-rate
 * change is handled here: engine time continues from its current value (contract 6.3); rate-dependent DSP (IRs,
 * wavetables, filters, resampling ratios) is rebuilt off the audio thread and swapped in. Emits `state`
 * (`restarted:true` on a re-open). [any]
 */
RIG_API void rig_host_audio_started(rig_engine *e, const rig_device_info *info);

/** Device state change not covered by audio_started (stopped, interrupted, failed). `message` may be NULL. [any] */
RIG_API void rig_host_audio_state(rig_engine *e, rig_device_state state, const char *message);

/** The device list changed (hot-plug); the core emits a `state` event so JS re-queries `get devices`. [any] */
RIG_API void rig_host_devices_changed(rig_engine *e);

/* -------------------------------------------------------------------------------------------------------------- */
/* MIDI fast path (platform MIDI layer)                                                                             */
/* -------------------------------------------------------------------------------------------------------------- */

/**
 * Raw MIDI 1.0 bytes from source `port_id` (the platform's stable id, e.g. the CoreMIDI uniqueID as a decimal
 * string, interned at rig_host_midi_ports), received at `host_time_ns` (0 = now). Any number of complete or partial
 * messages; running status and SysEx framing are handled by the core parser (port of midi.js `_parseBytes`).
 * Called from the CoreMIDI receive thread. Parsed messages are forwarded to JS as `midi {type:'msg'}` events and, when
 * the direct path (`midi route`) is on, notes/pedal/wheels/bend are played without the JS round trip, stamped at
 * host time + one block when `jitterFree`. Lock-free; drops (counted) when the 4096-entry queue is full. [rt]
 */
RIG_API rig_status rig_midi_in(rig_engine *e, const char *port_id, const uint8_t *bytes, size_t len,
                               uint64_t host_time_ns);

/**
 * Current MIDI ports as a JSON array `[{id, name, manufacturer, state:'connected'|'disconnected',
 * kind:'input'|'output'}]` (contract 6.5 `midi {type:'ports'}`). Call at start and on every hot-plug change; the
 * core diffs, releases notes of a vanished input (as midi.js `disconnected`) and emits the `midi` ports event. [any]
 */
RIG_API rig_status rig_host_midi_ports(rig_engine *e, const char *ports_json, size_t len);

/* -------------------------------------------------------------------------------------------------------------- */
/* Clock and meters                                                                                                 */
/* -------------------------------------------------------------------------------------------------------------- */

/** Engine time (s) of the last rendered frame. Lock-free read. [rt] */
RIG_API double rig_engine_time(const rig_engine *e);

/** Lock-free meter snapshot (seqlock; the same values the `tick` event carries; contract 6.5). */
typedef struct rig_meters {
  uint32_t struct_size;
  double t;                 /**< engine time of the snapshot */
  uint64_t frames;          /**< total frames rendered */
  float out_peak[2];        /**< peak |x| of `out` L/R since the previous snapshot (never misses a peak; Q14) */
  float slot_peak[4];       /**< per-slot post-pan peak (mono down-mix) over the last 256 frames */
  float slot_rms[4];        /**< per-slot rms over the last 256 frames */
  float cpu_load;           /**< render time / buffer duration, smoothed 0..1+ */
  uint32_t xruns;           /**< render calls that overran or were missed (host-reported or measured) */
  uint32_t voices;          /**< live voices incl. retiring channels */
  uint8_t pedal;            /**< effective sustain */
  uint8_t sleep_state;      /**< 0 awake, 1 sleeping, 2 asleep, 3 waking */
  uint16_t held;            /**< held physical notes */
} rig_meters;

/** Copy the latest snapshot (taken once per 128-frame quantum). Never blocks; retries on a torn read. [rt] */
RIG_API rig_status rig_get_meters(const rig_engine *e, rig_meters *out);

/* -------------------------------------------------------------------------------------------------------------- */
/* Offline rendering (golden parity, calibration, audition)                                                         */
/* -------------------------------------------------------------------------------------------------------------- */

/**
 * Advance an offline engine by `frames` frames (any count) into non-interleaved buffers. Between 128-frame quanta it
 * runs the engine timers whose quantum has come (k = ceil(t*sr/128 - 1e-6), contract 0/Q17), then renders. All
 * messages posted before the call with `when` inside the range take effect sample-accurately. Deterministic: the
 * same config + message sequence gives bit-identical output on the same build. RIG_MODE_OFFLINE only. [control]
 */
RIG_API rig_status rig_offline_render(rig_engine *e, float *const *out, uint32_t channels, uint32_t frames);

/**
 * Block until all pending asynchronous work of an offline engine is done. In offline mode decodes and IR builds run
 * inline, so this only flushes deferred timer-driven work up to the current time; kept for API symmetry and for a
 * possible threaded offline mode later. [control]
 */
RIG_API rig_status rig_offline_settle(rig_engine *e);

/* -------------------------------------------------------------------------------------------------------------- */
/* Test hooks (RIG_FLAG_TEST_API + RIG_MODE_OFFLINE; RIG_E_UNSUPPORTED otherwise)                                  */
/* -------------------------------------------------------------------------------------------------------------- */

/**
 * Record node `node` instead of the master output (golden TAP table, tools/golden/page.js): "out", "fx.sum",
 * "fx.reverb.output", "fx.delay.output", "fx.chorus.output", "fx.lofi.output", "fx.eqOut", "fx.master",
 * "slot0.pan", "slot1.pan". Applies to subsequent rig_offline_render output (always 2 channels of the tap).
 */
RIG_API rig_status rig_test_tap(rig_engine *e, const char *node);

/**
 * Inject a stimulus at node `node` (golden INJECT table: "fx.sum", "fx.reverb.input", "fx.delay.input",
 * "fx.chorus.input", "fx.eqIn", "fx.preComp", "slot0.strip") starting at engine time `start_sec`, scaled by
 * `gain`. data[ch][frame], channels 1 or 2; the core copies it.
 */
RIG_API rig_status rig_test_inject(rig_engine *e, const char *node, const float *const *data, uint32_t channels,
                                   uint64_t frames, double start_sec, float gain);

/**
 * Debug/state query as JSON (the JS test-only hooks: "getParam:<path>", "getState", "heldChord", "activeNotes",
 * "quietFor", "slotTapCount", "stats"). Writes NUL-terminated JSON into buf; returns the length needed.
 */
RIG_API size_t rig_test_query(rig_engine *e, const char *what, char *buf, size_t cap);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* RIG_ENGINE_H */
