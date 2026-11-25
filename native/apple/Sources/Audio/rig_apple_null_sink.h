/*
 * rig_apple_null_sink: a stand-in output device with no hardware behind it, for the app's `--self-test` launch mode
 * (native/docs/MAC_CHECK.md "Self-test"). The CI macOS runner has no audio device, so the self-test cannot open AUHAL;
 * this plays the device's part: a plain pthread calls rig_render() every `block_frames` frames, paced to the wall
 * clock at `sample_rate`, and throws the audio away after measuring it (frames rendered, peak |x|).
 *
 * Plain C + pthreads (no CoreAudio), so it compiles for both Apple targets and also on Linux, where
 * native/apple/selftest/null_sink_test.c runs it against the real core (the only part of the self-test that runs
 * off a Mac). It is never used by the normal app.
 *
 * Threading: start/stop are called from the core's device thread (rig_host.audio_start / audio_stop) or the shell's
 * main thread, never concurrently for the same sink. The counters are atomics, readable from any thread.
 */
#ifndef RIG_APPLE_NULL_SINK_H
#define RIG_APPLE_NULL_SINK_H

#include <stddef.h>
#include <stdint.h>
#include <rig/rig_engine.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct rig_apple_null_sink rig_apple_null_sink;

/**
 * Report the device to the core (rig_host_audio_started: id "selftest-null", `channels` 2, `block_frames`, latency
 * one block), then start the render thread. Returns NULL when the thread cannot be created; the core is then told
 * RIG_DEVICE_CLOSED. `block_frames` 0 = 128; clamped to 16..4096 (rig_config.max_block_frames default).
 */
rig_apple_null_sink *rig_apple_null_sink_start(rig_engine *engine, double sample_rate, uint32_t channels,
                                               uint32_t block_frames);

/**
 * Stop and join the render thread; after it returns no further rig_render() call happens. `report` != 0 also tells
 * the core RIG_DEVICE_SUSPENDED (the rig_host.audio_stop completion). Frees the sink. NULL is a no-op.
 */
void rig_apple_null_sink_stop(rig_apple_null_sink *s, int report);

/** Frames rendered so far (sum of the `frames` of every rig_render call that returned RIG_OK). */
uint64_t rig_apple_null_sink_frames(rig_apple_null_sink *s);

/** rig_render calls that did not return RIG_OK. */
uint64_t rig_apple_null_sink_errors(rig_apple_null_sink *s);

/** Blocks that started more than one block late (the thread was descheduled; the pacing then skips ahead). */
uint64_t rig_apple_null_sink_late(rig_apple_null_sink *s);

/** Largest |sample| on any channel since the last reset. `reset` != 0 zeroes it after reading. */
float rig_apple_null_sink_peak(rig_apple_null_sink *s, int reset);

#ifdef __cplusplus
}
#endif
#endif
