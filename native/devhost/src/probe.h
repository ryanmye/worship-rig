// rig-probe: the Mac audio measurement behind DECISIONS D2 (is 64 frames safe?) and D4 (the 'auto' total voice
// limit), run unattended by tools/mac/check.sh (native/docs/MAC_CHECK.md). It drives the real core through the dev
// host's AudioHost on the default output device with the OUTPUT MUTED (the core renders and is timed, then zeros go
// to the device: nothing is audible; system volume and the default device are never touched).
//
//   1. For each requested buffer (64, 128, 256, 512 frames): open the device, record the granted period, rate and
//      latency, render a typical 4-slot song holding a chord for `bufferSeconds`, report callbacks, late callbacks,
//      the core's xrun counter and the callback time p50 / p99 / max.
//   2. Load sweep at 128 frames, per kind (synth = T11 inst.synth, sampler = T12 bundled set): 16 slots of that
//      instrument, polyphony 128, total voice limit off, more held notes per step until the callback p99 exceeds
//      `stopFraction` of the period. Fit: callback time = fixed16 + perVoice x voices.
//   3. auto_voice_limit_suggestion = ARCHITECTURE 7.1's formula with the costliest kind:
//      floor16((0.60 x quantum - fixed16) / perVoice).
// On Linux it runs on miniaudio's null backend (ctest `probe.null`), which proves the plumbing and the JSON, not
// the numbers.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace devhost {

struct ProbeOptions {
  std::string repoDir;                         // repository root (app/ = samples and manifests)
  std::string backend = "auto";                // miniaudio backend (auto = Core Audio on macOS)
  std::vector<std::uint32_t> buffers{64, 128, 256, 512};
  double bufferSeconds = 10.0;                 // measured window per buffer size
  double settleSeconds = 0.5;                  // after a device (re)open or a chord, before the window
  std::vector<std::string> kinds{"synth", "sampler"};
  std::string synthId = "warm-pad";            // the costliest synth.js voice measured so far (ARCHITECTURE 7.1)
  std::string samplerId = "upright-piano";     // a bundled, layered piano (app/samples/manifest.json)
  std::uint32_t sweepBuffer = 128;
  std::vector<std::uint32_t> notesPerSlot{0, 1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128};  // x 16 slots
  double stepSeconds = 1.0;                    // measured window per sweep step
  double stepSettleSeconds = 0.4;              // note-on burst and attacks out of the window
  double targetFraction = 0.60;                // D4: the render at or under ~60 % of the quantum
  double stopFraction = 0.80;                  // the sweep stops once p99 is above this share of the period
  double prepareTimeoutSeconds = 120.0;        // a sampler prepare decodes the whole instrument first
  // CORE1 test hook (mackit O1): false = load each song cold, prepare + commit with no `cache preload`, then wait for
  // `get sampleStatus` (the realtime control loop must pump the cache). A timeout is an error; the sweep still runs.
  bool preload = true;
  bool verbose = true;                         // progress lines on stderr
};

/** Core Audio's view of the default output device (macOS only; ok = false elsewhere). Read-only queries. */
struct AppleOutputLatency {
  bool ok = false;
  std::string name, transport;  // transport: four-char code ('bltn' built-in, 'usb ', 'blue' Bluetooth, ...)
  double nominalRate = 0;
  std::uint32_t bufferFrameSize = 0;  // kAudioDevicePropertyBufferFrameSize (the I/O size in force right now)
  std::uint32_t deviceLatency = 0, safetyOffset = 0, streamLatency = 0;  // frames, output scope
};
AppleOutputLatency appleDefaultOutputLatency();

/** Runs the whole probe; `json` gets the report (also on a partial failure: see its `errors`). False = no report. */
bool runProbe(const ProbeOptions &o, std::string *json, std::string *err);

}  // namespace devhost
