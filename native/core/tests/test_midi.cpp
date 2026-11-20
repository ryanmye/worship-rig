// T07: MIDI parser against the real midi.js (tools/golden/vectors/data/midi-parse.txt, tools/golden/vectors/
// dump-midi.mjs), applyVelocitySens against controller.js, the port table, the direct perform path (controller.js
// refcount / pedal / CC rules) and the "midi" service through the bridge and Model::midiBytes/midiPorts.
#include <cstdlib>
#include <cstring>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "api/engine.h"
#include "doctest.h"
#include "helpers.h"
#include "midi/midi_parser.h"
#include "midi/midi_route.h"
#include "midi/midi_service.h"
#include "midi/port_table.h"
#include "num_vectors.h"
#include "yyjson.h"

using namespace rigtest;
using namespace rig::midi;

namespace {

std::vector<std::uint8_t> hexBytes(const std::string &h) {
  std::vector<std::uint8_t> b;
  if (h == "-") return b;
  for (std::size_t i = 0; i + 1 < h.size(); i += 2)
    b.push_back(static_cast<std::uint8_t>(std::stoul(h.substr(i, 2), nullptr, 16)));
  return b;
}

std::string hex(double v) {
  char b[20];
  std::snprintf(b, sizeof b, "%016llx", static_cast<unsigned long long>(rigvec::bits(v)));
  return b;
}

/** midi.js event lines for one chunk (the order _parseBytes emits them). */
std::vector<std::string> parseChunk(Parser &p, const std::string &port, const std::vector<std::uint8_t> &bytes) {
  std::vector<std::string> out;
  if (bytes.empty()) return out;  // _parseBytes(Uint8Array[]) emits nothing
  if (Parser::isInput(bytes.data(), bytes.size())) out.push_back("input " + port);
  p.parse(port == "a" ? 1u : 2u, bytes.data(), bytes.size(), [&](const RawMessage &m) {
    Event e{};
    if (!dispatch(m.bytes[0], m.bytes[1], m.bytes[2], e)) return;
    std::ostringstream s;
    switch (e.type) {
      case Event::NoteOn:
        s << "noteon " << e.note << ' ' << e.velocity << ' ' << e.channel;
        break;
      case Event::NoteOff:
        s << "noteoff " << e.note << ' ' << e.velocity << ' ' << e.channel;
        break;
      case Event::Cc:
        s << "cc " << e.cc << ' ' << e.value << ' ' << hex(e.value01) << ' ' << e.channel;
        break;
      case Event::Bend:
        s << "bend " << hex(e.bend) << ' ' << e.raw << ' ' << e.channel;
        break;
      case Event::Program:
        s << "program " << e.program << ' ' << e.channel;
        break;
    }
    out.push_back(s.str());
  });
  return out;
}

struct FakePerform final : Perform {
  std::vector<std::string> log;
  void noteOn(int note, int vel, double, const yyjson_val *touch) override {
    log.push_back("on " + std::to_string(note) + " " + std::to_string(vel) + (touch ? " touch" : ""));
  }
  void noteOff(int note, double) override { log.push_back("off " + std::to_string(note)); }
  void sustain(bool down, double) override { log.push_back(down ? "pedal down" : "pedal up"); }
  void wheel(const char *src, double v, double) override { log.push_back(std::string("wheel ") + src + " " + hex(v)); }
  void bend(double v, double) override { log.push_back("bend " + hex(v)); }
};

Event note(bool on, int n, int vel, int ch = 0) {
  Event e{};
  e.type = on ? Event::NoteOn : Event::NoteOff;
  e.note = n;
  e.velocity = vel;
  e.channel = ch;
  return e;
}
Event cc(int c, int v, int ch = 0) {
  Event e{};
  e.type = Event::Cc;
  e.cc = c;
  e.value = v;
  e.value01 = v / 127.0;
  e.channel = ch;
  return e;
}

void configure(Router &r, FakePerform &p, const char *json) {
  yyjson_doc *d = yyjson_read(json, std::strlen(json), 0);
  REQUIRE(d);
  r.configure(yyjson_doc_get_root(d), p, -1);
  yyjson_doc_free(d);
}

std::vector<std::string> events(const std::vector<std::string> &msgs, const char *type) {
  std::vector<std::string> out;
  auto one = [&](yyjson_val *v) {
    const char *ev = yyjson_get_str(yyjson_obj_get(v, "ev"));
    const char *ty = yyjson_get_str(yyjson_obj_get(v, "type"));
    if (!ev || !ty || std::strcmp(ev, "midi") != 0 || std::strcmp(ty, type) != 0) return;
    char *s = yyjson_val_write(v, 0, nullptr);
    out.emplace_back(s);
    std::free(s);
  };
  for (const std::string &m : msgs) {
    yyjson_doc *d = yyjson_read(m.data(), m.size(), 0);
    if (!d) continue;
    yyjson_val *root = yyjson_doc_get_root(d);
    if (yyjson_is_arr(root)) {
      std::size_t i, n;
      yyjson_val *v;
      yyjson_arr_foreach(root, i, n, v) one(v);
    } else {
      one(root);
    }
    yyjson_doc_free(d);
  }
  return out;
}

}  // namespace

TEST_SUITE("midi") {
  TEST_CASE("parser = midi.js _parseBytes/_dispatch on random streams (running status, sysex, realtime, chunks)") {
    const auto all = rigvec::lines("midi-parse.txt");
    REQUIRE(all.size() > 5000);
    Parser p;
    std::vector<std::string> expect, got;
    std::size_t chunks = 0, evs = 0, mism = 0;
    auto flush = [&] {
      if (expect != got) ++mism;
      CHECK(expect == got);
      expect.clear();
      got.clear();
    };
    bool any = false;
    for (const std::string &l : all) {
      const auto t = rigvec::split(l);
      if (t[0] == "chunk") {
        if (any) flush();
        any = true;
        ++chunks;
        got = parseChunk(p, t[1], hexBytes(t[2]));
      } else if (t[0] == "bendvalue") {
        CHECK(hex(bendValue(std::stoi(t[1]), std::stoi(t[2]))) == t[3]);
      } else if (t[0] == "velsens") {
        CHECK(applyVelocitySens(rigvec::hexToDouble(t[2]), t[1]) == std::stoi(t[3]));
      } else {
        expect.push_back(l);
        ++evs;
      }
    }
    if (any) flush();
    CHECK(mism == 0);
    CHECK(chunks == 1200);
    MESSAGE("midi parser: " << chunks << " chunks, " << evs << " events, " << mism << " mismatching chunks");
  }

  TEST_CASE("port table: stable indexes in order of first appearance, vanished inputs, legacy hash, JSON") {
    PortTable t;
    std::vector<std::string> gone;
    CHECK_FALSE(t.update("{}", 2, gone));
    const std::string r1 = R"([{"id":"11","name":"Keystation 49","manufacturer":"M-Audio","state":"connected",
      "kind":"input"},{"id":"12","name":"IAC Bus 1","manufacturer":"Apple Inc.","state":"connected","kind":"output"},
      {"id":"13","name":"Nord","state":"connected","kind":"input"}])";
    REQUIRE(t.update(r1.data(), r1.size(), gone));
    CHECK(gone.empty());
    CHECK(t.wireId("11") == 0);
    CHECK(t.wireId("13") == 2);
    CHECK(t.byWire(1)->name == "IAC Bus 1");
    CHECK(t.byWire(PortTable::legacyHash("13"))->id == "13");  // rig_midi_in before T08's index table
    CHECK(t.firstOutput()->id == "12");
    CHECK(t.byName("Nord", true)->id == "13");
    // 13 unplugged, 11 reported disconnected, a new port: indexes stay, both inputs vanish
    const std::string r2 = R"([{"id":"14","name":"New","state":"connected","kind":"input"},
      {"id":"11","name":"Keystation 49","state":"disconnected","kind":"input"}])";
    REQUIRE(t.update(r2.data(), r2.size(), gone));
    CHECK(gone == std::vector<std::string>{"11", "13"});
    CHECK(t.wireId("14") == 3);
    CHECK(t.wireId("13") == 2);
    CHECK(t.firstOutput() == nullptr);
    const std::string j = t.json();
    CHECK(contains(j, R"({"id":"14","name":"New","manufacturer":"","state":"connected","kind":"input"})"));
    CHECK(contains(j, R"("id":"11")"));
    CHECK_FALSE(contains(j, R"("id":"13")"));  // absent from the last report
  }

  TEST_CASE("direct path: per-source refcount, duplicates, pedal OR + invert, CC120/123, wheels, learned") {
    Router r;
    FakePerform p;
    CHECK_FALSE(r.handle(p, "a", "", note(true, 60, 100), -1));  // off by default
    configure(r, p, R"({"on":true,"velocitySens":"hard","learn":{"nextSong":{"note":36,"channel":9},
      "fader":{"cc":21}}})");
    CHECK(r.on());
    CHECK(r.handle(p, "a", "", note(true, 60, 64), -1));
    CHECK(r.handle(p, "a", "", note(true, 60, 64), -1));      // duplicate from the same source: ignored
    CHECK(r.handle(p, "b", "", note(true, 60, 100), -1));     // second source holds it too: no re-strike
    CHECK(r.handle(p, "a", "", note(true, 60, 90, 1), -1));   // channel 1 is another source
    CHECK(r.handle(p, "a", "", note(false, 60, 0), -1));
    CHECK(r.handle(p, "a", "", note(false, 60, 0, 1), -1));
    CHECK(r.sounding() == 1);
    CHECK(r.handle(p, "b", "", note(false, 60, 0), -1));      // the last holder releases
    CHECK(r.sounding() == 0);
    CHECK_FALSE(r.handle(p, "a", "", note(true, 36, 100, 9), -1));  // learned button: the controller's
    CHECK(r.handle(p, "a", "", note(true, 36, 100, 3), -1));        // other channel: plays
    CHECK_FALSE(r.handle(p, "a", "", cc(21, 5), -1));               // learned fader (any channel)
    CHECK(r.handle(p, "a", "", cc(1, 127), -1));
    CHECK(r.handle(p, "a", "", cc(11, 0), -1));
    CHECK(r.handle(p, "a", "", cc(7, 64), -1));
    CHECK_FALSE(r.handle(p, "a", "", cc(74, 64), -1));  // unmapped CC: JS
    // pedals: OR across ports
    CHECK(r.handle(p, "a", "", cc(64, 127), -1));
    CHECK(r.handle(p, "b", "", cc(64, 100), -1));
    CHECK(r.handle(p, "a", "", cc(64, 0), -1));
    CHECK(r.pedalDown());
    CHECK(r.handle(p, "b", "", cc(64, 63), -1));
    CHECK_FALSE(r.pedalDown());
    // CC123 releases that source's notes only
    r.handle(p, "a", "", note(true, 40, 50), -1);
    r.handle(p, "a", "", note(true, 41, 50), -1);
    r.handle(p, "a", "", note(true, 42, 50, 2), -1);
    CHECK(r.handle(p, "a", "", cc(123, 0), -1));
    CHECK(r.sounding() == 2);  // 36 (ch 3) and 42 (ch 2)
    // hot-plug: every channel of the port and its pedal
    r.handle(p, "a", "", cc(64, 127), -1);
    r.releaseSource(p, "a", -1);
    CHECK(r.sounding() == 0);
    CHECK_FALSE(r.pedalDown());
    // pedalInvert: a reversed pedal at rest (raw up) sustains; flipping the setting may only release
    configure(r, p, R"({"pedalInvert":true})");
    r.handle(p, "a", "", cc(64, 0), -1);
    CHECK(r.pedalDown());
    configure(r, p, R"({"pedalInvert":false})");
    CHECK_FALSE(r.pedalDown());
    configure(r, p, R"({"pedalInvert":true})");
    CHECK_FALSE(r.pedalDown());  // never starts sustaining by itself
    // touch curve by device name: raw velocity + the curve
    configure(r, p, R"({"touch":{"Nord":{"shape":"soft","min":1,"max":127}}})");
    Event e = note(true, 70, 33);
    r.handle(p, "c", "Nord", e, -1);
    Event b{};
    b.type = Event::Bend;
    b.bend = -1;
    CHECK(r.handle(p, "a", "", b, -1));
    const std::vector<std::string> expect = {
        "on 60 42", "off 60", "on 36 87", "wheel mod 3ff0000000000000", "wheel expr 0000000000000000",
        "wheel vol " + hex(64 / 127.0), "pedal down", "pedal up", "on 40 29", "on 41 29", "on 42 29", "off 40",
        "off 41", "pedal down", "off 42", "off 36", "pedal up", "pedal down", "pedal up", "on 70 33 touch",
        "bend bff0000000000000"};
    CHECK(p.log == expect);
  }

  TEST_CASE("service: messages forwarded with handled flag, listen filter, ports event, hot-plug release") {
    OfflineEngine e(48000);
    e.hello();
    rig::Engine &eng = *reinterpret_cast<rig::Engine *>(e.e);
    rig::Model &m = eng.model();
    REQUIRE(m.service(rig::MidiService::kName) != nullptr);
    const std::string ports = R"([{"id":"k1","name":"Keys","state":"connected","kind":"input"},
      {"id":"o1","name":"Clock Out","state":"connected","kind":"output"}])";
    e.msgs.clear();
    CHECK(rig_host_midi_ports(e.e, ports.data(), ports.size()) == RIG_OK);  // T08 interns, the service diffs
    eng.flush();
    REQUIRE(events(e.msgs, "ports").size() == 1);
    CHECK(contains(events(e.msgs, "ports")[0], R"("id":"o1","name":"Clock Out")"));
    // running status split over two chunks, a clock byte inside, from port index 0 (k1)
    const std::uint8_t a[] = {0x90, 60, 0xf8, 100, 61};
    const std::uint8_t b[] = {0, 0xb0, 64, 127};
    e.msgs.clear();
    m.midiBytes(0, a, sizeof a, 0);
    m.midiBytes(0, b, sizeof b, 0);
    eng.flush();
    auto msgs = events(e.msgs, "msg");
    REQUIRE(msgs.size() == 3);
    CHECK(contains(msgs[0], R"("port":"k1","data":[144,60,100],"ts":0,"handled":false)"));
    CHECK(contains(msgs[1], R"("data":[144,61,0])"));
    CHECK(contains(msgs[2], R"("data":[176,64,127])"));
    // direct path on: handled
    std::string r = e.call(R"({"v":1,"op":"midi","id":5,"action":"route","on":true})");
    CHECK(contains(r, R"("result":{"on":true})"));
    const std::uint8_t c[] = {0x91, 62, 80};
    e.msgs.clear();
    m.midiBytes(0, c, sizeof c, 0);
    eng.flush();
    msgs = events(e.msgs, "msg");
    REQUIRE(msgs.size() == 1);
    CHECK(contains(msgs[0], R"("handled":true)"));
    auto *svc = dynamic_cast<MidiServiceImpl *>(m.service(rig::MidiService::kName));
    REQUIRE(svc);
    CHECK(svc->router().sounding() == 1);
    // hot-plug: k1 disappears -> its note is released, a ports event goes out
    const std::string ports2 = R"([{"id":"o1","name":"Clock Out","state":"connected","kind":"output"}])";
    rig_host_midi_ports(e.e, ports2.data(), ports2.size());
    CHECK(svc->router().sounding() == 0);
    // listen: only listed ids are forwarded
    r = e.call(R"({"v":1,"op":"midi","id":6,"action":"listen","ids":["k2"]})");
    CHECK(contains(r, R"("result":{"ports":[)"));
    e.msgs.clear();
    m.midiBytes(0, c, sizeof c, 0);
    eng.flush();
    CHECK(events(e.msgs, "msg").empty());
    // send without a host: not sent; bad request shapes
    r = e.call(R"({"v":1,"op":"midi","id":7,"action":"send","port":"o1","data":[248]})");
    CHECK(contains(r, R"("sent":false)"));
    r = e.call(R"({"v":1,"op":"midi","id":8,"action":"nope"})");
    CHECK(contains(r, R"("ok":false)"));
    CHECK(contains(m.statsJson(), R"("midi":{"forwarded":4)"));
  }
}
