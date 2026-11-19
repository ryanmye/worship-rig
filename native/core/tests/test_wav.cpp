#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>

#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include "doctest.h"
#include "dr_wav.h"
#include "io/wav.h"

using namespace rig::io;

static std::string tmpdir() {
  const char *t = std::getenv("TMPDIR");
  return t ? t : "/tmp";
}

TEST_SUITE("wav") {
  static std::vector<std::vector<float>> ramp(size_t n) {
    std::vector<std::vector<float>> ch(2, std::vector<float>(n));
    for (size_t i = 0; i < n; ++i) {
      ch[0][i] = static_cast<float>(std::sin(i * 0.01)) * 0.9f;
      ch[1][i] = static_cast<float>(i) / static_cast<float>(n) * 2.0f - 1.0f;
    }
    return ch;
  }

  TEST_CASE("float32 write -> read is bit exact, in memory and on disk") {
    const auto ch = ramp(1000);
    const auto bytes = encodeWavF32(ch, 44100);
    WavData w;
    REQUIRE(readWavMemory(bytes.data(), bytes.size(), w));
    CHECK(w.sampleRate == 44100);
    CHECK(w.ch == ch);
    const std::string path = tmpdir() + "/rig_wav_roundtrip.wav";
    std::string err;
    REQUIRE(writeWavF32(path, ch, 48000, &err));
    WavData d;
    REQUIRE(readWav(path, d, &err));
    CHECK(d.ch == ch);
    CHECK(d.sampleRate == 48000);
    std::remove(path.c_str());
  }

  TEST_CASE("an independent reader (dr_wav) reads our float32 file") {
    const auto ch = ramp(500);
    const auto bytes = encodeWavF32(ch, 44100);
    drwav wav;
    REQUIRE(drwav_init_memory(&wav, bytes.data(), bytes.size(), nullptr));
    CHECK(wav.channels == 2);
    CHECK(wav.sampleRate == 44100);
    CHECK(wav.totalPCMFrameCount == 500);
    std::vector<float> inter(1000);
    CHECK(drwav_read_pcm_frames_f32(&wav, 500, inter.data()) == 500);
    drwav_uninit(&wav);
    for (size_t i = 0; i < 500; ++i) {
      CHECK(inter[2 * i] == ch[0][i]);
      CHECK(inter[2 * i + 1] == ch[1][i]);
    }
  }

  TEST_CASE("pcm16 write is read back within 2 lsb and clips") {
    auto ch = ramp(300);
    ch[0][10] = 3.0f;
    const std::string path = tmpdir() + "/rig_wav_pcm16.wav";
    REQUIRE(writeWavPcm16(path, ch, 44100));
    WavData d;
    REQUIRE(readWav(path, d));
    CHECK(d.frames() == 300);
    CHECK(d.ch[0][10] == doctest::Approx(1.0).epsilon(1e-4));
    for (size_t i = 11; i < 300; ++i)
      CHECK(std::fabs(d.ch[0][i] - ch[0][i]) < 2.0 / 32768.0);  // write scales by 32767, read by 32768
    std::remove(path.c_str());
  }

  TEST_CASE("garbage is rejected with an error, not a crash") {
    const std::uint8_t junk[] = {'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E'};
    WavData w;
    std::string err;
    CHECK(!readWavMemory(junk, sizeof junk, w, &err));
    CHECK(!err.empty());
    CHECK(!readWav("/nonexistent/file.wav", w, &err));
  }

  TEST_CASE("reads the committed golden stimulus and a golden smoke file") {
    WavData w;
    std::string err;
    REQUIRE(readWav(std::string(RIG_REPO_DIR) + "/native/golden/stimuli/impulse.wav", w, &err));
    CHECK(w.sampleRate == 44100);
    CHECK(w.frames() == 22050);
    REQUIRE(readWav(std::string(RIG_REPO_DIR) + "/native/golden/smoke/eq-peak-a.wav", w, &err));
    CHECK(w.ch.size() == 2);
    CHECK(w.frames() == 44100);
  }
}
