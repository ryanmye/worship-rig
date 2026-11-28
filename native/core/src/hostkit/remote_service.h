// The browser remote's decisions (remote lane, D34 / D45; native/docs/lanes/REMOTE.md §2.3), with no sockets: pairing
// codes and tokens, brute-force and rate limits, the Lock gate, command mapping and dedupe, and the page's view of the
// bus state. Single-threaded: RemoteServer calls it from its poll thread only. Time and randomness are injected, so
// every rule is unit-tested with a fake clock (tests/hostkit/test_remote_service.cpp).
#pragma once
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace rig::hostkit::remote {

/** Limits (REMOTE.md §2.3). Defaults are the shipped values; tests shrink some. */
struct Limits {
  int codeDigits = 6;
  std::size_t maxTokens = 8;              // paired phones kept (least recently used dropped)
  int ipFailuresPerWindow = 5;            // wrong codes per peer IP per window
  int globalFailuresBeforeRotate = 20;    // wrong codes in total before the code rotates
  std::int64_t failureWindowMs = 60000;   // the per-IP window, and the first pause after a rotation
  std::int64_t maxPauseMs = 3600000;      // the pause doubles with each rotation up to this (skeptic-2 C3)
  std::int64_t pairWindowMs = 300000;     // pairing is open this long after switch-on / New code (skeptic-2 F3)
  std::int64_t failureDecayMs = 3600000;  // the global failure count starts over after this long without one (N4)
  double cmdRatePerSec = 10;              // per token
  double cmdBurst = 20;
  double reqRatePerSec = 30;              // per peer IP, every route
  double reqBurst = 60;
  std::int64_t dedupeMs = 30000;          // a repeated command id within this is answered, not run
  std::size_t dedupePerToken = 64;
  std::size_t maxTrackedIps = 256;        // per-IP tables are capped (oldest entry dropped)
  std::size_t songNameMax = 80;           // code points shown on the page
};

/** The page's commands (D34): nothing else is accepted. */
extern const char *const kPageCommands[7];

struct PairResult {
  int status = 200;         // 200 paired, 400 bad request, 403 wrong code / closed, 429 too many tries / paused
  std::string token;        // 200 only
  std::string error;        // 'bad-code-format' | 'wrong-code' | 'too-many-tries' | 'paused' | 'pairing-closed'
  int retryAfterSec = 0;    // 429 only
};

struct CommandResult {
  int status = 200;         // 200 (ok or a refusal the page shows), 400 bad request, 401 not paired, 429 rate limited
  bool ok = false;
  std::string error;        // 'locked' | 'not-ready' | 'bad-command' | 'bad-id' | 'not-paired' | 'rate-limited'
  bool repeated = false;    // answered from the first time this id was sent
  /** The bus command to hand to the main page (ok, and not a repeated id). */
  std::optional<std::string> bus;
  /** JSON reply for the page: {"ok":true} / {"ok":false,"error":"…"}, with "id". */
  std::string replyJson;
};

class Service {
 public:
  using NowMs = std::function<std::int64_t()>;
  using Random = std::function<void(std::uint8_t *, std::size_t)>;

  Service(Limits limits, NowMs now, Random random);

  // ---- pairing
  /** The current code (codeDigits digits, leading zeros kept). */
  const std::string &code() const { return code_; }
  /**
   * A fresh code; existing pairings stay. Bumps infoVersion(). `byUser` (Settings "New code"): also ends a pause
   * and resets the backoff, since a person at the Mac asked for it (skeptic-2 C4).
   */
  void newCode(bool byUser = false);
  /**
   * Open pairing for pairWindowMs (the remote switched on, Settings "New code"). Outside the window /api/pair answers
   * 'pairing-closed' without looking at the code: guessing is only possible while someone is at the Mac (skeptic-2
   * F3). Bumps infoVersion().
   */
  void openPairing();
  /** ms left in the pairing window, 0 = closed. */
  std::int64_t pairingMs() const;
  /** Try a code from `ip`. */
  PairResult pair(const std::string &ip, std::string_view code);
  /** Pairing paused after a rotation: ms left, 0 = not paused. */
  std::int64_t pausedMs() const;
  bool tokenValid(std::string_view token);
  /** tokenValid without counting as a use (an open WebSocket must not keep its token "recently used"). */
  bool hasToken(std::string_view token) const;
  /** Ends every pairing (Settings "Forget phones", the remote switched off). */
  void forgetAll();
  std::size_t pairedCount() const { return tokens_.size(); }
  /** Changes when the code, the paired count or the pause changes (the host refreshes Settings). */
  std::uint64_t infoVersion() const { return infoVersion_; }

  // ---- rate limit for every request from an IP
  bool allowRequest(const std::string &ip);

  // ---- state
  /**
   * A bus `state` JSON from the main page (checked with rig_bus's rules). An invalid state is ignored (returns
   * false) and the last good one stays. The view's seq advances only when what the page shows changed.
   */
  bool setState(std::string_view busStateJson);
  bool hasState() const { return hasState_; }
  std::uint64_t seq() const { return seq_; }
  /** {"seq":n,"ready":bool,"song":…,"snapshot":…,"snapshotN":…,"snapshotCount":n,"droneOn":b,"locked":b,"audio":…} */
  std::string viewJson() const;

  // ---- commands
  /** A page command body `{"cmd":"nextSong","id":"…"}` from a paired `token`. */
  CommandResult command(std::string_view token, std::string_view bodyJson);

 private:
  struct Bucket {
    double tokens = 0;
    std::int64_t at = 0;
  };
  struct Token {
    std::string value;
    std::int64_t lastUsed = 0;
    Bucket bucket;
    std::deque<std::pair<std::string, std::pair<std::int64_t, std::string>>> seen;  // id → (time, reply)
  };
  struct IpEntry {
    std::deque<std::int64_t> failures;
    Bucket bucket;
    std::int64_t touched = 0;
  };

  bool take(Bucket &b, double rate, double burst);
  IpEntry &ipEntry(const std::string &ip);
  Token *findToken(std::string_view token);
  std::string randomToken();
  CommandResult finish(Token *t, const std::string &id, CommandResult r);

  Limits lim_;
  NowMs now_;
  Random random_;
  std::string code_;
  int globalFailures_ = 0;
  int rotations_ = 0;  // automatic rotations since the last pairing or user "New code": the pause doubles
  std::int64_t lastFailure_ = 0;
  std::int64_t pairingUntil_ = 0;
  std::int64_t pausedUntil_ = 0;
  std::vector<Token> tokens_;
  std::map<std::string, IpEntry> ips_;
  std::uint64_t infoVersion_ = 1;

  bool hasState_ = false;
  std::uint64_t seq_ = 0;
  std::string viewBody_;  // the view without seq
  bool locked_ = false;
};

/** Constant-time comparison of two strings (length leaks; content does not). */
bool constantTimeEquals(std::string_view a, std::string_view b);

}  // namespace rig::hostkit::remote
