// rig-devhost: the native core + miniaudio + a WebSocket relay, so the real UI runs against the native engine in
// Chromium on Linux or macOS (native/devhost/README.md). The relay is the Apple shell's RigHost in miniature: page
// messages go to rig_post() unchanged, every on_event payload goes back as one WebSocket text frame (a message or an
// ordered array, as `__rigNative.receive` gets it), and a page that goes away gets `[play panic, rec stop]` posted
// for it (SHELL.md "Web view recovery": the dead page can no longer release its notes or stop its take).
#pragma once
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "audio_host.h"
#include "rig/rig_engine.h"
#include "server.h"

namespace devhost {

struct DevhostOptions {
  std::string bind = "127.0.0.1";
  std::uint16_t port = 8440;
  std::string repoDir;          // repository root (app/, native/contract/)
  std::string recordingsDir;    // rig_config.recordings_dir (created if missing)
  bool serveApp = true;         // serve app/ over HTTP next to the WebSocket
  bool patchMain = true;        // serve js/main.js with the engine import swapped to boot-devhost.js
  std::string logPath;          // JSON lines of every message in both directions ("" = off)
  std::uint32_t seed = 0;       // 0 = time-derived (realtime)
  std::vector<std::string> userSamples;  // My Samples roots (--user-samples; lane N1): empty = My Samples off
  AudioOptions audio;
};

/** The import line main.js has today and the one the dev host serves instead (boot-smoke.mjs uses the same). */
inline constexpr const char *kMainNeedle = "import { AudioEngine } from './engine/index.js';";
inline constexpr const char *kMainDevhost = "import { AudioEngine } from './engine-bridge/boot-devhost.js';";
inline constexpr const char *kWsPath = "/__rig/ws";

class Devhost {
 public:
  explicit Devhost(DevhostOptions o);
  ~Devhost();
  Devhost(const Devhost &) = delete;
  Devhost &operator=(const Devhost &) = delete;

  /** Audio context, engine, listening socket. */
  bool open(std::string *err);
  /** Poll loop on the calling thread until stop(). */
  void run() { server_->run(); }
  /** Async-signal-safe. */
  void stop() { server_->stop(); }
  /** Stop audio and destroy the engine (after run() returned). Idempotent. */
  void close();

  std::uint16_t port() const { return server_->port(); }
  rig_engine *engine() const { return engine_; }
  AudioHost &audio() { return *audio_; }
  ServerStats serverStats() const { return server_->stats(); }
  /** One-line summary (callback cost, traffic) printed at exit. */
  std::string summary() const;

  /** Routes for a plain HTTP request (public for tests). */
  HttpResponse route(const HttpRequest &r) const;

 private:
  static void onEvent(void *user, const char *json, std::size_t len);
  static void onLog(void *user, int level, const char *msg);
  void logLine(const char *dir, const char *json, std::size_t len);
  void pageGone(const char *why);

  DevhostOptions o_;
  std::unique_ptr<AudioHost> audio_;
  std::unique_ptr<Server> server_;
  rig_engine *engine_ = nullptr;
  std::atomic<bool> helloSeen_{false};
  std::mutex logMu_;
  std::FILE *log_ = nullptr;
  std::uint64_t t0_ = 0;
  std::string appDir_, contractPath_;
  std::string rootsJson_;  // o_.userSamples as a JSON array of absolute paths (rig_hostkit)
};

}  // namespace devhost
