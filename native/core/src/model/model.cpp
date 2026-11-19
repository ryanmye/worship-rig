#include "model/model.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "bridge/json_out.h"
#include "graph/graph.h"
#include "params/params.h"
#include "time/automation.h"
#include "yyjson.h"

namespace rig {

Model::Model(CommandSink &sink) : sink_(sink) {
  const ParamRow *mv = findParam("master.volume");
  trackedMaster_ = mv ? mv->def : 0.5;
}

double Model::now() const { return static_cast<double>(sink_.renderedFrames()) / sink_.sampleRate(); }

std::int64_t Model::frameFor(double when) const {
  if (!(when >= 0.0)) return kFrameNow;
  const std::int64_t f = std::llround(when * sink_.sampleRate());
  return f <= sink_.renderedFrames() ? kFrameNow : f;
}

double Model::timeFor(double when) const {
  const std::int64_t f = frameFor(when);
  return f == kFrameNow ? now() : static_cast<double>(f) / sink_.sampleRate();
}

bool Model::send(Command c) {
  if (!sink_.send(c)) {
    ++stats_.droppedCommands;
    return false;
  }
  return true;
}

std::uint32_t Model::prepare(PatchSpec &&patch) {
  ++stats_.prepares;
  const std::uint32_t token = nextToken_++;
  plans_[token] = std::move(patch);
  while (plans_.size() > 8) plans_.erase(plans_.begin());  // superseded plans are dropped
  return token;
}

void Model::attach(std::size_t slot, double when) {
  Command c{};
  c.op = Op::AttachSlot;
  c.target = static_cast<std::uint32_t>(slot);
  c.frame = frameFor(when);
  c.p.ptr = new SlotSpec(active_.slots[slot].spec);
  if (!send(c)) delete static_cast<SlotSpec *>(c.p.ptr);
}

bool Model::commit(std::uint32_t token, double when) {
  auto it = plans_.find(token);
  if (it == plans_.end()) return false;
  active_ = it->second;
  ++stats_.commits;
  committedAny_ = true;
  const double t = timeFor(when);
  for (std::size_t i = 0; i < 4; ++i) {
    attach(i, when);
    const SlotPatch &sp = active_.slots[i];
    const double g = sp.present ? sp.gain : 0.0;
    // Fresh channel: the fader is *set* to the slot gain at the commit instant (contract 3.1), not ramped.
    Command c{};
    c.op = Op::ParamSet;
    c.frame = kFrameNow;
    c.f.a = g;
    c.f.b = t;
    c.target = pid::slot(static_cast<std::uint32_t>(i), pid::kFader);
    send(c);
    c.f.a = sp.pan;
    c.target = pid::slot(static_cast<std::uint32_t>(i), pid::kPan);
    send(c);
    tracked_[i][0] = g;
    tracked_[i][1] = sp.pan;
  }
  return true;
}

void Model::paramRamp(std::uint32_t target, double &tracked, double v, double t, double glide) {
  auto emit = [&](Op op, double a, double b, double c) {
    Command cmd{};
    cmd.op = op;
    cmd.frame = kFrameNow;
    cmd.target = target;
    cmd.f.a = a;
    cmd.f.b = b;
    cmd.f.c = c;
    send(cmd);
  };
  if (glide > 0.0) {  // trackedMove: linear glide from the tracked value
    emit(Op::ParamCancelHold, 0, t, 0);
    emit(Op::ParamSet, tracked, t, 0);
    emit(Op::ParamLinear, v, t + glide, 0);
  } else {  // rampTo: cancelAndHold + setTarget(tau 15 ms) + pinned end at t + 12 tau
    emit(Op::ParamCancelHold, 0, t, 0);
    emit(Op::ParamTarget, v, t, wa::kTau);
    emit(Op::ParamSet, v, t + wa::kRampSettleTc * wa::kTau, 0);
  }
  tracked = v;
}

SetResult Model::set(std::string_view path, const yyjson_val *value, double glide, double when) {
  int slot = 0;
  bool dynamic = false;
  const ParamRow *row = findParam(path, &slot, &dynamic);
  SetResult r;
  if (dynamic) {
    r.status = SetResult::NotApplied;
    r.message = "instrument params are not implemented in T00";
    return r;
  }
  if (!row) {
    r.status = SetResult::Unknown;
    r.message = "unknown param " + std::string(path);
    return r;
  }
  double v;
  if (!jsonToParamValue(*row, value, v)) {
    r.status = SetResult::Bad;
    r.message = "bad value for " + std::string(path);
    return r;
  }
  ++stats_.sets;
  const double t = timeFor(when);
  const std::string_view rp(row->path);
  if (rp == "slots.<i>.gain") {
    paramRamp(pid::slot(slot, pid::kFader), tracked_[slot][0], v, t, glide);
    active_.slots[slot].gain = v;
  } else if (rp == "slots.<i>.pan") {
    paramRamp(pid::slot(slot, pid::kPan), tracked_[slot][1], v, t, 0.0);
    active_.slots[slot].pan = v;
  } else if (rp == "master.volume") {
    paramRamp(pid::kMasterVolume, trackedMaster_, v, t, glide);
  } else if (rp.rfind("slots.<i>.eq.", 0) == 0 && committedAny_) {
    SlotEqSpec &eq = active_.slots[slot].spec.eq;
    const std::string_view f = rp.substr(13);
    if (f == "cutHz") eq.cutHz = v;
    else if (f == "hiCutHz") eq.hiCutHz = v;
    else if (f.size() > 3 && f[0] == 'b' && f[1] >= '1' && f[1] <= '8' && f[2] == '.') {
      EqBand &b = eq.bands[f[1] - '1'];
      const std::string_view k = f.substr(3);
      if (k == "on") b.on = v != 0.0;
      else if (k == "type") b.type = static_cast<int>(v);
      else if (k == "hz") b.hz = v;
      else if (k == "db") b.db = v;
      else if (k == "q") b.q = v;
    }
    attach(static_cast<std::size_t>(slot), when);  // step change; T02 adds the glide / chain crossfade
  } else {
    r.status = SetResult::NotApplied;
    r.message = "param is validated but its engine behaviour is not implemented yet";
  }
  return r;
}

bool Model::noteOn(int note, int vel, double when) {
  Command c{};
  c.op = Op::NoteOn;
  c.frame = frameFor(when);
  c.target = kAllSlots;
  c.aux = static_cast<std::uint32_t>(note & 0xff) | (static_cast<std::uint32_t>(std::clamp(vel, 0, 127)) << 8);
  ++stats_.notesOn;
  return send(c);
}

bool Model::noteOff(int note, double when) {
  Command c{};
  c.op = Op::NoteOff;
  c.frame = frameFor(when);
  c.target = kAllSlots;
  c.aux = static_cast<std::uint32_t>(note & 0xff);
  ++stats_.notesOff;
  return send(c);
}

void Model::panic(double when) {
  Command c{};
  c.op = Op::Panic;
  c.frame = frameFor(when);
  c.target = kAllSlots;
  send(c);
}

void Model::onAudioEvent(const AudioEvent &e) {
  switch (e.kind) {
    case EventKind::Garbage:
      if (e.aux == static_cast<std::uint32_t>(GarbageKind::SlotSpec)) delete static_cast<SlotSpec *>(e.ptr);
      else if (e.aux == static_cast<std::uint32_t>(GarbageKind::InjectBuffer)) delete static_cast<InjectBuffer *>(e.ptr);
      break;
    case EventKind::VoiceEnded:
      ++stats_.voicesEnded;
      break;
    default:
      break;
  }
}

std::string Model::stateJson() const {
  JsonOut j;
  j.begin().kvBool("committed", committedAny_);
  j.key("slots").beginArray();
  for (const auto &s : active_.slots) {
    j.begin().kvBool("present", s.present).kv("type", s.instType).kv("id", s.instId).kv("gain", s.gain).kv("pan", s.pan);
    j.end();
  }
  j.endArray().end();
  return j.take();
}

}  // namespace rig
