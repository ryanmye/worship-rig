// The browser remote's decisions (remote lane, D45). See remote_service.h and native/docs/lanes/REMOTE.md §2.3.
#include "remote_service.h"

#include <algorithm>
#include <cmath>

#include "bus_check.h"
#include "js_json.h"
#include "js_text.h"
#include "rig/rig_bus.h"

namespace rig::hostkit::remote {

const char *const kPageCommands[7] = {"prevSong", "nextSong", "prevSnapshot", "nextSnapshot",
                                      "panic",    "droneOn",  "droneOff"};

namespace {

bool isPageCommand(const std::string &s) {
  return std::any_of(std::begin(kPageCommands), std::end(kPageCommands), [&](const char *c) { return s == c; });
}

/** A command id: 1..32 of [A-Za-z0-9_-] (the page makes them; anything else is refused, never echoed raw). */
bool validId(const std::string &s) {
  if (s.empty() || s.size() > 32) return false;
  return std::all_of(s.begin(), s.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
  });
}

/** The first `max` code points of WTF-8 text. */
std::string cutCodePoints(const std::string &s, std::size_t max) {
  std::size_t i = 0, n = 0;
  while (i < s.size() && n < max) {
    nextCodePoint(s, i);
    ++n;
  }
  return s.substr(0, i);
}

std::string quote(std::string_view s) {
  std::string out;
  jsonQuote(s, out);
  return out;
}

std::string reply(const std::string &id, bool ok, const std::string &error) {
  std::string r = "{";
  if (!id.empty()) r += "\"id\":" + quote(id) + ",";  // validId: plain ASCII, safe as is
  r += ok ? "\"ok\":true}" : "\"ok\":false,\"error\":" + quote(error) + "}";
  return r;
}

}  // namespace

bool constantTimeEquals(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  unsigned char d = 0;
  for (std::size_t i = 0; i < a.size(); ++i) d |= static_cast<unsigned char>(a[i] ^ b[i]);
  return d == 0;
}

Service::Service(Limits limits, NowMs now, Random random)
    : lim_(limits), now_(std::move(now)), random_(std::move(random)) {
  newCode();
}

void Service::newCode() {
  std::uint32_t limit = 1;
  for (int i = 0; i < lim_.codeDigits; ++i) limit *= 10;
  const std::uint32_t top = (0xFFFFFFFFu / limit) * limit;  // reject above: every code equally likely
  std::string next;
  do {
    std::uint32_t r = 0;
    do {
      std::uint8_t b[4];
      random_(b, 4);
      r = static_cast<std::uint32_t>(b[0]) | static_cast<std::uint32_t>(b[1]) << 8
          | static_cast<std::uint32_t>(b[2]) << 16 | static_cast<std::uint32_t>(b[3]) << 24;
    } while (r >= top);
    std::string s = std::to_string(r % limit);
    next = std::string(static_cast<std::size_t>(lim_.codeDigits) - s.size(), '0') + s;
  } while (next == code_);
  code_ = next;
  globalFailures_ = 0;
  ++infoVersion_;
}

std::int64_t Service::pausedMs() const {
  const std::int64_t left = pausedUntil_ - now_();
  return left > 0 ? left : 0;
}

bool Service::take(Bucket &b, double rate, double burst) {
  const std::int64_t t = now_();
  b.tokens = std::min(burst, b.tokens + static_cast<double>(t - b.at) / 1000.0 * rate);
  b.at = t;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

Service::IpEntry &Service::ipEntry(const std::string &ip) {
  const std::int64_t t = now_();
  auto it = ips_.find(ip);
  if (it == ips_.end()) {
    if (ips_.size() >= lim_.maxTrackedIps) {
      auto oldest = std::min_element(ips_.begin(), ips_.end(),
                                     [](const auto &a, const auto &b) { return a.second.touched < b.second.touched; });
      ips_.erase(oldest);
    }
    IpEntry e;
    e.bucket.tokens = lim_.reqBurst;
    e.bucket.at = t;
    it = ips_.emplace(ip, std::move(e)).first;
  }
  it->second.touched = t;
  while (!it->second.failures.empty() && it->second.failures.front() <= t - lim_.failureWindowMs) {
    it->second.failures.pop_front();
  }
  return it->second;
}

bool Service::allowRequest(const std::string &ip) {
  IpEntry &e = ipEntry(ip);
  return take(e.bucket, lim_.reqRatePerSec, lim_.reqBurst);
}

std::string Service::randomToken() {
  std::uint8_t b[16];
  random_(b, sizeof b);
  static const char *hexd = "0123456789abcdef";
  std::string s;
  for (std::uint8_t x : b) {
    s.push_back(hexd[x >> 4]);
    s.push_back(hexd[x & 15]);
  }
  return s;
}

PairResult Service::pair(const std::string &ip, std::string_view code) {
  PairResult r;
  const bool formatOk = code.size() == static_cast<std::size_t>(lim_.codeDigits)
                        && std::all_of(code.begin(), code.end(), [](char c) { return c >= '0' && c <= '9'; });
  if (!formatOk) {
    r.status = 400;
    r.error = "bad-code-format";
    return r;
  }
  const std::int64_t t = now_();
  if (pausedUntil_ > t) {
    r.status = 429;
    r.error = "paused";
    r.retryAfterSec = static_cast<int>((pausedUntil_ - t + 999) / 1000);
    return r;
  }
  IpEntry &e = ipEntry(ip);
  if (static_cast<int>(e.failures.size()) >= lim_.ipFailuresPerWindow) {
    r.status = 429;
    r.error = "too-many-tries";
    r.retryAfterSec = static_cast<int>((e.failures.front() + lim_.failureWindowMs - t + 999) / 1000);
    return r;
  }
  if (!constantTimeEquals(code, code_)) {
    e.failures.push_back(t);
    if (++globalFailures_ >= lim_.globalFailuresBeforeRotate) {
      newCode();  // resets globalFailures_; Settings shows the new code
      pausedUntil_ = t + lim_.failureWindowMs;
    }
    r.status = 403;
    r.error = "wrong-code";
    return r;
  }
  Token tok;
  tok.value = randomToken();
  tok.lastUsed = t;
  tok.bucket.tokens = lim_.cmdBurst;
  tok.bucket.at = t;
  if (tokens_.size() >= lim_.maxTokens) {
    tokens_.erase(std::min_element(tokens_.begin(), tokens_.end(),
                                   [](const Token &a, const Token &b) { return a.lastUsed < b.lastUsed; }));
  }
  r.token = tok.value;
  tokens_.push_back(std::move(tok));
  ++infoVersion_;
  return r;
}

Service::Token *Service::findToken(std::string_view token) {
  Token *found = nullptr;
  for (Token &t : tokens_) {  // compare against every token: the time doesn't say which one (or whether) it matched
    if (constantTimeEquals(token, t.value)) found = &t;
  }
  if (found) found->lastUsed = now_();
  return found;
}

bool Service::tokenValid(std::string_view token) { return findToken(token) != nullptr; }

void Service::forgetAll() {
  tokens_.clear();
  ++infoVersion_;
}

bool Service::setState(std::string_view json) {
  JVal m;
  if (busCheckText(json, RIG_BUS_STATE_MAX, true, &m)) return false;
  const JVal *cur = m.get("current");
  const JVal *scene = m.get("scene");
  const JVal *n = scene ? scene->get("n") : nullptr;
  const JVal *name = scene ? scene->get("name") : nullptr;
  const JVal *locked = m.get("locked");
  std::string body;
  body += "\"ready\":true,\"song\":";
  body += cur && cur->type == JVal::Obj ? quote(cutCodePoints(cur->get("name")->str, lim_.songNameMax)) : "null";
  body += ",\"snapshot\":";
  body += name && n && n->type == JVal::Num ? quote(name->str) : "null";
  body += ",\"snapshotN\":";
  body += n && n->type == JVal::Num ? std::to_string(static_cast<long long>(n->num)) : "null";
  body += ",\"snapshotCount\":";
  body += scene ? std::to_string(static_cast<long long>(scene->get("count")->num)) : "0";
  locked_ = locked && locked->b;
  body += m.get("droneOn")->b ? ",\"droneOn\":true" : ",\"droneOn\":false";
  body += locked_ ? ",\"locked\":true" : ",\"locked\":false";
  body += ",\"audio\":" + quote(m.get("audio")->str);
  hasState_ = true;
  if (body != viewBody_) {
    viewBody_ = std::move(body);
    ++seq_;
  }
  return true;
}

std::string Service::viewJson() const {
  if (!hasState_) return "{\"seq\":0,\"ready\":false}";
  return "{\"seq\":" + std::to_string(seq_) + "," + viewBody_ + "}";
}

CommandResult Service::finish(Token *t, const std::string &id, CommandResult r) {
  r.replyJson = reply(id, r.ok, r.error);
  if (t && !id.empty() && r.status == 200) {
    t->seen.emplace_back(id, std::make_pair(now_(), r.replyJson));
    while (t->seen.size() > lim_.dedupePerToken) t->seen.pop_front();
  }
  return r;
}

CommandResult Service::command(std::string_view token, std::string_view bodyJson) {
  CommandResult r;
  Token *t = findToken(token);
  if (!t) {
    r.status = 401;
    r.error = "not-paired";
    return finish(nullptr, "", r);
  }
  if (!take(t->bucket, lim_.cmdRatePerSec, lim_.cmdBurst)) {
    r.status = 429;
    r.error = "rate-limited";
    return finish(nullptr, "", r);
  }
  ParseResult p = jsonParse(decodeUtf8(bodyJson), 4);
  const JVal *cmd = p.ok && !p.tooDeep && p.value.type == JVal::Obj ? p.value.get("cmd") : nullptr;
  const JVal *idv = p.ok && !p.tooDeep && p.value.type == JVal::Obj ? p.value.get("id") : nullptr;
  const std::string id = idv && idv->type == JVal::Str && validId(idv->str) ? idv->str : "";
  if (id.empty()) {
    r.status = 400;
    r.error = "bad-id";
    return finish(nullptr, "", r);
  }
  // a repeated id (a retried poll request, a WebSocket resend) gets the first answer and runs nothing
  const std::int64_t now = now_();
  while (!t->seen.empty() && t->seen.front().second.first <= now - lim_.dedupeMs) t->seen.pop_front();
  for (const auto &s : t->seen) {
    if (s.first == id) {
      r.ok = s.second.second.find("\"ok\":true") != std::string::npos;
      r.repeated = true;
      r.replyJson = s.second.second;
      return r;
    }
  }
  if (!(cmd && cmd->type == JVal::Str && isPageCommand(cmd->str))) {
    r.status = 400;
    r.error = "bad-command";
    return finish(nullptr, id, r);
  }
  const std::string &c = cmd->str;
  if (c != "panic") {
    // PANIC always goes; everything else needs a state (to know Lock and the drone) and Lock off. The controller
    // checks Lock again on arrival (the state here may be one throttle window old).
    if (!hasState_) {
      r.error = "not-ready";
      return finish(t, id, r);
    }
    if (locked_) {
      r.error = "locked";
      return finish(t, id, r);
    }
  }
  std::string type;
  std::string extra;
  if (c == "prevSnapshot") type = "prevScene";
  else if (c == "nextSnapshot") type = "nextScene";
  else if (c == "droneOn" || c == "droneOff") {
    type = "droneToggle";  // with D45's absolute `on`: a doubled or retried press can't flip it twice
    extra = c == "droneOn" ? ",\"on\":true" : ",\"on\":false";
  } else type = c;
  r.ok = true;
  r.bus = "{\"v\":1,\"type\":\"" + type + "\"" + extra + ",\"via\":\"remote\"}";
  return finish(t, id, r);
}

}  // namespace rig::hostkit::remote
