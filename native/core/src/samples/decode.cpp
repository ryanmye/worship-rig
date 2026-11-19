#include "samples/decode.h"

#include <cerrno>
#include <cstdio>
#include <cstring>

#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wconversion"
#pragma GCC diagnostic ignored "-Wshadow"
#pragma GCC diagnostic ignored "-Wpedantic"
#pragma GCC diagnostic ignored "-Wsign-conversion"
#pragma GCC diagnostic ignored "-Wunused-parameter"
#pragma GCC diagnostic ignored "-Wold-style-cast"
#pragma GCC diagnostic ignored "-Wcast-qual"
#endif
#include "dr_mp3.h"
#include "dr_wav.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

namespace rig::samples {
namespace {

DecodeResult fail(DecodeResult::Status s, std::string msg) {
  DecodeResult r;
  r.status = s;
  r.error = std::move(msg);
  return r;
}

void split(const float *inter, std::uint64_t frames, unsigned channels, double rate, Pcm &out) {
  out.sampleRate = rate;
  out.channels = channels >= 2 ? 2 : 1;
  const std::size_t n = static_cast<std::size_t>(frames);
  for (int c = 0; c < out.channels; ++c) out.ch[c].resize(n);
  for (std::size_t i = 0; i < n; ++i)
    for (int c = 0; c < out.channels; ++c) out.ch[c][i] = inter[i * channels + static_cast<unsigned>(c)];
  if (out.channels == 1) out.ch[1].clear();
}

bool isMp3(const std::uint8_t *d, std::size_t n) {
  if (n >= 3 && d[0] == 'I' && d[1] == 'D' && d[2] == '3') return true;
  return n >= 2 && d[0] == 0xFF && (d[1] & 0xE0) == 0xE0;
}
bool isWav(const std::uint8_t *d, std::size_t n) {
  return n >= 12 && !std::memcmp(d, "RIFF", 4) && !std::memcmp(d + 8, "WAVE", 4);
}

}  // namespace

DecodeResult decodeMemory(const std::uint8_t *data, std::size_t size, std::string_view ext, const HostDecodeFn &host,
                          const std::string &pathForHost) {
  if (size == 0) return fail(DecodeResult::Status::Permanent, "empty file");
  DecodeResult r;
  if (isWav(data, size) || (ext == ".wav" && !isMp3(data, size))) {
    unsigned channels = 0, rate = 0;
    drwav_uint64 frames = 0;
    float *pcm = drwav_open_memory_and_read_pcm_frames_f32(data, size, &channels, &rate, &frames, nullptr);
    if (!pcm || !channels || !frames) {
      if (pcm) drwav_free(pcm, nullptr);
      return fail(DecodeResult::Status::Permanent, "undecodable WAV");
    }
    split(pcm, frames, channels, rate, r.pcm);
    drwav_free(pcm, nullptr);
    r.status = DecodeResult::Status::Ok;
    return r;
  }
  if (isMp3(data, size) || ext == ".mp3") {
    drmp3_config cfg;
    drmp3_uint64 frames = 0;
    float *pcm = drmp3_open_memory_and_read_pcm_frames_f32(data, size, &cfg, &frames, nullptr);
    if (!pcm || !cfg.channels || !frames) {
      if (pcm) drmp3_free(pcm, nullptr);
      return fail(DecodeResult::Status::Permanent, "undecodable MP3");
    }
    split(pcm, frames, cfg.channels, cfg.sampleRate, r.pcm);
    drmp3_free(pcm, nullptr);
    r.status = DecodeResult::Status::Ok;
    return r;
  }
  if (host && !pathForHost.empty()) {
    std::string err;
    if (host(pathForHost, r.pcm, &err) && r.pcm.channels >= 1 && r.pcm.frames() > 0) {
      r.status = DecodeResult::Status::Ok;
      return r;
    }
    return fail(DecodeResult::Status::Permanent, err.empty() ? "host decode failed" : err);
  }
  return fail(DecodeResult::Status::Permanent, "unsupported format (no host decoder)");
}

DecodeResult decodeFile(const std::string &path, const HostDecodeFn &host) {
  std::string ext;
  const std::size_t dot = path.find_last_of('.');
  if (dot != std::string::npos) {
    ext = path.substr(dot);
    for (char &c : ext) c = static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c);
  }
  // Container formats the core cannot read go straight to the host (no point reading them into memory here).
  if (ext == ".m4a" || ext == ".aac" || ext == ".caf" || ext == ".alac" || ext == ".mp4") {
    if (!host) return fail(DecodeResult::Status::Permanent, "unsupported format (no host decoder)");
    return decodeMemory(reinterpret_cast<const std::uint8_t *>(""), 1, ext, host, path);
  }
  std::FILE *f = std::fopen(path.c_str(), "rb");
  if (!f) {
    const bool gone = errno == ENOENT || errno == ENOTDIR || errno == EACCES;
    return fail(gone ? DecodeResult::Status::Permanent : DecodeResult::Status::Transient,
                std::string("cannot open: ") + std::strerror(errno));
  }
  std::vector<std::uint8_t> bytes;
  std::uint8_t buf[1 << 16];
  std::size_t n;
  while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) bytes.insert(bytes.end(), buf, buf + n);
  const bool bad = std::ferror(f) != 0;
  std::fclose(f);
  if (bad) return fail(DecodeResult::Status::Transient, "read error");
  return decodeMemory(bytes.data(), bytes.size(), ext, host, path);
}

}  // namespace rig::samples
