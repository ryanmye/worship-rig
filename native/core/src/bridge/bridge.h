// BRIDGE v1 (contract section 6): parse a JSON message or array, dispatch the 14 ops, write replies and warnings.
#pragma once
#include <cstddef>

namespace rig {

class Engine;

class Bridge {
 public:
  explicit Bridge(Engine &e) : e_(e) {}
  /** One message object or an array of them. False when the text is not a JSON object/array. */
  bool handle(const char *json, std::size_t len);

 private:
  Engine &e_;
  bool helloDone_ = false;
};

}  // namespace rig
