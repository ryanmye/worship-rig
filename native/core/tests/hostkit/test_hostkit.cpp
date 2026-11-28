// rig_hostkit unit tests (lane N1): the JS-semantics helpers and the patch-pack scanner's rules on small trees made
// in a temp folder. Expected texts were produced by server.js / Node 22 (noted per case); the node parity test
// (test/unit/hostkit/parity.test.mjs, ctest unit.hostkit-parity) compares whole generated trees.
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdlib>
#include <fstream>
#include <string>

#include "doctest.h"
#include "js_json.h"
#include "js_text.h"
#include "patches.h"
#include "rig/rig_hostkit.h"
#include "sha1.h"

using namespace rig::hostkit;

namespace {

std::string roundTrip(const std::string &text, bool *ok = nullptr) {
  const ParseResult r = jsonParse(decodeUtf8(text), 64);
  if (ok) *ok = r.ok;
  if (!r.ok) return "ERR";
  std::string out;
  jsonStringify(r.value, out);
  return out;
}

/** A temp folder, removed at the end of the test. */
struct TempDir {
  std::string path;
  TempDir() {
    char tmpl[] = "/tmp/rig hostkit test-XXXXXX";  // a space on purpose
    // realpath: on macOS /tmp is a link to /private/tmp, and the scanner reports pack folders by their real path
    char *real = ::realpath(::mkdtemp(tmpl), nullptr);
    path = real;
    std::free(real);
  }
  ~TempDir() {
    const std::string cmd = "rm -rf '" + path + "'";
    if (std::system(cmd.c_str()) != 0) MESSAGE("could not remove " << path);
  }
  std::string file(const std::string &rel, const std::string &body) const {
    const std::string p = path + "/" + rel;
    mkdirs(p.substr(0, p.rfind('/')));
    std::ofstream(p, std::ios::binary) << body;
    return p;
  }
  static void mkdirs(const std::string &dir) {
    for (std::size_t i = 1; i <= dir.size(); ++i) {
      if (i == dir.size() || dir[i] == '/') ::mkdir(dir.substr(0, i).c_str(), 0755);
    }
  }
};

void setMtime(const std::string &p, long sec, long nsec) {
  struct timespec ts[2] = {{sec, nsec}, {sec, nsec}};
  REQUIRE(::utimensat(AT_FDCWD, p.c_str(), ts, 0) == 0);
}

std::string scan(const std::string &rootsJson, const char *ids = nullptr) {
  char *s = rig_hostkit_scan_patches(rootsJson.c_str(), ids);
  REQUIRE(s != nullptr);
  std::string out(s);
  rig_hostkit_free(s);
  return out;
}

std::string q(const std::string &s) {
  std::string o;
  jsonQuote(s, o);
  return o;
}

const char *kSong = R"({"app":"worship-rig","kind":"song","schema":2,"song":{"name":"S","patch":{}}})";

}  // namespace

TEST_SUITE("hostkit-json") {
  TEST_CASE("JSON.stringify(JSON.parse(x)) as V8 (expected texts from Node 22)") {
    CHECK(roundTrip(R"({"b":1,"a":2,"b":3,"1":4,"01":5,"4294967295":6,"4294967294":7,"__proto__":8})") ==
          R"({"1":4,"4294967294":7,"b":3,"a":2,"01":5,"4294967295":6,"__proto__":8})");
    CHECK(roundTrip(R"("\ud800x\udc00")") == R"("\ud800x\udc00")");
    CHECK(roundTrip(R"("\uD83C\uDFB9\u00e9\u0001\u001f\u2028\/")") ==
          "\"\xF0\x9F\x8E\xB9\xC3\xA9\\u0001\\u001f\xE2\x80\xA8/\"");
    CHECK(roundTrip("[1e400,-1e400,-0,5.0,1e21,1e-7,123456789012345678901234,0.000001,2.2250738585072011e-308]") ==
          "[null,null,0,5,1e+21,1e-7,1.2345678901234569e+23,0.000001,2.225073858507201e-308]");
    CHECK(roundTrip("[0.1,1.5e300,-1.25e-9,100,1e20,123e-20,9007199254740993,4.9e-324]") ==
          "[0.1,1.5e+300,-1.25e-9,100,100000000000000000000,1.23e-18,9007199254740992,5e-324]");
    CHECK(roundTrip(" \t\r\n[true , false,null ] ") == "[true,false,null]");
  }
  TEST_CASE("JSON.parse rejects what V8 rejects") {
    for (const char *bad :
         {"",          " ",       "\xEF\xBB\xBF{}", "[1,]", "{\"a\":1,}", "01",  "1.",        ".5", "+1",   "1e", "NaN",
          "\"a\x01\"", "\"\\x\"", "\"\\u12G4\"",    "[1]x", "\f1",        "tru", "{\"a\" 1}", "[",  "\"abc"}) {
      bool ok = true;
      roundTrip(bad, &ok);
      CHECK_MESSAGE(!ok, bad);
    }
    CHECK(jsonParse("{\"a\":1,}").error ==
          "Expected double-quoted property name in JSON at position 7 (line 1 column 8)");
    CHECK(jsonParse("[1,]").error == "Unexpected token ']', \"[1,]\" is not valid JSON");
    CHECK(jsonParse("\r\n[0 1]").error ==
          "Expected ',' or ']' after array element in JSON at position 5 (line 2 column 4)");
    CHECK(jsonParse("NaN").error == "\"NaN\" is not valid JSON");
  }
  TEST_CASE("deeperThan(v, 64): 64 nested arrays pass, 65 do not; deep containers become null") {
    const std::string ok64 = std::string(64, '[') + std::string(64, ']');
    const std::string deep65 = std::string(65, '[') + std::string(65, ']');
    CHECK_FALSE(jsonParse(ok64, 64).tooDeep);
    CHECK(jsonParse(deep65, 64).tooDeep);
    const ParseResult r = jsonParse("{\"a\":[[[1]]],\"b\":2}", 2);
    REQUIRE(r.ok);
    CHECK(r.tooDeep);
    std::string out;
    jsonStringify(r.value, out);
    CHECK(out == R"({"a":[null],"b":2})");
    CHECK(jsonParse(std::string(200000, '[') + std::string(200000, ']'), 64).tooDeep);  // iterative: no recursion
  }
  TEST_CASE("Number.prototype.toString") {
    CHECK(jsNumberToString(1767341045678.0) == "1767341045678");
    CHECK(jsNumberToString(-0.0) == "0");
    CHECK(jsNumberToString(1e21) == "1e+21");
    CHECK(jsNumberToString(123456789012345680000.0) == "123456789012345680000");
    CHECK(jsNumberToString(0.000001) == "0.000001");
    CHECK(jsNumberToString(1.5e-7) == "1.5e-7");
    CHECK(jsNumberToString(72.5) == "72.5");
  }
  TEST_CASE("sha1 (FIPS 180 vectors and node:crypto)") {
    CHECK(sha1Hex("") == "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    CHECK(sha1Hex("abc") == "a9993e364706816aba3e25717850c26c9cd0d89d");
    CHECK(sha1Hex(std::string(55, 'a')) == "c1c8bbdc22796e28c0e15163d20899b65621d65a");
    CHECK(sha1Hex(std::string(56, 'a')) == "c2db330f6083854c99d4b5bfb6e8f29f201be699");
    CHECK(sha1Hex(std::string(64, 'a')) == "0098ba824b5c16427bd7a1122a5a442a25ec644d");
    CHECK(sha1Hex("\xF0\x9F\x8E\xB9\xC3\xA9") == "0eca34ccfdeefc4bc2975a68c8f7e384db600cc3");
  }
}

TEST_SUITE("hostkit-text") {
  TEST_CASE("Node's UTF-8 decode (WHATWG: one U+FFFD per maximal invalid subpart)") {
    CHECK(decodeUtf8("a\xFF"
                     "b") ==
          "a\xEF\xBF\xBD"
          "b");
    CHECK(decodeUtf8("\xED\xA0\x80") == "\xEF\xBF\xBD\xEF\xBF\xBD\xEF\xBF\xBD");
    CHECK(decodeUtf8("\xF0\x90\"") == "\xEF\xBF\xBD\"");
    CHECK(decodeUtf8("\xC3") == "\xEF\xBF\xBD");
    CHECK(decodeUtf8("\xEF\xBB\xBF"
                     "x") ==
          "\xEF\xBB\xBF"
          "x");  // the BOM stays
  }
  TEST_CASE(".length, .slice(0, n), .trim()") {
    CHECK(jsLength("a\xF0\x9F\x8E\xB9") == 3);
    CHECK(jsSliceStart("a\xF0\x9F\x8E\xB9"
                       "b",
                       2) == "a\xED\xA0\xBC");  // a lone high surrogate, as JS leaves it
    CHECK(q(jsSliceStart("a\xF0\x9F\x8E\xB9"
                         "b",
                         2)) == "\"a\\ud83c\"");
    CHECK(jsSliceStart("abc", 10) == "abc");
    CHECK(jsTrim("\xE3\x80\x80 \t\xC2\xA0x y\xEF\xBB\xBF\n") == "x y");
    CHECK(jsTrim("\xE2\x80\x8B"
                 "x") ==
          "\xE2\x80\x8B"
          "x");  // U+200B is not white space
  }
  TEST_CASE("localeCompare(numeric, base): ICU order of the names packs use") {
    CHECK(jsLocaleCompare("song2.json", "song10.json") < 0);
    CHECK(jsLocaleCompare("Pack 1", "pack 1") == 0);
    CHECK(jsLocaleCompare("01", "1") == 0);
    CHECK(jsLocaleCompare("\xC3\xA9tude", "etude") == 0);  // accents are secondary
    CHECK(jsLocaleCompare("e\xCC\x81", "\xC3\xA9") == 0);  // NFD = NFC
    CHECK(jsLocaleCompare("\xC3\x9F", "ss") == 0);         // expansion
    CHECK(jsLocaleCompare("a b", "ab") < 0);               // space is not ignorable in root
    CHECK(jsLocaleCompare("_x", "-x") < 0);
    CHECK(jsLocaleCompare("\xF0\x9F\x8E\xB9", "1") < 0);  // symbols before digits
    CHECK(jsLocaleCompare("9", "a") < 0);
    CHECK(jsLocaleCompare("\xEA\xB0\x80\xE6\xBC\xA2", "\xEA\xB0\x81") > 0);  // Hangul as jamo: 가漢 > 각
    CHECK(jsLocaleCompare("\xD9\xA3", "3") == 0);                            // Arabic-Indic three
  }
}

TEST_SUITE("hostkit-scan") {
  TEST_CASE("one pack, a song file and an array (expected JSON from server.js)") {
    TempDir t;
    const std::string a = t.file("root A/Pack \xC3\xA9/songs/one.json",
                                 R"({"app":"worship-rig","kind":"song","schema":2,"song":{"name":"Lantern","id":"x",)"
                                 R"("patch":{"slots":[{}]}},"bank":{"title":"Lantern"}})");
    const std::string b =
        t.file("root A/Pack \xC3\xA9/songs/list.json", R"([{"name":"A","patch":{}},{"name":5,"patch":{}}])");
    setMtime(a, 1767341045, 678000000);
    setMtime(b, 1767341045, 678000000);
    const std::string want =
        R"({"patches":[{"packId":"Pack é:list.json#0","pack":"Pack é","file":"list.json","n":0,"mtime":1767341045678,)"
        R"("hash":"be2e97a5c5de76f7","mode":"auto","song":{"name":"A","patch":{}}},{"packId":"Pack é:one.json",)"
        R"("pack":"Pack é","file":"one.json","n":null,"mtime":1767341045678,"hash":"0da22d54cbc8542f","mode":"auto",)"
        R"("song":{"name":"Lantern","patch":{"slots":[{}]}},"schema":2,"bank":{"title":"Lantern"}}],"packs":[{"slug":)"
        R"("Pack é","mode":"auto","songs":2,"files":2}],"errors":["Pack é/songs/list.json #1: \"name\" must be text; )"
        R"(skipped"]})";
    CHECK(scan("[" + q(t.path + "/root A") + "]") == want);
    CHECK(rig_hostkit_has_patches(("[" + q(t.path + "/root A") + "]").c_str()) == 1);
    char *route = rig_hostkit_user_patches_json(("[" + q(t.path + "/root A") + "]").c_str(), nullptr);
    CHECK(std::string(route) == R"({"app":"worship-rig","kind":"user-patches","enabled":true,)" + want.substr(1));
    rig_hostkit_free(route);
  }

  TEST_CASE("pack.json: missing, invalid, not an object, too large, bad mode, a folder; name trimmed and cut") {
    TempDir t;
    const auto pack = [&](const std::string &slug, const char *pj) {
      t.file("r/" + slug + "/songs/s.json", kSong);
      if (pj) t.file("r/" + slug + "/pack.json", pj);
    };
    pack("a-none", nullptr);
    pack("b-invalid", "{");
    pack("c-array", "[]");
    pack("d-big", (std::string("{\"mode\":\"bank\"}") + std::string(70000, ' ')).c_str());
    pack("e-mode", R"({"mode":"weird"})");
    pack("f-name", (R"({"mode":"bank","name":"  )" + std::string(130, 'n') + R"( "})").c_str());
    pack("g-dir", nullptr);
    TempDir::mkdirs(t.path + "/r/g-dir/pack.json");
    const std::string out = scan("[" + q(t.path + "/r") + "]");
    CHECK(out.find(R"("b-invalid/pack.json: Expected property name or '}' in JSON at position 1 (line 1 column 2); )"
                   R"(read as \"auto\"")") != std::string::npos);
    CHECK(out.find(
              R"("c-array/pack.json: pack.json must be an object such as {\"mode\": \"bank\"}; read as \"auto\"")") !=
          std::string::npos);
    CHECK(out.find(R"("d-big/pack.json: pack.json is too large; read as \"auto\"")") != std::string::npos);
    CHECK(out.find(R"("e-mode/pack.json: \"mode\" must be \"auto\" or \"bank\"; read as \"auto\"")") !=
          std::string::npos);
    CHECK(out.find(R"({"slug":"f-name","mode":"bank","songs":1,"files":1,"name":")" + std::string(120, 'n') + "\"}") !=
          std::string::npos);
    CHECK(out.find(R"("g-dir/pack.json: EISDIR: illegal operation on a directory, read; read as \"auto\"")") !=
          std::string::npos);
    CHECK(out.find("a-none/pack.json") == std::string::npos);  // missing = auto, silently
  }

  TEST_CASE("song files: non-JSON names, invalid JSON, BOM, too large, nested too deeply, links, folders") {
    TempDir t;
    const std::string s = "r/P/songs/";
    t.file(s + "ok.json", kSong);
    t.file(s + "notes.txt", "x");
    t.file(s + ".hidden.json", kSong);
    t.file(s + "bad.json", "{\"kind\":");
    t.file(s + "bom.json", std::string("\xEF\xBB\xBF") + kSong);
    t.file(s + "huge.json", std::string(kSong) + std::string(1100 * 1000, ' '));
    t.file(s + "deep.json", "{\"song\":{\"patch\":{},\"x\":" + std::string(70, '[') + std::string(70, ']') + "}}");
    t.file("outside.json", kSong);
    REQUIRE(::symlink((t.path + "/outside.json").c_str(), (t.path + "/" + s + "out.json").c_str()) == 0);
    REQUIRE(::symlink("ok.json", (t.path + "/" + s + "in.json").c_str()) == 0);
    REQUIRE(::symlink("gone.json", (t.path + "/" + s + "dangling.json").c_str()) == 0);
    TempDir::mkdirs(t.path + "/" + s + "folder.json");
    TempDir::mkdirs(t.path + "/r/P/songs/nested/deeper");  // not read: songs/ is not recursive
    t.file(s + "nested/deeper/x.json", kSong);
    const std::string out = scan("[" + q(t.path + "/r") + "]");
    CHECK(out.find("\"packId\":\"P:ok.json\"") != std::string::npos);
    CHECK(out.find("\"packId\":\"P:in.json\"") != std::string::npos);
    CHECK(out.find("notes.txt") == std::string::npos);
    CHECK(out.find("hidden") == std::string::npos);
    CHECK(out.find("folder.json") == std::string::npos);
    CHECK(out.find("nested/") == std::string::npos);
    CHECK(out.find(R"("P/songs/bad.json: not valid JSON (Unexpected end of JSON input); skipped")") !=
          std::string::npos);
    CHECK(
        out.find(
            R"("P/songs/bom.json: not valid JSON (Unexpected token '﻿', \"﻿{\"app\":\"w\"... is not valid JSON); )"
            R"(skipped")") != std::string::npos);
    CHECK(out.find(R"("P/songs/huge.json: is larger than 1 MB; skipped")") != std::string::npos);
    CHECK(out.find(R"("P/songs/deep.json: nested too deeply; skipped")") != std::string::npos);
    CHECK(out.find(R"("P/songs/out.json: is a link to a file outside the pack; skipped")") != std::string::npos);
    CHECK(out.find("\"P/songs/dangling.json: ENOENT: no such file or directory, realpath '" + t.path +
                   "/r/P/songs/dangling.json'; skipped\"") != std::string::npos);
    CHECK(out.find(R"({"slug":"P","mode":"auto","songs":2,"files":2})") != std::string::npos);
  }

  TEST_CASE("roots: earlier wins a slug, links out of a root, ':' and long names, unicode, missing roots") {
    TempDir t;
    t.file("one/Cedar/songs/a.json", kSong);
    t.file("two/Cedar/songs/b.json", kSong);
    t.file("two/Instruments/manifest.json", "{}");
    t.file("one/col:on/songs/c.json", kSong);
    t.file("one/\xED\x95\x9C\xEA\xB8\x80 \xF0\x9F\x8E\xB9/songs/\xE8\xB5\x9E\xE7\xBE\x8E.json", kSong);
    t.file("elsewhere/E/songs/e.json", kSong);
    REQUIRE(::symlink((t.path + "/elsewhere/E").c_str(), (t.path + "/one/E-link").c_str()) == 0);
    const std::string longSlug = std::string(39, 'L') + "\xF0\x9F\x8E\xB9" + std::string(170, 'x');
    t.file("one/" + longSlug + "/songs/l.json", kSong);
    const std::string roots = "[" + q(t.path + "/one") + "," + q(t.path + "/two/") + "," + q(t.path + "/missing") + "]";
    const std::string out = scan(roots);
    CHECK(out.find("\"" + t.path +
                   "/two/Cedar: a pack named \\\"Cedar\\\" was already found in an earlier folder; skipped\"") !=
          std::string::npos);
    CHECK(out.find("\"" + t.path + "/one/E-link: is a link to a folder outside My Samples (" + t.path +
                   "/elsewhere/E); skipped\"") != std::string::npos);
    CHECK(out.find(R"("col:on: a pack folder name must not contain \":\"; skipped")") != std::string::npos);
    // .slice(0, 40) cuts the emoji's surrogate pair: JSON.stringify escapes the lone half
    CHECK(out.find("\"" + std::string(39, 'L') +
                   "\\ud83c\xE2\x80\xA6: a pack folder name must be at most 200 characters; skipped\"") !=
          std::string::npos);
    CHECK(out.find("\"packId\":\"\xED\x95\x9C\xEA\xB8\x80 \xF0\x9F\x8E\xB9:\xE8\xB5\x9E\xE7\xBE\x8E.json\"") !=
          std::string::npos);
    CHECK(out.find("Instruments") == std::string::npos);  // a pack without songs is not a patch pack
    CHECK(rig_hostkit_has_patches(roots.c_str()) == 1);
    CHECK(rig_hostkit_has_patches(("[" + q(t.path + "/two/Instruments") + "]").c_str()) == 0);
    CHECK(rig_hostkit_has_patches("[]") == 0);
    CHECK(rig_hostkit_has_patches("not json") == 0);
  }

  TEST_CASE("user: instruments are checked only when ids are given") {
    TempDir t;
    t.file("r/U/songs/u.json",
           R"({"name":"U","patch":{"slots":[{"instrument":{"id":"user:a"}},{"instrument":{"id":"user:b"}}]}})");
    const std::string roots = "[" + q(t.path + "/r") + "]";
    CHECK(scan(roots).find("which no My Samples pack has") == std::string::npos);
    CHECK(scan(roots, "null").find("which no My Samples pack has") == std::string::npos);
    const std::string out = scan(roots, R"(["user:a"])");
    CHECK(out.find(R"("U/songs/u.json: uses \"user:b\", which no My Samples pack has; it will not sound")") !=
          std::string::npos);
    CHECK(out.find("user:a\\\", which") == std::string::npos);
  }

  TEST_CASE("caps: files per pack, songs per file, songs in all, bytes in all") {
    TempDir t;
    for (int i = 0; i < 202; ++i) t.file("r/Files/songs/f" + std::to_string(i) + ".json", R"({"patch":{}})");
    std::string list = "[";
    for (int i = 0; i < 101; ++i) list += std::string(i ? "," : "") + R"({"patch":{}})";
    t.file("r/List/songs/l.json", list + "]");
    const std::string out = scan("[" + q(t.path + "/r") + "]");
    CHECK(out.find(R"("Files/songs: more than 200 files; only the first 200 are read")") != std::string::npos);
    CHECK(out.find(R"("List/songs/l.json: more than 100 songs; only the first 100 are read")") != std::string::npos);
    CHECK(out.find(R"({"slug":"Files","mode":"auto","songs":200,"files":200})") != std::string::npos);
    CHECK(out.find(R"({"slug":"List","mode":"auto","songs":100,"files":1})") != std::string::npos);
  }

  TEST_CASE("paths: path.resolve and path.join") {
    CHECK(jsPathResolve("/a/b/../c/./d/") == "/a/c/d");
    CHECK(jsPathResolve("/") == "/");
    CHECK(jsPathResolve("//x//y") == "/x/y");
    CHECK(jsPathJoin("/a/", "b") == "/a/b");
    CHECK(jsPathJoin("/", "b") == "/b");
  }
}
