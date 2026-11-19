// Model (control thread): engine state and policy; emits timestamped Commands. T00 skeleton: prepare/commit of a
// patch (4 slot strips), `set` of slot gain/pan/eq and master.volume with the contract's smoothing, test-voice notes.
// Method names mirror contract section 1; T13/T14 fill in the rest.
#pragma once
#include <cstdint>
#include <map>
#include <string>
#include <string_view>

#include "model/patch.h"
#include "runtime/command.h"

struct yyjson_val;

namespace rig {

/** What the Model needs from the engine: command submission and the clock. Implemented by Engine. */
class CommandSink {
 public:
  virtual ~CommandSink() = default;
  virtual bool send(Command c) = 0;       // stamps seq; false when the queue is full
  virtual std::int64_t renderedFrames() const = 0;
  virtual double sampleRate() const = 0;
};

struct SetResult {
  enum Status { Applied, NotApplied, Unknown, Bad } status = Applied;
  std::string message;
};

struct ModelStats {
  std::uint32_t prepares = 0, commits = 0, sets = 0, notesOn = 0, notesOff = 0, voicesEnded = 0, droppedCommands = 0;
};

class Model {
 public:
  explicit Model(CommandSink &sink);

  std::uint32_t prepare(PatchSpec &&patch);
  /** False when the token is unknown (stale). `when` < 0 means now. */
  bool commit(std::uint32_t token, double when);

  SetResult set(std::string_view path, const yyjson_val *value, double glide, double when);
  bool noteOn(int note, int vel, double when);
  bool noteOff(int note, double when);
  void panic(double when);

  /** Audio -> control events: frees handed-back objects, counts voice ends. */
  void onAudioEvent(const AudioEvent &e);

  double now() const;
  const ModelStats &stats() const { return stats_; }
  bool committed() const { return committedAny_; }
  std::string stateJson() const;

 private:
  bool send(Command c);
  std::int64_t frameFor(double when) const;
  double timeFor(double when) const;
  void attach(std::size_t slot, double when);
  void paramRamp(std::uint32_t target, double &tracked, double v, double t, double glide);

  CommandSink &sink_;
  std::uint32_t nextToken_ = 1;
  std::map<std::uint32_t, PatchSpec> plans_;
  PatchSpec active_;
  bool committedAny_ = false;
  double tracked_[4][2] = {};  // [slot][fader, pan]
  double trackedMaster_;
  ModelStats stats_;
};

}  // namespace rig
