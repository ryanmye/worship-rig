// rig_remote.h over remote::Server (remote lane, D45). Nothing throws across the C API (hostkit_c.cpp's rule): an
// exception (allocation) becomes the function's documented failure value.
#include <cstdlib>
#include <cstring>
#include <string>

#include "remote_server.h"
#include "rig/rig_remote.h"

struct rig_remote {
  rig::hostkit::remote::Server server;
  explicit rig_remote(rig::hostkit::remote::ServerHooks h) : server(std::move(h)) {}
};

namespace {
char *dup(const std::string &s) {
  char *p = static_cast<char *>(std::malloc(s.size() + 1));
  if (p) std::memcpy(p, s.c_str(), s.size() + 1);
  return p;
}
}  // namespace

extern "C" rig_remote *rig_remote_create(rig_remote_command_fn on_command, rig_remote_info_fn on_info, void *ctx) {
  try {
    rig::hostkit::remote::ServerHooks h;
    if (on_command) h.command = [on_command, ctx](const std::string &json) { on_command(ctx, json.c_str()); };
    if (on_info) h.info = [on_info, ctx] { on_info(ctx); };
    return new rig_remote(std::move(h));
  } catch (...) {
    return nullptr;
  }
}

extern "C" void rig_remote_destroy(rig_remote *r) { delete r; }

extern "C" void rig_remote_set_page(rig_remote *r, const char *html, size_t len) {
  try {
    if (r) r->server.setPage(html ? std::string(html, len) : std::string());
  } catch (...) {
  }
}

extern "C" int rig_remote_start(rig_remote *r, int port, char **error) {
  if (error) *error = nullptr;
  if (!r || port < 0 || port > 65535) {
    if (error) *error = dup("bad arguments");
    return -1;
  }
  try {
    rig::hostkit::remote::StartOptions o;
    o.port = port;
    std::string err;
    if (!r->server.start(o, &err)) {
      if (error) *error = dup(err);
      return -1;
    }
    return r->server.port();
  } catch (...) {
    if (error) *error = dup("out of memory");
    return -1;
  }
}

extern "C" void rig_remote_stop(rig_remote *r) {
  try {
    if (r) r->server.stop();
  } catch (...) {
  }
}

extern "C" int rig_remote_publish_state(rig_remote *r, const char *json, size_t len) {
  if (!r || !json) return 0;
  try {
    return r->server.publishState(std::string_view(json, len)) ? 1 : 0;
  } catch (...) {
    return 0;
  }
}

extern "C" char *rig_remote_info_json(rig_remote *r) {
  try {
    return r ? dup(r->server.infoJson()) : nullptr;
  } catch (...) {
    return nullptr;
  }
}

extern "C" void rig_remote_new_code(rig_remote *r) {
  try {
    if (r) r->server.newCode();
  } catch (...) {
  }
}

extern "C" void rig_remote_forget_all(rig_remote *r) {
  try {
    if (r) r->server.forgetAll();
  } catch (...) {
  }
}
