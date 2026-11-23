// BRIDGE v1 (contract section 6): parse a JSON message or array, dispatch the 14 ops, write replies and warnings.
#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace rig {

class Engine;
struct Req;

class Bridge {
 public:
  explicit Bridge(Engine &e) : e_(e) {}
  /** One message object or an array of them. False when the text is not a JSON object/array. */
  bool handle(const char *json, std::size_t len);

 private:
  void dispatch(const Req &r);
  Engine &e_;
  bool helloDone_ = false;

 public:
  // token bookkeeping for `stale-token` vs `superseded` (contract 6.2): every token up to maxToken_ was issued;
  // tokens <= restartFloor_ were prepared before an `audio restart` (contract 1.1: restart invalidates them).
  std::uint32_t maxToken_ = 0, restartFloor_ = 0, committedToken_ = 0;
  // CORE2A: `prepare` replies waiting for their samples to decode (control thread only). A newer prepare sends the
  // ones still waiting at once (superseded); the cache's callback sends the rest.
  struct PendingReply {
    bool sent = false;
    std::string text;
    int waits = 1;  // CORE3: samples settled + plan built (each callback counts one down; the last one sends)
  };
  std::vector<std::shared_ptr<PendingReply>> pendingPrepares_;
};

}  // namespace rig
