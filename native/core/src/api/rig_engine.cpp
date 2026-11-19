// C API (include/rig/rig_engine.h): thin wrappers over rig::Engine.
#include "rig/rig_engine.h"

#include <cstring>
#include <new>

#include "api/engine.h"

#ifndef RIG_GIT_DESCRIBE
#define RIG_GIT_DESCRIBE "nogit"
#endif

using rig::Engine;

static Engine *impl(rig_engine *e) {
  return reinterpret_cast<Engine *>(e);
}
static const Engine *impl(const rig_engine *e) {
  return reinterpret_cast<const Engine *>(e);
}

extern "C" {

const char *rig_status_string(rig_status s) {
  switch (s) {
    case RIG_OK:
      return "ok";
    case RIG_E_INVALID:
      return "invalid";
    case RIG_E_STATE:
      return "state";
    case RIG_E_NOMEM:
      return "nomem";
    case RIG_E_UNSUPPORTED:
      return "unsupported";
    case RIG_E_FULL:
      return "full";
    case RIG_E_IO:
      return "io";
    case RIG_E_PROTOCOL:
      return "protocol";
  }
  return "unknown";
}

uint32_t rig_api_version(void) {
  return (RIG_API_VERSION_MAJOR << 16) | RIG_API_VERSION_MINOR;
}

const char *rig_version_string(void) {
  return "worship-rig-core 0.1.0-skeleton (" RIG_GIT_DESCRIBE ")";
}

void rig_config_init(rig_config *cfg) {
  if (!cfg) return;
  std::memset(cfg, 0, sizeof(*cfg));
  cfg->struct_size = sizeof(rig_config);
  cfg->mode = RIG_MODE_REALTIME;
  cfg->profile = RIG_PROFILE_DESKTOP;
  cfg->sample_rate = 48000.0;
  cfg->max_block_frames = 4096;
  cfg->output_channels = 2;
}

rig_engine *rig_create(const rig_config *cfg, rig_status *err) {
  if (err) *err = RIG_E_INVALID;
  if (!cfg || cfg->struct_size < 4 * sizeof(uint32_t)) return nullptr;
  rig_config full;  // older callers pass a shorter struct: the tail keeps its defaults
  rig_config_init(&full);
  std::memcpy(&full, cfg, cfg->struct_size < sizeof(full) ? cfg->struct_size : sizeof(full));
  full.struct_size = sizeof(full);
  return reinterpret_cast<rig_engine *>(Engine::create(full, err));
}

void rig_destroy(rig_engine *e) {
  delete impl(e);
}

rig_status rig_post(rig_engine *e, const char *json, size_t len) {
  return e ? impl(e)->post(json, len) : RIG_E_INVALID;
}

rig_status rig_render(rig_engine *e, float *const *out, uint32_t channels, uint32_t frames, uint64_t host_time_ns) {
  return e ? impl(e)->render(out, channels, frames, host_time_ns) : RIG_E_INVALID;
}

void rig_host_audio_started(rig_engine *e, const rig_device_info *info) {
  if (e && info) impl(e)->hostAudioStarted(*info);
}

void rig_host_audio_state(rig_engine *e, rig_device_state state, const char *message) {
  if (e) impl(e)->hostAudioState(state, message);
}

void rig_host_devices_changed(rig_engine *e) {
  if (e) impl(e)->hostDevicesChanged();
}

rig_status rig_midi_in(rig_engine *e, const char *port_id, const uint8_t *bytes, size_t len, uint64_t host_time_ns) {
  return e ? impl(e)->midiIn(port_id, bytes, len, host_time_ns) : RIG_E_INVALID;
}

rig_status rig_host_midi_ports(rig_engine *e, const char *ports_json, size_t len) {
  if (!e || !ports_json) return RIG_E_INVALID;
  (void)len;
  return RIG_E_UNSUPPORTED;  // T07 (port table, hot-plug release)
}

double rig_engine_time(const rig_engine *e) {
  return e ? impl(e)->engineTime() : 0.0;
}

rig_status rig_get_meters(const rig_engine *e, rig_meters *out) {
  return e ? impl(e)->getMeters(out) : RIG_E_INVALID;
}

rig_status rig_offline_render(rig_engine *e, float *const *out, uint32_t channels, uint32_t frames) {
  return e ? impl(e)->offlineRender(out, channels, frames) : RIG_E_INVALID;
}

rig_status rig_offline_settle(rig_engine *e) {
  if (!e) return RIG_E_INVALID;
  return impl(e)->realtime() ? RIG_E_STATE : RIG_OK;  // offline work is inline: nothing to wait for
}

rig_status rig_test_tap(rig_engine *e, const char *node) {
  return e ? impl(e)->testTap(node) : RIG_E_INVALID;
}

rig_status rig_test_inject(rig_engine *e, const char *node, const float *const *data, uint32_t channels,
                           uint64_t frames, double start_sec, float gain) {
  return e ? impl(e)->testInject(node, data, channels, frames, start_sec, gain) : RIG_E_INVALID;
}

size_t rig_test_query(rig_engine *e, const char *what, char *buf, size_t cap) {
  return e ? impl(e)->testQuery(what, buf, cap) : 0;
}

}  // extern "C"
