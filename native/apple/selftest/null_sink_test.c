/*
 * The one part of the Mac app's --self-test (E4) that can run off a Mac: rig_apple_null_sink driving a REALTIME core
 * through the same rig_host path the app uses (audio_start_frames / audio_stop on the core's device thread).
 *
 *   bash native/apple/selftest/run-null-sink-test.sh [<core build dir with librig_core.a>]
 *
 * Checks: hello reply (protocol 1, minor >= 5); `audio start` reaches the host and the sink reports `running`;
 * frames advance at about the wall-clock rate; `audio restart` (audio_stop then audio_start_frames on the device
 * thread) keeps frames advancing; a stopped sink renders nothing more; rig_destroy returns after the sink is gone.
 * Exit 0 = pass. Prints one line per check.
 */
#include "rig_apple_null_sink.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static char *events = NULL; /* every event batch, newline-separated */
static size_t events_len = 0;
static rig_engine *g_engine = NULL;
static pthread_mutex_t sink_mu = PTHREAD_MUTEX_INITIALIZER; /* g_sink: the device thread and main both touch it */
static rig_apple_null_sink *g_sink = NULL;
static int starts = 0, stops = 0;
static uint32_t last_frames_req = 0;
static int failures = 0;

static void on_event(void *user, const char *json, size_t len) {
  (void)user;
  pthread_mutex_lock(&mu);
  char *n = (char *)realloc(events, events_len + len + 2);
  if (n) {
    events = n;
    memcpy(events + events_len, json, len);
    events_len += len;
    events[events_len++] = '\n';
    events[events_len] = 0;
  }
  pthread_mutex_unlock(&mu);
}

static int events_contain(const char *needle) {
  pthread_mutex_lock(&mu);
  const int hit = events && strstr(events, needle) != NULL;
  pthread_mutex_unlock(&mu);
  return hit;
}

/* rig_host, as RigHost.swift wires it in self-test mode */
static void h_start_frames(void *user, const char *dev, double lat, uint32_t ch, uint32_t frames) {
  (void)user; (void)dev; (void)lat;
  pthread_mutex_lock(&mu);
  starts++;
  last_frames_req = frames;
  pthread_mutex_unlock(&mu);
  pthread_mutex_lock(&sink_mu);
  if (g_sink) rig_apple_null_sink_stop(g_sink, 0);
  g_sink = rig_apple_null_sink_start(g_engine, 48000.0, ch, frames);
  pthread_mutex_unlock(&sink_mu);
}
static void h_start(void *user, const char *dev, double lat, uint32_t ch) { h_start_frames(user, dev, lat, ch, 0); }
static void h_stop(void *user) {
  (void)user;
  pthread_mutex_lock(&mu);
  stops++;
  pthread_mutex_unlock(&mu);
  pthread_mutex_lock(&sink_mu);
  rig_apple_null_sink *s = g_sink;
  g_sink = NULL;
  pthread_mutex_unlock(&sink_mu);
  rig_apple_null_sink_stop(s, 1);
}

static rig_apple_null_sink *sink(void) {
  pthread_mutex_lock(&sink_mu);
  rig_apple_null_sink *s = g_sink;
  pthread_mutex_unlock(&sink_mu);
  return s;
}

static void sleep_ms(int ms) {
  struct timespec ts = {ms / 1000, (long)(ms % 1000) * 1000000L};
  nanosleep(&ts, NULL);
}

static void check(int ok, const char *name, const char *fmt, double a, double b) {
  printf("%s %-22s ", ok ? "ok  " : "FAIL", name);
  printf(fmt, a, b);
  printf("\n");
  if (!ok) failures++;
}

static int wait_for(const char *needle, int ms) {
  for (int i = 0; i < ms / 10; i++) {
    if (events_contain(needle)) return 1;
    sleep_ms(10);
  }
  return events_contain(needle);
}

static void post(const char *json) {
  const rig_status s = rig_post(g_engine, json, strlen(json));
  if (s != RIG_OK) printf("rig_post(%s) = %s\n", json, rig_status_string(s));
}

int main(int argc, char **argv) {
  const char *app = argc > 1 ? argv[1] : "app";
  rig_config cfg;
  rig_config_init(&cfg);
  cfg.struct_size = (uint32_t)sizeof cfg;
  cfg.mode = RIG_MODE_REALTIME;
  cfg.profile = RIG_PROFILE_DESKTOP;
  cfg.app_dir = app;
  cfg.on_event = on_event;
  rig_host host;
  memset(&host, 0, sizeof host);
  host.struct_size = (uint32_t)sizeof host;
  host.audio_start = h_start;
  host.audio_start_frames = h_start_frames;
  host.audio_stop = h_stop;
  cfg.host = &host;
  rig_status st = RIG_OK;
  g_engine = rig_create(&cfg, &st);
  check(g_engine != NULL, "rig_create realtime", "status %.0f%.0s", (double)st, 0);
  if (!g_engine) return 1;

  post("{\"v\":1,\"op\":\"hello\",\"id\":1,\"protocol\":1,\"app\":\"null-sink-test\",\"caps\":[]}");
  const int hello = wait_for("\"re\":1", 2000);
  check(hello && events_contain("\"protocol\":1") && events_contain("\"minor\":5"), "hello reply", "%.0f%.0s",
        hello, 0);

  post("{\"v\":1,\"op\":\"audio\",\"id\":2,\"action\":\"start\",\"bufferFrames\":128}");
  const int running = wait_for("\"state\":\"running\"", 3000);
  check(running, "state running", "%.0f%.0s", running, 0);
  check(starts == 1 && last_frames_req == 128, "audio_start_frames", "starts %.0f, frames %.0f", starts,
        last_frames_req);
  check(events_contain("\"deviceId\":\"selftest-null\""), "deviceId reported", "%.0f%.0s",
        events_contain("\"deviceId\":\"selftest-null\""), 0);

  const uint64_t f0 = rig_apple_null_sink_frames(sink());
  sleep_ms(500);
  const uint64_t f1 = rig_apple_null_sink_frames(sink());
  const double got = (double)(f1 - f0);
  /* 0.5 s at 48 kHz = 24000; a busy 2-CPU box may be late, never early by more than a block */
  check(got > 12000 && got <= 24000 + 2 * 128, "frames advance", "%.0f frames in 0.5 s (late blocks %.0f)", got,
        (double)rig_apple_null_sink_late(sink()));
  check(rig_apple_null_sink_errors(sink()) == 0, "render errors", "%.0f%.0s",
        (double)rig_apple_null_sink_errors(sink()), 0);
  check(rig_engine_time(g_engine) > 0.2, "engine time", "%.3f s%.0s", rig_engine_time(g_engine), 0);

  /* a test voice, if the core has one: the sink must see signal. The core's `play` needs a committed song, so this
   * only reports the peak and does not fail (the app self-test plays through the page's committed song). */
  rig_apple_null_sink_peak(sink(), 1);
  sleep_ms(100);
  printf("info peak after start      %.6f (no song committed: 0 is expected)\n",
         (double)rig_apple_null_sink_peak(sink(), 0));

  /* restart: the core calls audio_stop then audio_start_frames on its device thread */
  post("{\"v\":1,\"op\":\"audio\",\"id\":3,\"action\":\"restart\",\"bufferFrames\":256}");
  const int re3 = wait_for("\"re\":3", 3000);
  sleep_ms(300);
  pthread_mutex_lock(&mu);
  const int s2 = starts, t2 = stops;
  const uint32_t fr2 = last_frames_req;
  pthread_mutex_unlock(&mu);
  check(re3 && s2 == 2 && t2 == 1 && fr2 == 256, "restart", "starts %.0f, stops %.0f", s2, t2);
  const uint64_t g0 = rig_apple_null_sink_frames(sink());
  sleep_ms(300);
  const uint64_t g1 = rig_apple_null_sink_frames(sink());
  check(g1 > g0, "frames after restart", "%.0f frames in 0.3 s%.0s", (double)(g1 - g0), 0);

  /* shutdown as the self-test does it: stop the sink (no more rig_render), then destroy */
  pthread_mutex_lock(&sink_mu);
  rig_apple_null_sink *s = g_sink;
  g_sink = NULL;
  pthread_mutex_unlock(&sink_mu);
  rig_apple_null_sink_stop(s, 1);
  const double t_before = rig_engine_time(g_engine);
  sleep_ms(100);
  check(rig_engine_time(g_engine) == t_before, "stopped sink is silent", "t %.6f%.0s", t_before, 0);
  struct timespec a, b;
  clock_gettime(CLOCK_MONOTONIC, &a);
  rig_destroy(g_engine);
  clock_gettime(CLOCK_MONOTONIC, &b);
  const double ms = (double)(b.tv_sec - a.tv_sec) * 1e3 + (double)(b.tv_nsec - a.tv_nsec) / 1e6;
  check(ms < 5000, "rig_destroy", "%.1f ms%.0s", ms, 0);
  free(events);
  printf("%s (%d failed)\n", failures ? "FAIL" : "PASS", failures);
  return failures ? 1 : 0;
}
