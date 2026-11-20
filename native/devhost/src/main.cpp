// rig-devhost command line (native/devhost/README.md).
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <condition_variable>
#include <mutex>
#include <thread>

#include "devhost.h"

namespace {

devhost::Devhost *g_host = nullptr;

void onSignal(int) {
  if (g_host) g_host->stop();
}

void usage() {
  std::fputs(
      "usage: rig-devhost [options]\n"
      "  --port N            HTTP + WebSocket port (default 8440; 0 = any free port)\n"
      "  --bind ADDR         listen address (default 127.0.0.1)\n"
      "  --repo DIR          repository root (default: the one this binary was built from)\n"
      "  --backend NAME      auto | null | alsa | pulse | jack | coreaudio (default auto)\n"
      "  --period N          frames per callback for latency 'interactive' (default 128)\n"
      "  --rate HZ           device rate (default: the device's own)\n"
      "  --recordings DIR    folder for `rec` takes (default ~/Music/Worship Rig)\n"
      "  --seed N            engine seed (default: time-derived)\n"
      "  --log FILE          write every bridge message (both directions) as JSON lines\n"
      "  --no-serve          WebSocket only (serve the UI elsewhere; boot-devhost.js takes ?devhost=ws://...)\n"
      "  --no-patch-main     serve js/main.js unchanged\n"
      "  --exit-after SEC    stop after SEC seconds (tests)\n"
      "Open http://127.0.0.1:<port>/ in Chromium: the real UI, engine = the native core.\n",
      stderr);
}

}  // namespace

int main(int argc, char **argv) {
  devhost::DevhostOptions o;
  o.repoDir = DEVHOST_REPO_DIR;
  const char *home = std::getenv("HOME");
  o.recordingsDir = std::string(home ? home : ".") + "/Music/Worship Rig";
  double exitAfter = 0;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto val = [&]() -> std::string {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "rig-devhost: %s needs a value\n", a.c_str());
        std::exit(2);
      }
      return argv[++i];
    };
    if (a == "--port") {
      o.port = static_cast<std::uint16_t>(std::stoul(val()));
    } else if (a == "--bind") {
      o.bind = val();
    } else if (a == "--repo") {
      o.repoDir = val();
    } else if (a == "--backend") {
      o.audio.backend = val();
    } else if (a == "--period") {
      o.audio.periodFrames = static_cast<std::uint32_t>(std::stoul(val()));
    } else if (a == "--rate") {
      o.audio.sampleRate = static_cast<std::uint32_t>(std::stoul(val()));
    } else if (a == "--recordings") {
      o.recordingsDir = val();
    } else if (a == "--seed") {
      o.seed = static_cast<std::uint32_t>(std::stoul(val()));
    } else if (a == "--log") {
      o.logPath = val();
    } else if (a == "--no-serve") {
      o.serveApp = false;
    } else if (a == "--no-patch-main") {
      o.patchMain = false;
    } else if (a == "--exit-after") {
      exitAfter = std::stod(val());
    } else if (a == "-h" || a == "--help") {
      usage();
      return 0;
    } else {
      std::fprintf(stderr, "rig-devhost: unknown option %s\n", a.c_str());
      usage();
      return 2;
    }
  }
  std::signal(SIGPIPE, SIG_IGN);
  devhost::Devhost host(o);
  std::string err;
  if (!host.open(&err)) {
    std::fprintf(stderr, "rig-devhost: %s\n", err.c_str());
    return 1;
  }
  g_host = &host;
  std::signal(SIGINT, onSignal);
  std::signal(SIGTERM, onSignal);
  // the line test harnesses wait for (stdout, flushed): the bound port when --port 0
  std::printf("rig-devhost listening on http://%s:%u/ (ws %s, audio %s, %s)\n", o.bind.c_str(), host.port(),
              devhost::kWsPath, host.audio().backendName().c_str(), rig_version_string());
  std::fflush(stdout);
  std::mutex mu;
  std::condition_variable cv;
  bool done = false;
  std::thread timer;
  if (exitAfter > 0) {
    timer = std::thread([&] {
      std::unique_lock<std::mutex> lk(mu);
      if (!cv.wait_for(lk, std::chrono::duration<double>(exitAfter), [&] { return done; })) host.stop();
    });
  }
  host.run();
  {
    std::lock_guard<std::mutex> lk(mu);
    done = true;
  }
  cv.notify_all();
  if (timer.joinable()) timer.join();
  g_host = nullptr;
  host.close();
  std::fprintf(stderr, "rig-devhost: %s\n", host.summary().c_str());
  return 0;
}
