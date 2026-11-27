// rig-devhost composition (see devhost.h).
#include "devhost.h"

#include "rig/rig_hostkit.h"

#include <filesystem>
#include <fstream>
#include <sstream>

namespace devhost {

namespace {

std::string readFile(const std::string &path, bool *ok) {
  std::ifstream f(path, std::ios::binary);
  *ok = static_cast<bool>(f);
  if (!*ok) return {};
  std::ostringstream s;
  s << f.rdbuf();
  return s.str();
}

std::string quote(const std::string &s) {
  std::string o = "\"";
  for (const char c : s) {
    if (c == '"' || c == '\\') {
      o.push_back('\\');
      o.push_back(c);
    } else if (static_cast<unsigned char>(c) < 0x20) {
      char b[8];
      std::snprintf(b, sizeof b, "\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(c)));
      o += b;
    } else {
      o.push_back(c);
    }
  }
  return o + "\"";
}

HttpResponse json(int code, std::string body) {
  HttpResponse r;
  r.code = code;
  r.type = "application/json";
  r.body = std::move(body);
  return r;
}

}  // namespace

Devhost::Devhost(DevhostOptions o) : o_(std::move(o)) {
  audio_ = std::make_unique<AudioHost>(o_.audio);
  appDir_ = o_.repoDir + "/app";
  contractPath_ = o_.repoDir + "/native/contract/engine-api.json";
  rootsJson_ = "[";
  for (const std::string &r : o_.userSamples) {
    std::error_code ec;
    const std::string abs = std::filesystem::absolute(r, ec).lexically_normal().string();
    rootsJson_ += (rootsJson_.size() > 1 ? "," : "") + quote(ec ? r : abs);
  }
  rootsJson_ += "]";
  ServerHooks hooks;
  hooks.http = [this](const HttpRequest &r) { return route(r); };
  hooks.message = [this](std::string &&m) {
    logLine("in", m.data(), m.size());
    if (m.find("\"op\":\"hello\"") != std::string::npos) helloSeen_ = true;
    const rig_status s = rig_post(engine_, m.data(), m.size());
    if (s != RIG_OK) std::fprintf(stderr, "devhost: rig_post: %s\n", rig_status_string(s));
  };
  hooks.pageGone = [this](const char *why) { pageGone(why); };
  hooks.pageOpen = [] { std::fprintf(stderr, "devhost: page connected\n"); };
  server_ = std::make_unique<Server>(kWsPath, std::move(hooks));
}

Devhost::~Devhost() {
  close();
  if (log_) std::fclose(log_);
}

bool Devhost::open(std::string *err) {
  t0_ = hostNowNs();
  if (!o_.logPath.empty()) {
    log_ = std::fopen(o_.logPath.c_str(), "w");
    if (!log_) {
      if (err) *err = "cannot write log " + o_.logPath;
      return false;
    }
  }
  if (!audio_->init(err)) return false;
  std::error_code ec;
  if (!o_.recordingsDir.empty()) std::filesystem::create_directories(o_.recordingsDir, ec);
  rig_config cfg;
  rig_config_init(&cfg);
  cfg.mode = RIG_MODE_REALTIME;
  cfg.max_block_frames = o_.audio.maxBlockFrames;
  cfg.seed = o_.seed;
  cfg.app_dir = appDir_.c_str();
  cfg.recordings_dir = o_.recordingsDir.empty() ? nullptr : o_.recordingsDir.c_str();
  cfg.on_event = &Devhost::onEvent;
  cfg.event_user = this;
  cfg.on_log = &Devhost::onLog;
  cfg.log_user = this;
  cfg.host = audio_->vtable();
  rig_status st = RIG_OK;
  engine_ = rig_create(&cfg, &st);
  if (!engine_) {
    if (err) *err = std::string("rig_create: ") + rig_status_string(st);
    return false;
  }
  audio_->attach(engine_);
  return server_->listen(o_.bind, o_.port, err);
}

void Devhost::close() {
  if (!engine_) return;
  audio_->shutdown();  // rig_destroy needs rig_render to have stopped (rig_engine.h)
  audio_->attach(nullptr);
  rig_destroy(engine_);  // finalises an open recording; its last events go nowhere (no page)
  engine_ = nullptr;
}

void Devhost::onEvent(void *user, const char *json, std::size_t len) {
  auto *self = static_cast<Devhost *>(user);
  self->logLine("out", json, len);
  self->server_->send(std::string(json, len));
}

void Devhost::onLog(void *, int level, const char *msg) {
  if (level >= 2) std::fprintf(stderr, "core[%d]: %s\n", level, msg);
}

void Devhost::logLine(const char *dir, const char *json, std::size_t len) {
  if (!log_) return;
  const double ms = static_cast<double>(hostNowNs() - t0_) / 1e6;
  std::lock_guard<std::mutex> lk(logMu_);
  std::fprintf(log_, "{\"ms\":%.3f,\"dir\":\"%s\",\"msg\":", ms, dir);
  std::fwrite(json, 1, len, log_);
  std::fputs("}\n", log_);
  std::fflush(log_);
}

void Devhost::pageGone(const char *why) {
  std::fprintf(stderr, "devhost: page gone (%s)\n", why);
  if (!helloSeen_.exchange(false) || !engine_) return;
  // what RigHost.webContentDidTerminate posts (SHELL.md): held notes and a running take must not outlive the page
  static const char kCleanup[] =
      R"([{"v":1,"op":"play","e":"panic"},{"v":1,"op":"rec","action":"stop"}])";
  logLine("in", kCleanup, sizeof kCleanup - 1);
  rig_post(engine_, kCleanup, sizeof kCleanup - 1);
}

HttpResponse Devhost::route(const HttpRequest &r) const {
  const std::string &p = r.path;
  if (p == "/__bridge/engine-api.json") {
    bool ok = false;
    std::string body = readFile(contractPath_, &ok);
    return ok ? json(200, std::move(body)) : json(404, R"({"error":"engine-api.json not found"})");
  }
  if (p == "/api/health") {
    if (o_.userSamples.empty()) {
      return json(200, R"({"ok":true,"app":"worship-rig","version":"devhost","userSamples":false,"devhost":true})");
    }
    // lane N1, as server.js: 'user-patches' only when a pack has a songs/*.json, so no pack = no request
    const bool packs = rig_hostkit_has_patches(rootsJson_.c_str()) == 1;
    return json(200, std::string(R"({"ok":true,"app":"worship-rig","version":"devhost","userSamples":true,)") +
                         (packs ? R"("userPatches":true,"features":["user-samples","user-patches"],)"
                                : R"("userPatches":false,"features":["user-samples"],)") +
                         R"("devhost":true})");
  }
  if (p == "/api/user-patches") {
    if (o_.userSamples.empty()) {
      return json(200,
                  R"({"app":"worship-rig","kind":"user-patches","enabled":false,"patches":[],"packs":[],"errors":[]})");
    }
    // the `user:` ids are not checked (null): the dev host has no My Samples scanner yet (lane N2)
    char *body = rig_hostkit_user_patches_json(rootsJson_.c_str(), nullptr);
    if (!body) return json(500, R"({"error":"out of memory"})");
    HttpResponse res = json(200, body);
    rig_hostkit_free(body);
    return res;
  }
  if (p == "/api/user-samples" && !o_.userSamples.empty()) {  // the Settings summary (server.js shape, no scanner)
    const std::string home = quote(std::filesystem::absolute(o_.userSamples.front()).lexically_normal().string());
    return json(200, R"({"enabled":true,"dir":)" + home + R"(,"path":)" + home + R"(,"roots":)" + rootsJson_ +
                         R"(,"count":0,"packs":[],"errors":[]})");
  }
  if (p == "/api/user-samples/manifest.json" && !o_.userSamples.empty()) {
    return json(200, R"({"app":"worship-rig","kind":"user-samples","instruments":[],"roots":)" + rootsJson_ +
                         R"(,"packs":[],"errors":[]})");
  }
  if (p.rfind("/api/user-samples", 0) == 0) return json(200, R"({"instruments":[]})");
  if (p == "/api/pads") return json(200, R"({"files":[]})");
  if (p == "/api/heartbeat" || p == "/favicon.ico") {
    HttpResponse res;
    res.code = 204;
    return res;
  }
  if (p.rfind("/api/", 0) == 0) return json(404, R"({"error":"not served by rig-devhost"})");
  HttpResponse res;
  if (!o_.serveApp) {
    res.body = "rig-devhost: static files are off (--no-serve)";
    return res;
  }
  auto file = resolveStatic(appDir_, p);
  if (!file) {
    res.body = "not found";
    return res;
  }
  bool ok = false;
  std::string body = readFile(*file, &ok);
  if (!ok) {
    res.body = "not found";
    return res;
  }
  if (o_.patchMain && p == "/js/main.js") {
    const std::size_t at = body.find(kMainNeedle);
    if (at == std::string::npos) {
      std::fprintf(stderr, "devhost: main.js engine import changed; serving it unpatched (Web Audio engine)\n");
    } else {
      body.replace(at, std::char_traits<char>::length(kMainNeedle), kMainDevhost);
    }
  }
  res.code = 200;
  res.type = mimeFor(*file);
  res.body = std::move(body);
  return res;
}

std::string Devhost::summary() const {
  const AudioStats a = audio_->stats();
  const ServerStats s = server_->stats();
  char buf[512];
  const double cb = a.callbacks ? static_cast<double>(a.totalNs) / static_cast<double>(a.callbacks) / 1e3 : 0;
  const double quanta = static_cast<double>(a.frames) / RIG_QUANTUM_FRAMES;
  const double perQ = quanta > 0 ? static_cast<double>(a.totalNs - a.renderNs) / quanta / 1e3 : 0;
  std::snprintf(buf, sizeof buf,
                "audio: %llu callbacks, %llu frames, %.1f us avg / %.1f us max per callback, wrapper %.2f us per "
                "128 frames | ws: %llu pages, %llu in, %llu out (%llu dropped), %llu http",
                static_cast<unsigned long long>(a.callbacks), static_cast<unsigned long long>(a.frames), cb,
                static_cast<double>(a.maxNs) / 1e3, perQ, static_cast<unsigned long long>(s.pages),
                static_cast<unsigned long long>(s.inMessages), static_cast<unsigned long long>(s.outMessages),
                static_cast<unsigned long long>(s.droppedOut), static_cast<unsigned long long>(s.httpRequests));
  return buf;
}

}  // namespace devhost
