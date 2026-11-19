// WAV reader/writer: float32 (format 3), PCM 16/24/32 and float64 in, float32 or PCM16 out.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace rig::io {

struct WavData {
  double sampleRate = 0;
  std::vector<std::vector<float>> ch;  // ch[c][frame]
  std::size_t frames() const { return ch.empty() ? 0 : ch[0].size(); }
};

/** False with `err` set on I/O or format errors. */
bool readWav(const std::string &path, WavData &out, std::string *err = nullptr);
bool readWavMemory(const std::uint8_t *data, std::size_t size, WavData &out, std::string *err = nullptr);
/** float32 WAV with a `fact` chunk, like tools/golden/wav.mjs writes. */
bool writeWavF32(const std::string &path, const std::vector<std::vector<float>> &ch, double sampleRate,
                 std::string *err = nullptr);
/** 16-bit PCM with clipping (recorder format). */
bool writeWavPcm16(const std::string &path, const std::vector<std::vector<float>> &ch, double sampleRate,
                   std::string *err = nullptr);
std::vector<std::uint8_t> encodeWavF32(const std::vector<std::vector<float>> &ch, double sampleRate);

}  // namespace rig::io
