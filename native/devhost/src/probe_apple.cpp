// rig-probe: Core Audio's own latency figures for the default output device (macOS). UNTESTED: written on Linux
// without a Mac (compiled there only as the stub below). Read-only property queries: nothing here sets a property,
// so the default device, its volume and its buffer size are never changed by this file. Built with -Wno-error
// (CMakeLists.txt) so an Apple SDK deprecation cannot fail the probe build on the first Mac run.
#include "probe.h"

#if defined(__APPLE__)
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>

#include <vector>

namespace devhost {

namespace {

template <class T>
bool getProp(AudioObjectID obj, AudioObjectPropertySelector sel, AudioObjectPropertyScope scope, T *out) {
  const AudioObjectPropertyAddress a{sel, scope, kAudioObjectPropertyElementMain};
  UInt32 size = sizeof(T);
  return AudioObjectGetPropertyData(obj, &a, 0, nullptr, &size, out) == noErr;
}

std::string fourCC(UInt32 v) {
  std::string s(4, ' ');
  for (int i = 0; i < 4; ++i) {
    const char c = static_cast<char>((v >> (24 - 8 * i)) & 0xff);
    s[static_cast<std::size_t>(i)] = (c >= 32 && c < 127) ? c : '?';
  }
  return s;
}

}  // namespace

AppleOutputLatency appleDefaultOutputLatency() {
  AppleOutputLatency r;
  AudioObjectID dev = kAudioObjectUnknown;
  if (!getProp(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal,
               &dev) ||
      dev == kAudioObjectUnknown) {
    return r;
  }
  r.ok = true;
  Float64 rate = 0;
  if (getProp(dev, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, &rate)) r.nominalRate = rate;
  UInt32 u = 0;
  if (getProp(dev, kAudioDevicePropertyBufferFrameSize, kAudioObjectPropertyScopeGlobal, &u)) r.bufferFrameSize = u;
  if (getProp(dev, kAudioDevicePropertyLatency, kAudioObjectPropertyScopeOutput, &u)) r.deviceLatency = u;
  if (getProp(dev, kAudioDevicePropertySafetyOffset, kAudioObjectPropertyScopeOutput, &u)) r.safetyOffset = u;
  if (getProp(dev, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, &u)) r.transport = fourCC(u);
  // the first output stream's own latency (contract latencyMs = base + output: device + safety + stream + buffer)
  const AudioObjectPropertyAddress sa{kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput,
                                      kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(dev, &sa, 0, nullptr, &size) == noErr && size >= sizeof(AudioStreamID)) {
    std::vector<AudioStreamID> ids(size / sizeof(AudioStreamID));
    if (AudioObjectGetPropertyData(dev, &sa, 0, nullptr, &size, ids.data()) == noErr &&
        getProp(ids[0], kAudioStreamPropertyLatency, kAudioObjectPropertyScopeGlobal, &u)) {
      r.streamLatency = u;
    }
  }
  CFStringRef name = nullptr;
  if (getProp(dev, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, &name) && name) {
    char b[256];
    if (CFStringGetCString(name, b, sizeof b, kCFStringEncodingUTF8)) r.name = b;
    CFRelease(name);
  }
  return r;
}

}  // namespace devhost

#else

namespace devhost {
AppleOutputLatency appleDefaultOutputLatency() { return {}; }
}  // namespace devhost

#endif
