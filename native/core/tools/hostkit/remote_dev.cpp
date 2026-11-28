// rig-remote-dev (remote lane, D45): the browser remote's real server without the Mac app, for the Playwright test of
// app/remote/index.html (test/phase2/remote) and for trying the page from a phone on Linux. The main page's side is
// stdin / stdout, one line each:
//   in:  state <bus state json>   publish a state          out: ready <port>          listening
//        code                     roll the pairing code         cmd <bus command json>  a command for the main page
//        forget                   end every pairing             info <info json>        after `info`, and on changes
//        info                     print the info JSON
//        stop                     stop and exit
// Usage: rig-remote-dev --page app/remote/index.html [--bind 127.0.0.1] [--port N | --any-port]
//        [--long-poll-ms N] [--ws-auth-ms N]
// --bind defaults to 127.0.0.1 (this is a test tool); pass --bind "" to listen everywhere, as the app does.
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>

#include "remote_server.h"

using namespace rig::hostkit::remote;

namespace {
std::mutex outMu;
void out(const std::string &line) {
  std::lock_guard<std::mutex> g(outMu);
  std::cout << line << '\n' << std::flush;
}
}  // namespace

int main(int argc, char **argv) {
  std::string pagePath, bind = "127.0.0.1";
  StartOptions opt;
  ServerTimeouts to;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : std::string(); };
    if (a == "--page") pagePath = next();
    else if (a == "--bind") bind = next();
    else if (a == "--port") opt.port = std::stoi(next());
    else if (a == "--any-port") opt.anyPort = true;
    else if (a == "--long-poll-ms") to.longPollMs = std::stoll(next());
    else if (a == "--ws-auth-ms") to.wsAuthMs = std::stoll(next());
    else {
      std::fprintf(stderr, "unknown option %s\n", a.c_str());
      return 2;
    }
  }
  opt.bind = bind;
  Server *srv = nullptr;
  Server server(ServerHooks{[](const std::string &c) { out("cmd " + c); },
                            [&srv] {
                              if (srv) out("info " + srv->infoJson());
                            }},
                Limits{}, to);
  if (!pagePath.empty()) {
    std::ifstream f(pagePath, std::ios::binary);
    if (!f) {
      std::fprintf(stderr, "cannot read %s\n", pagePath.c_str());
      return 1;
    }
    std::stringstream ss;
    ss << f.rdbuf();
    server.setPage(ss.str());
  }
  std::string err;
  if (!server.start(opt, &err)) {
    std::fprintf(stderr, "start failed: %s\n", err.c_str());
    return 1;
  }
  srv = &server;
  out("ready " + std::to_string(server.port()));
  for (std::string line; std::getline(std::cin, line);) {
    if (line.rfind("state ", 0) == 0) {
      if (!server.publishState(line.substr(6))) out("error invalid state");
    } else if (line == "code") {
      server.newCode();
    } else if (line == "forget") {
      server.forgetAll();
    } else if (line == "info") {
      out("info " + server.infoJson());
    } else if (line == "stop") {
      break;
    }
  }
  srv = nullptr;
  server.stop();
  return 0;
}
