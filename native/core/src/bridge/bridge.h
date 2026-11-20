// BRIDGE v1 (contract section 6): parse a JSON message or array, dispatch the 14 ops, write replies and warnings.
#pragma once
#include <cstddef>
#include <cstdint>

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
};

}  // namespace rig
