#include "io/wav.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace rig::io {
namespace {

struct Rd {
  const std::uint8_t *p;
  std::size_t n;
  std::uint32_t u32(std::size_t o) const {
    std::uint32_t v;
    std::memcpy(&v, p + o, 4);
    return v;
  }
  std::uint16_t u16(std::size_t o) const {
    std::uint16_t v;
    std::memcpy(&v, p + o, 2);
    return v;
  }
};

void put32(std::vector<std::uint8_t> &b, std::uint32_t v) {
  for (int i = 0; i < 4; ++i) b.push_back(static_cast<std::uint8_t>((v >> (8 * i)) & 255u));
}
void put16(std::vector<std::uint8_t> &b, std::uint16_t v) {
  b.push_back(static_cast<std::uint8_t>(v & 255u));
  b.push_back(static_cast<std::uint8_t>(v >> 8));
}
void putTag(std::vector<std::uint8_t> &b, const char *t) {
  for (int i = 0; i < 4; ++i) b.push_back(static_cast<std::uint8_t>(t[i]));
}

bool fail(std::string *err, const char *m) {
  if (err) *err = m;
  return false;
}

bool writeFile(const std::string &path, const std::vector<std::uint8_t> &b, std::string *err) {
  std::FILE *f = std::fopen(path.c_str(), "wb");
  if (!f) return fail(err, "cannot open file for writing");
  const bool ok = std::fwrite(b.data(), 1, b.size(), f) == b.size();
  std::fclose(f);
  return ok || fail(err, "short write");
}

}  // namespace

bool readWavMemory(const std::uint8_t *d, std::size_t size, WavData &out, std::string *err) {
  Rd r{d, size};
  if (size < 12 || std::memcmp(d, "RIFF", 4) != 0 || std::memcmp(d + 8, "WAVE", 4) != 0) return fail(err, "not a WAV");
  std::size_t o = 12;
  unsigned fmtTag = 0, nch = 0, bits = 0;
  std::uint32_t sr = 0;
  const std::uint8_t *data = nullptr;
  std::size_t dataBytes = 0;
  while (o + 8 <= size) {
    const std::uint32_t len = r.u32(o + 4);
    const std::size_t body = o + 8;
    if (std::memcmp(d + o, "fmt ", 4) == 0 && body + 16 <= size) {
      fmtTag = r.u16(body);
      nch = r.u16(body + 2);
      sr = r.u32(body + 4);
      bits = r.u16(body + 14);
      if (fmtTag == 0xfffe && len >= 26 && body + 26 <= size) fmtTag = r.u16(body + 24);  // extensible sub-format
    } else if (std::memcmp(d + o, "data", 4) == 0) {
      data = d + body;
      dataBytes = std::min<std::size_t>(len, size - body);
    }
    o = body + len + (len & 1);
  }
  if (!data || nch == 0 || nch > 8) return fail(err, "missing fmt/data chunk");
  const unsigned bps = bits / 8;
  if (bps == 0 ||
      !((fmtTag == 1 && (bits == 16 || bits == 24 || bits == 32)) || (fmtTag == 3 && (bits == 32 || bits == 64))))
    return fail(err, "unsupported sample format");
  const std::size_t frames = dataBytes / (bps * nch);
  out.sampleRate = sr;
  out.ch.assign(nch, std::vector<float>(frames));
  for (std::size_t i = 0; i < frames; ++i) {
    for (unsigned c = 0; c < nch; ++c) {
      const std::uint8_t *s = data + (i * nch + c) * bps;
      float v;
      if (fmtTag == 3 && bits == 32) {
        std::memcpy(&v, s, 4);
      } else if (fmtTag == 3) {
        double dv;
        std::memcpy(&dv, s, 8);
        v = static_cast<float>(dv);
      } else if (bits == 16) {
        std::int16_t x;
        std::memcpy(&x, s, 2);
        v = x / 32768.0f;
      } else if (bits == 24) {
        const std::int32_t x = (s[0] << 8) | (s[1] << 16) | (static_cast<std::int32_t>(s[2]) << 24);
        v = static_cast<float>(x / 2147483648.0);
      } else {
        std::int32_t x;
        std::memcpy(&x, s, 4);
        v = static_cast<float>(x / 2147483648.0);
      }
      out.ch[c][i] = v;
    }
  }
  return true;
}

bool readWav(const std::string &path, WavData &out, std::string *err) {
  std::FILE *f = std::fopen(path.c_str(), "rb");
  if (!f) return fail(err, "cannot open file");
  std::vector<std::uint8_t> b;
  std::uint8_t buf[65536];
  std::size_t n;
  while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) b.insert(b.end(), buf, buf + n);
  std::fclose(f);
  return readWavMemory(b.data(), b.size(), out, err);
}

std::vector<std::uint8_t> encodeWavF32(const std::vector<std::vector<float>> &ch, double sampleRate) {
  const std::uint32_t nch = static_cast<std::uint32_t>(ch.size());
  const std::uint32_t n = ch.empty() ? 0 : static_cast<std::uint32_t>(ch[0].size());
  const std::uint32_t dataBytes = n * nch * 4;
  std::vector<std::uint8_t> b;
  b.reserve(12 + 26 + 12 + 8 + dataBytes);
  putTag(b, "RIFF");
  put32(b, 4 + 26 + 12 + 8 + dataBytes);
  putTag(b, "WAVE");
  putTag(b, "fmt ");
  put32(b, 18);
  put16(b, 3);
  put16(b, static_cast<std::uint16_t>(nch));
  put32(b, static_cast<std::uint32_t>(sampleRate));
  put32(b, static_cast<std::uint32_t>(sampleRate) * nch * 4);
  put16(b, static_cast<std::uint16_t>(nch * 4));
  put16(b, 32);
  put16(b, 0);
  putTag(b, "fact");
  put32(b, 4);
  put32(b, n);
  putTag(b, "data");
  put32(b, dataBytes);
  for (std::uint32_t i = 0; i < n; ++i)
    for (std::uint32_t c = 0; c < nch; ++c) {
      std::uint8_t t[4];
      std::memcpy(t, &ch[c][i], 4);
      b.insert(b.end(), t, t + 4);
    }
  return b;
}

bool writeWavF32(const std::string &path, const std::vector<std::vector<float>> &ch, double sr, std::string *err) {
  return writeFile(path, encodeWavF32(ch, sr), err);
}

bool writeWavPcm16(const std::string &path, const std::vector<std::vector<float>> &ch, double sr, std::string *err) {
  const std::uint32_t nch = static_cast<std::uint32_t>(ch.size());
  const std::uint32_t n = ch.empty() ? 0 : static_cast<std::uint32_t>(ch[0].size());
  const std::uint32_t dataBytes = n * nch * 2;
  std::vector<std::uint8_t> b;
  putTag(b, "RIFF");
  put32(b, 36 + dataBytes);
  putTag(b, "WAVE");
  putTag(b, "fmt ");
  put32(b, 16);
  put16(b, 1);
  put16(b, static_cast<std::uint16_t>(nch));
  put32(b, static_cast<std::uint32_t>(sr));
  put32(b, static_cast<std::uint32_t>(sr) * nch * 2);
  put16(b, static_cast<std::uint16_t>(nch * 2));
  put16(b, 16);
  putTag(b, "data");
  put32(b, dataBytes);
  for (std::uint32_t i = 0; i < n; ++i)
    for (std::uint32_t c = 0; c < nch; ++c) {
      const float v = std::clamp(ch[c][i], -1.0f, 1.0f);
      put16(b, static_cast<std::uint16_t>(static_cast<std::int16_t>(std::lrintf(v * 32767.0f))));
    }
  return writeFile(path, b, err);
}

}  // namespace rig::io
