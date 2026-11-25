/* See rig_apple_null_sink.h. Self-test only (E4); built into both Apple targets and tested on Linux. */
#include "rig_apple_null_sink.h"

#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

struct rig_apple_null_sink {
  rig_engine *engine;
  double sample_rate;
  uint32_t channels;
  uint32_t block;
  float *buf;  /* channels x block, one plane per channel */
  pthread_t thread;
  atomic_int stop;
  atomic_uint_fast64_t frames;
  atomic_uint_fast64_t errors;
  atomic_uint_fast64_t late;
  atomic_uint peak_bits; /* bits of a non-negative float: integer order = float order */
};

static uint64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts); /* macOS 10.12+, Linux */
  return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static void sleep_ns(uint64_t ns) {
  struct timespec ts = {(time_t)(ns / 1000000000ull), (long)(ns % 1000000000ull)};
  while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
  }
}

static uint32_t float_bits(float f) {
  uint32_t u;
  memcpy(&u, &f, sizeof u);
  return u;
}

static float bits_float(uint32_t u) {
  float f;
  memcpy(&f, &u, sizeof f);
  return f;
}

static void note_peak(rig_apple_null_sink *s, float p) {
  if (!(p > 0.0f)) return; /* also drops NaN */
  const uint32_t want = float_bits(p);
  unsigned cur = atomic_load_explicit(&s->peak_bits, memory_order_relaxed);
  while (want > cur &&
         !atomic_compare_exchange_weak_explicit(&s->peak_bits, &cur, want, memory_order_relaxed,
                                                memory_order_relaxed)) {
  }
}

static void *run(void *arg) {
  rig_apple_null_sink *s = (rig_apple_null_sink *)arg;
  float *planes[RIG_MAX_OUTPUT_CHANNELS] = {0};
  for (uint32_t c = 0; c < s->channels; c++) planes[c] = s->buf + (size_t)c * s->block;
  const uint64_t period = (uint64_t)((double)s->block * 1e9 / s->sample_rate);
  uint64_t next = now_ns();
  while (!atomic_load_explicit(&s->stop, memory_order_acquire)) {
    /* host_time_ns 0 = unknown (rig_render contract): nothing reaches a speaker */
    if (rig_render(s->engine, planes, s->channels, s->block, 0) == RIG_OK) {
      float p = 0.0f;
      for (size_t i = 0, n = (size_t)s->channels * s->block; i < n; i++) {
        const float a = fabsf(s->buf[i]);
        if (a > p) p = a;
      }
      note_peak(s, p);
      atomic_fetch_add_explicit(&s->frames, s->block, memory_order_release);
    } else {
      atomic_fetch_add_explicit(&s->errors, 1, memory_order_relaxed);
    }
    /* pace like a device: one block per block duration, no catch-up burst after a stall */
    next += period;
    const uint64_t t = now_ns();
    if (t < next) {
      sleep_ns(next - t);
    } else if (t - next > period) {
      atomic_fetch_add_explicit(&s->late, 1, memory_order_relaxed);
      next = t;
    }
  }
  return NULL;
}

rig_apple_null_sink *rig_apple_null_sink_start(rig_engine *engine, double sample_rate, uint32_t channels,
                                               uint32_t block_frames) {
  if (!engine) return NULL;
  if (!(sample_rate >= 8000.0 && sample_rate <= 384000.0)) sample_rate = 48000.0;
  if (channels < 1) channels = 2;
  if (channels > 2) channels = 2; /* a stereo stand-in: no aux click outputs (contract 3.10 reports 2) */
  if (block_frames == 0) block_frames = RIG_BUFFER_FRAMES_DEFAULT;
  if (block_frames < 16) block_frames = 16;
  if (block_frames > 4096) block_frames = 4096;

  rig_apple_null_sink *s = (rig_apple_null_sink *)calloc(1, sizeof *s);
  float *buf = (float *)calloc((size_t)channels * block_frames, sizeof(float));
  if (!s || !buf) {
    free(s);
    free(buf);
    rig_host_audio_state(engine, RIG_DEVICE_CLOSED, "self-test null output: out of memory");
    return NULL;
  }
  s->engine = engine;
  s->sample_rate = sample_rate;
  s->channels = channels;
  s->block = block_frames;
  s->buf = buf;
  atomic_init(&s->stop, 0);
  atomic_init(&s->frames, 0);
  atomic_init(&s->errors, 0);
  atomic_init(&s->late, 0);
  atomic_init(&s->peak_bits, 0u);

  /* before the first rig_render, as the dev host does: the core adopts the rate (contract 6.3) */
  rig_device_info info;
  memset(&info, 0, sizeof info);
  info.struct_size = (uint32_t)sizeof info;
  info.device_id = "selftest-null";
  info.device_name = "Self-test null output";
  info.sample_rate = sample_rate;
  info.channels = channels;
  info.buffer_frames = block_frames;
  info.output_latency_sec = (double)block_frames / sample_rate;
  rig_host_audio_started(engine, &info);

  if (pthread_create(&s->thread, NULL, run, s) != 0) {
    rig_host_audio_state(engine, RIG_DEVICE_CLOSED, "self-test null output: cannot start its thread");
    free(buf);
    free(s);
    return NULL;
  }
  return s;
}

void rig_apple_null_sink_stop(rig_apple_null_sink *s, int report) {
  if (!s) return;
  atomic_store_explicit(&s->stop, 1, memory_order_release);
  pthread_join(s->thread, NULL);
  if (report) rig_host_audio_state(s->engine, RIG_DEVICE_SUSPENDED, NULL);
  free(s->buf);
  free(s);
}

uint64_t rig_apple_null_sink_frames(rig_apple_null_sink *s) {
  return s ? (uint64_t)atomic_load_explicit(&s->frames, memory_order_acquire) : 0;
}

uint64_t rig_apple_null_sink_errors(rig_apple_null_sink *s) {
  return s ? (uint64_t)atomic_load_explicit(&s->errors, memory_order_relaxed) : 0;
}

uint64_t rig_apple_null_sink_late(rig_apple_null_sink *s) {
  return s ? (uint64_t)atomic_load_explicit(&s->late, memory_order_relaxed) : 0;
}

float rig_apple_null_sink_peak(rig_apple_null_sink *s, int reset) {
  if (!s) return 0.0f;
  const unsigned u = reset ? atomic_exchange_explicit(&s->peak_bits, 0u, memory_order_relaxed)
                           : atomic_load_explicit(&s->peak_bits, memory_order_relaxed);
  return bits_float((uint32_t)u);
}
