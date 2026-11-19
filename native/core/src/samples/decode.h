// File decode (M10): dr_mp3 (MP3), dr_wav (WAV), host hook for everything else (AAC/M4A/ALAC, filled by Apple).
// Runs on a decode worker (realtime) or inline (offline); never on the audio thread.
#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <string_view>
#include <vector>

namespace rig::samples {

/** Decoded PCM at the file's own rate, non-interleaved float32; 1 or 2 channels (more: the first two are kept). */
struct Pcm {
  double sampleRate = 0;
  int channels = 0;
  std::vector<float> ch[2];
  std::size_t frames() const { return ch[0].size(); }
};

/** Host decoder hook (rig_host.decode_file): true on success. Thread-safe. */
using HostDecodeFn = std::function<bool(const std::string &path, Pcm &out, std::string *err)>;

struct DecodeResult {
  enum class Status { Ok, Transient, Permanent } status = Status::Permanent;
  std::string error;
  Pcm pcm;
  bool ok() const { return status == Status::Ok; }
};

/** Read + decode a file. Missing files and undecodable content are Permanent, other I/O errors Transient. */
DecodeResult decodeFile(const std::string &path, const HostDecodeFn &host);
/** Decode a memory image; `ext` (".mp3", ".wav", lower case, may be empty) is a hint, content sniffing decides. */
DecodeResult decodeMemory(const std::uint8_t *data, std::size_t size, std::string_view ext, const HostDecodeFn &host,
                          const std::string &pathForHost = {});

}  // namespace rig::samples
