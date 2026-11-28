// `--self-test` (or RIG_SELFTEST=1): a UI-less launch of the macOS app that checks its first-launch path end to end
// and exits 0 (pass) or 1 (fail) after printing one JSON line to stdout (native/docs/MAC_CHECK.md "Self-test", E4).
// Written for the GitHub Actions macOS runner, which has no audio device, no MIDI and nobody watching. UNBUILT on
// Linux: nothing in this file has been compiled before CI runs it.
//
//   "Worship Rig.app/Contents/MacOS/Worship Rig" --self-test            (tools/mac/check.sh --stage selftest)
//
// What it does, in order (each step is one entry of `checks`; `required: false` entries are reported, not gated):
//   engine     rig_create succeeded (realtime core, desktop profile)
//   load       rig://app/index.html finished loading (WKNavigationDelegate didFinish)
//   hello      the page's BridgeEngine sent `hello` and the core replied ok, protocol 1, minor >= requiredMinor
//   boot       window.__rig.ready resolved and the engine object is a BridgeEngine (the native path, not Web Audio)
//   store      window.__rig.store exists, state.schema == 2, the factory library is seeded
//   shell      (lane N0) window.rig is the native shell's (shell 'native', isElectron false), getInfo().version is
//              the bundle's CFBundleShortVersionString, and the controller merged recording() / library() into
//              __rigShell without dropping menu() / menuReady() (the first-launch import needs both)
//   audio      the page's `audio start` reached the shell and the null output rendered frames without errors
//   note       (not required) a note-on through the core made signal on the null output (peak > -100 dBFS)
//   migration  (only with RIG_ELECTRON_BACKUPS) the RigLibrary first-launch offer against that folder, answered Yes
//              without a dialog, replaced the library with the backup (marker song present, schema 2). The fixture
//              folder also holds a newer, truncated rotation file: RigBackups.latestAnywhere must skip it and serve
//              the older good one (review E5 open item 3); serving it would leave the marker out and fail this step
//   packs      (lane N1) patch packs from My Samples: no /api/user-patches request while there is no pack; then two
//              packs written under <temp>/Samples (built from the current song by `packsProbe`, names with spaces
//              and non-ASCII): /api/health says userPatches, controller.rescanPatchPacks takes the auto song into the
//              library, the Song bank lists the 2 bank songs, Add to library works, no pack errors
//   midi       (not required) the CoreMIDI client was created
//   webcontent the WebContent process did not terminate
//   console    zero console.error / uncaught errors / unhandled rejections / resource or CSP errors on the page
//   http       zero rig:// responses with status >= 400
// Hard limit: RigSelfTest.budget seconds (60), then a `timedOut` result and exit 1.
//
// Isolation (it may also run on Ryan's Mac from check.sh): the web view uses a non-persistent data store (no
// localStorage left behind), the shell's folders (backups, recordings, My Samples) move to a temporary directory, the migration
// answer is not written to UserDefaults, Application Support is never scanned (only RIG_ELECTRON_BACKUPS), and audio
// goes to rig_apple_null_sink (no device is opened). CoreMIDI is created as in the real app (it opens no port).
import Foundation
import WebKit
#if os(macOS)
import AppKit
import CoreMIDI
#endif

/// What RigHost and its delegates report to the self-test. Every member is called on the main thread. nil members
/// and a nil hooks object (the normal app) cost nothing.
final class RigSelfTestHooks {
    var pageFinished: ((URL?) -> Void)?
    var pageFailed: ((String) -> Void)?
    var contentTerminated: (() -> Void)?
    /// a message body the page posted on `webkit.messageHandlers.rig` (object or array), before it goes to the core
    var outgoing: ((Any) -> Void)?
    /// one batch of core events / replies (JSON texts) as it is handed to the page
    var incoming: (([String]) -> Void)?
    /// every rig:// response: URL string and HTTP status
    var httpStatus: ((String, Int) -> Void)?
    /// `webkit.messageHandlers.rigSelfTest` posts from `RigSelfTestScripts.pageHook`
    var pageMessage: ((Any) -> Void)?
}

final class RigSelfTestMessageHandler: NSObject, WKScriptMessageHandler {
    let hooks: RigSelfTestHooks
    init(_ hooks: RigSelfTestHooks) { self.hooks = hooks }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        hooks.pageMessage?(message.body)
    }
}

/// JavaScript of the self-test. Raw strings (#"""..."""#): no Swift escapes or interpolation inside, so
/// test/unit/selftest/selftest-scripts.test.mjs can lift each body out of this file and run it under node.
enum RigSelfTestScripts {
    /// Document start, before every page script (self-test only): counts what Chromium would log as an error.
    /// console.error calls, uncaught errors, failed resource loads (capture phase), unhandled rejections and CSP
    /// violations. Each is posted to `rigSelfTest` and kept in window.__rigSelfTest.errors (first 50).
    static let pageHook = #"""
    (function () {
      var w = window;
      var h = w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.rigSelfTest;
      if (!h || w.__rigSelfTest) return;
      var st = w.__rigSelfTest = { errors: [], count: 0 };
      function text(args) {
        try {
          return Array.prototype.map.call(args, function (x) {
            if (x instanceof Error) return String(x.stack || x);
            if (x && typeof x === 'object') { try { return JSON.stringify(x); } catch (e) { return String(x); } }
            return String(x);
          }).join(' ').slice(0, 400);
        } catch (e) { return '(unprintable)'; }
      }
      function report(kind, msg) {
        st.count += 1;
        if (st.errors.length < 50) st.errors.push(kind + ': ' + msg);
        try { h.postMessage({ kind: kind, text: String(msg).slice(0, 400) }); } catch (e) { /* page unloading */ }
      }
      var orig = w.console && w.console.error;
      if (orig) {
        w.console.error = function () {
          report('console.error', text(arguments));
          return orig.apply(w.console, arguments);
        };
      }
      w.addEventListener('error', function (ev) {
        var t = ev && ev.target;
        if (t && t !== w && (t.src || t.href)) report('resource', String(t.src || t.href));
        else report('error', String((ev && ev.message) || 'error') + ' @ ' + ((ev && ev.filename) || '?') + ':' +
                    ((ev && ev.lineno) || 0));
      }, true);
      w.addEventListener('unhandledrejection', function (ev) {
        var r = ev && ev.reason;
        report('unhandledrejection', String((r && (r.stack || r.message)) || r));
      });
      w.addEventListener('securitypolicyviolation', function (ev) {
        report('csp', String(ev.violatedDirective) + ' ' + String(ev.blockedURI));
      });
    })();
    """#

    /// callAsyncJavaScript body, arguments `phase`, `timeoutMs` (lane N1). phase 'export': the pack files to write
    /// (relative path -> text), built from the current song's export so they are valid songs by construction.
    /// phase 'check': health's flags, a Rescan, the Song bank and one Add to library. Returns a JSON string.
    static let packsProbe = #"""
    const rig = window.__rig || {};
    const { controller, store } = rig;
    if (!controller || !store || typeof controller.rescanPatchPacks !== 'function') {
      return JSON.stringify({ error: 'no __rig.controller / store' });
    }
    if (phase === 'export') {
      const base = JSON.parse(store.exportSong(store.get().settings.currentSongId, { pretty: false }));
      const one = (name, bank) => JSON.stringify({ app: 'worship-rig', kind: 'song', schema: base.schema,
        song: { ...base.song, id: undefined, name }, ...(bank ? { bank } : {}) });
      return JSON.stringify({ files: {
        'N1 Auto \u00c4/songs/auto song.json': one('N1 self-test auto'),
        'N1 Bank/pack.json': JSON.stringify({ mode: 'bank', name: 'N1 self-test bank' }),
        'N1 Bank/songs/bank 1.json': one('N1 bank one', { title: 'N1 bank one', originalKey: 'G', bpm: 72 }),
        'N1 Bank/songs/bank 2.json': one('N1 bank two', { title: 'N1 bank two', artist: 'Self-test' }),
      } });
    }
    const t0 = Date.now();
    const res = await window.fetch('./api/health', { cache: 'no-store' });
    const h = res.ok ? await res.json() : {};
    const r = await Promise.race([controller.rescanPatchPacks(),
      new Promise((ok) => setTimeout(() => ok(null), timeoutMs))]);
    const p = controller.patchPacks();
    const st = store.get();
    const names = st.songOrder.map((id) => st.songs[id] && st.songs[id].name);
    const item = (p.bank || []).find((b) => b.title === 'N1 bank one');
    const add = item ? controller.addFromBank(item.packId) : { ok: false, error: 'not in the bank' };
    const after = store.get();
    return JSON.stringify({
      userPatches: h.userPatches === true, features: h.features || [], rescanned: !!r,
      added: r ? r.added.length : null, songs: p.songs, packs: p.packs, bankSongs: p.bankSongs,
      bank: (p.bank || []).map((b) => b.title), errors: p.errors || [], skipped: r ? r.skipped : null,
      autoInLibrary: names.includes('N1 self-test auto'), addOk: !!add.ok, addError: add.error || null,
      addedName: add.ok && after.songs[add.id] ? after.songs[add.id].name : null, ms: Date.now() - t0,
    });
    """#

    /// callAsyncJavaScript body, argument `timeoutMs`: waits for main.js's `__rig.ready` (controller.start: audio
    /// start + the current song), then describes the library and the engine. Returns a JSON string.
    static let bootProbe = #"""
    const t0 = Date.now();
    const deadline = t0 + timeoutMs;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    while (!(window.__rig && window.__rig.ready)) {
      if (Date.now() > deadline) return JSON.stringify({ phase: 'no-__rig', ms: Date.now() - t0 });
      await sleep(100);
    }
    let readyError = null;
    const phase = await Promise.race([
      Promise.resolve(window.__rig.ready).then(() => 'ok', (e) => {
        readyError = String((e && e.message) || e);
        return 'rejected';
      }),
      sleep(Math.max(0, deadline - Date.now())).then(() => 'timeout'),
    ]);
    const out = { phase, readyError, ms: Date.now() - t0 };
    try {
      const s = window.__rig.store;
      const st = s && typeof s.get === 'function' ? s.get() : null;
      out.store = !!st;
      out.schema = st ? st.schema : null;
      out.songs = st && Array.isArray(st.songOrder) ? st.songOrder.length : null;
      out.pristine = s ? s.pristine : null;
      out.loadStatus = s && s.loadInfo ? s.loadInfo.status : null;
      out.currentSongId = st && st.settings ? st.settings.currentSongId || null : null;
      const e = window.__rig.engine;
      out.engineKind = e && e.constructor ? e.constructor.name : null;
      out.visibility = typeof document !== 'undefined' ? document.visibilityState : null;
      out.userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : null;
    } catch (err) {
      out.probeError = String((err && err.message) || err);
    }
    return JSON.stringify(out);
    """#

    /// callAsyncJavaScript body (lane N0), no arguments: the native shell's window.rig and __rigShell after boot.
    /// Returns a JSON string.
    static let shellProbe = #"""
    const out = {};
    try {
      const r = window.rig || null;
      out.shell = r ? r.shell || null : null;
      out.isElectron = r ? r.isElectron : null;
      out.platform = r ? r.platform || null : null;
      out.menuOwnsShortcuts = r ? r.menuOwnsShortcuts : null;
      const s = window.__rigShell || null;
      out.menu = !!(s && typeof s.menu === 'function');
      out.menuReady = !!(s && typeof s.menuReady === 'function' && s.menuReady());
      out.merged = !!(s && typeof s.recording === 'function' && typeof s.library === 'function');
      const info = r && typeof r.getInfo === 'function' ? await r.getInfo() : null;
      out.version = info && !info.error ? info.version || null : null;
      out.infoError = info ? info.error || null : 'no getInfo';
    } catch (err) {
      out.probeError = String((err && err.message) || err);
    }
    return JSON.stringify(out);
    """#

    /// callAsyncJavaScript body, arguments `marker` and `timeoutMs`: waits until a song named `marker` is in the
    /// library (the migration probe's import landed). Returns a JSON string.
    static let importProbe = #"""
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = window.__rig && window.__rig.store;
      const st = s ? s.get() : null;
      const hit = !!st && st.songOrder.some((id) => st.songs[id] && st.songs[id].name === marker);
      if (hit || Date.now() > deadline) {
        return JSON.stringify({
          hit, schema: st ? st.schema : null, songs: st ? st.songOrder.length : null,
          pristine: s ? s.pristine : null, generation: s ? s.generation : null,
          currentSongName: st && st.songs[st.settings.currentSongId] ? st.songs[st.settings.currentSongId].name : null,
        });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    """#
}

#if os(macOS)
enum RigSelfTest {
    /// Hard limit for the whole run (AWAY_WEEK_PLAN Lane E 4: 60 s).
    static let budget: TimeInterval = 60
    /// The bridge minor the UI in app/js is written against (ENGINE_CONTRACT 6.2: 5 = CORE2B `get param`).
    static let requiredMinor = 5
    /// The fixture's marker song (native/apple/selftest/electron-backups); RIG_SELFTEST_IMPORT_MARKER overrides.
    static let defaultMarker = "E4 self-test import"

    static var requested: Bool {
        CommandLine.arguments.contains("--self-test") || ProcessInfo.processInfo.environment["RIG_SELFTEST"] == "1"
    }

    private static var delegate: RigSelfTestDelegate?

    /// Runs the self-test instead of the SwiftUI app. Never returns: the runner exits the process.
    /// @MainActor like its caller (RigEntry.main): NSApplication and its delegate protocol are main-actor APIs, so
    /// this keeps the call legal under any concurrency checking level (E4 review E3).
    @MainActor
    static func run() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory) // no Dock icon, no menu bar; windows still work
        let d = RigSelfTestDelegate()
        delegate = d
        app.delegate = d
        app.run()
        exit(1) // not reached: the runner calls exit
    }
}

final class RigSelfTestDelegate: NSObject, NSApplicationDelegate {
    private var runner: RigSelfTestRunner?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let r = RigSelfTestRunner()
        runner = r
        r.start()
    }
}

/// The result, shared with the watchdog thread (hence the lock). Printed exactly once.
final class RigSelfTestReport {
    private let lock = NSLock()
    private var checks: [[String: Any]] = []
    private var sections: [String: Any] = [:]
    private var printed = false
    private let started = Date()

    func check(_ name: String, _ ok: Bool, required: Bool = true, ms: Double? = nil, _ detail: String) {
        var c: [String: Any] = ["name": name, "ok": ok, "required": required, "detail": detail]
        if let ms { c["ms"] = (ms * 10).rounded() / 10 }
        lock.lock(); checks.append(c); lock.unlock()
        let tag = ok ? "ok  " : (required ? "FAIL" : "warn")
        FileHandle.standardError.write(Data("selftest: \(tag) \(name): \(detail)\n".utf8))
    }

    func set(_ key: String, _ value: Any) {
        lock.lock(); sections[key] = value; lock.unlock()
    }

    var elapsed: TimeInterval { Date().timeIntervalSince(started) }

    /// Prints the JSON line (once) and returns the exit code: 0 when every required check passed and none timed out.
    @discardableResult
    func finish(timedOut: Bool) -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        if printed { return 1 }
        printed = true
        let failed = checks.filter { ($0["required"] as? Bool) == true && ($0["ok"] as? Bool) != true }
            .map { "\($0["name"] ?? "?"): \($0["detail"] ?? "")" }
        let pass = !timedOut && failed.isEmpty && !checks.isEmpty
        var out = sections
        out["tool"] = "worship-rig-selftest"
        out["schema"] = 1
        out["pass"] = pass
        out["timedOut"] = timedOut
        out["seconds"] = (elapsed * 100).rounded() / 100
        out["checks"] = checks
        out["failed"] = timedOut ? failed + ["timeout: no result within \(Int(RigSelfTest.budget)) s"] : failed
        let opts: JSONSerialization.WritingOptions = [.sortedKeys]
        let data = (try? JSONSerialization.data(withJSONObject: out, options: opts))
            ?? Data(#"{"pass":false,"tool":"worship-rig-selftest","failed":["report: not serialisable"]}"#.utf8)
        FileHandle.standardOutput.write(data + Data("\n".utf8))
        FileHandle.standardError.write(Data("selftest: \(pass ? "PASS" : "FAIL") in \(out["seconds"] ?? 0) s\n".utf8))
        return pass ? 0 : 1
    }
}

/// The steps, chained with callbacks on the main thread. Deliberately no async/await or @MainActor here: RigHost
/// uses none either, so the file compiles under the same (minimal) concurrency checking as the rest of the shell.
final class RigSelfTestRunner {
    private let report = RigSelfTestReport()
    private let hooks = RigSelfTestHooks()
    private var host: RigHost!
    private var window: NSWindow?
    private var tempRoot: URL?
    /// Keeps App Nap off for the run: an .accessory app with no visible window is a prime App Nap candidate, which
    /// coalesces timers (the polls below, the null output's nanosleep pacing). E4 review E4.
    private var activity: NSObjectProtocol?

    // page and bridge observations (main thread)
    private var finishedURL: URL?
    private var loadError: String?
    private var terminated = 0
    private var helloIds = Set<Int>()
    private var helloReply: [String: Any]?
    private var helloSentAt: Double?
    private var stateEvents: [[String: Any]] = []
    private var pageErrors: [String] = []
    private var pageErrorCount = 0
    private var httpErrors: [String] = []
    private var httpCount = 0
    private var patchRequests = 0 // rig://app/api/user-patches responses (lane N1: none while there is no pack)
    private let env = ProcessInfo.processInfo.environment

    private func ms(since t: Date) -> Double { Date().timeIntervalSince(t) * 1000 }

    func start() {
        let budget = Int(RigSelfTest.budget)
        FileHandle.standardError.write(Data("selftest: start (pid \(getpid()), budget \(budget) s)\n".utf8))
        let report = self.report
        Thread.detachNewThread {
            Thread.sleep(forTimeInterval: RigSelfTest.budget)
            let code = report.finish(timedOut: true)
            _exit(code == 0 ? 1 : code) // a hung main thread must not keep the process alive
        }
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical], reason: "Worship Rig self-test")

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("worship-rig-selftest-\(getpid())", isDirectory: true)
        tempRoot = tmp
        RigPaths.overrideRoot = tmp
        RigBackups.scanApplicationSupport = false

        hooks.pageFinished = { [weak self] url in if self?.finishedURL == nil { self?.finishedURL = url } }
        hooks.pageFailed = { [weak self] err in if self?.loadError == nil { self?.loadError = err } }
        hooks.contentTerminated = { [weak self] in self?.terminated += 1 }
        hooks.outgoing = { [weak self] body in self?.sawOutgoing(body) }
        hooks.incoming = { [weak self] batch in self?.sawIncoming(batch) }
        hooks.httpStatus = { [weak self] url, status in
            guard let self else { return }
            self.httpCount += 1
            if url.contains("/api/user-patches") { self.patchRequests += 1 }
            if status >= 400, self.httpErrors.count < 50 { self.httpErrors.append("\(status) \(url)") }
        }
        hooks.pageMessage = { [weak self] body in
            guard let self else { return }
            self.pageErrorCount += 1
            let d = body as? [String: Any]
            let line = "\(d?["kind"] ?? "?"): \(d?["text"] ?? body)"
            if self.pageErrors.count < 50 { self.pageErrors.append(line) }
            FileHandle.standardError.write(Data("selftest: page \(line)\n".utf8))
        }

        let t = Date()
        host = RigHost(selfTest: hooks) // creates the engine and starts loading rig://app/index.html
        report.check("engine", host.engine != nil, ms: ms(since: t),
                     host.engine != nil ? String(cString: rig_version_string()) : "rig_create failed (see stderr)")
        report.set("host", hostInfo())
        guard host.engine != nil else { return finish() }

        // WKWebView needs a window to run like a visible page (timers, rAF); this one is transparent and ignores the
        // mouse unless RIG_SELFTEST_SHOW=1. On-screen rather than off-screen: an off-screen window counts as occluded,
        // and WebKit throttles occluded pages.
        let show = env["RIG_SELFTEST_SHOW"] == "1"
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.borderless],
                         backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.isRestorable = false // nothing of this window in the app's saved state (Ryan's Mac shares the bundle id)
        w.contentView = host.webView
        w.alphaValue = show ? 1 : 0
        w.ignoresMouseEvents = !show
        if let screen = NSScreen.main { w.setFrameOrigin(screen.visibleFrame.origin) }
        w.orderFrontRegardless()
        window = w
        stepLoad()
    }

    // MARK: observations

    private func sawOutgoing(_ body: Any) {
        let list = (body as? [Any]) ?? [body]
        for m in list {
            guard let d = m as? [String: Any], (d["op"] as? String) == "hello" else { continue }
            if let id = (d["id"] as? NSNumber)?.intValue { helloIds.insert(id) }
            if helloSentAt == nil { helloSentAt = report.elapsed * 1000 }
        }
    }

    private func sawIncoming(_ batch: [String]) {
        for text in batch {
            guard let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)) else { continue }
            visit(obj)
        }
    }

    private func visit(_ obj: Any) {
        if let a = obj as? [Any] { return a.forEach { visit($0) } }
        guard let d = obj as? [String: Any] else { return }
        if let re = (d["re"] as? NSNumber)?.intValue, helloIds.contains(re), helloReply == nil { helloReply = d }
        if (d["ev"] as? String) == "state", stateEvents.count < 20 { stateEvents.append(d) }
    }

    // MARK: steps

    /// Polls `cond` on the main thread every `every` s until it holds or `timeout` s pass.
    private func poll(_ timeout: TimeInterval, every: TimeInterval = 0.05, _ cond: @escaping () -> Bool,
                      _ done: @escaping (Bool) -> Void) {
        let deadline = Date().addingTimeInterval(timeout)
        func tick() {
            if cond() { return done(true) }
            if Date() >= deadline { return done(false) }
            DispatchQueue.main.asyncAfter(deadline: .now() + every) { tick() }
        }
        tick()
    }

    private func js(_ body: String, _ args: [String: Any], _ done: @escaping ([String: Any]?, String?) -> Void) {
        host.webView.callAsyncJavaScript(body, arguments: args, in: nil, in: .page) { r in
            switch r {
            case .success(let v):
                guard let s = v as? String, let o = try? JSONSerialization.jsonObject(with: Data(s.utf8)),
                      let d = o as? [String: Any] else { return done(nil, "probe returned \(v)") }
                done(d, nil)
            case .failure(let e):
                done(nil, "\(e.localizedDescription) \((e as NSError).userInfo["WKJavaScriptExceptionMessage"] ?? "")")
            }
        }
    }

    private func stepLoad() {
        let t = Date()
        poll(20, { [self] in finishedURL != nil || loadError != nil || terminated > 0 }) { [self] _ in
            var ok = false
            var detail = "no didFinish within 20 s"
            if let url = finishedURL {
                ok = url.scheme == RigSchemeHandler.scheme
                detail = "\(url.absoluteString) loaded"
            } else if let err = loadError {
                detail = "navigation failed: \(err)"
            } else if terminated > 0 {
                detail = "web content process terminated"
            }
            report.check("load", ok, ms: ms(since: t), detail)
            if ok { stepHello() } else { finish() }
        }
    }

    private func stepHello() {
        let t = Date()
        poll(15, { [self] in helloReply != nil }) { [self] _ in
            guard let r = helloReply else {
                report.check("hello", false, ms: ms(since: t),
                             helloIds.isEmpty ? "the page never sent hello (is the engine a BridgeEngine?)"
                                              : "no reply to hello id \(helloIds.sorted())")
                return stepBoot()
            }
            let res = r["result"] as? [String: Any] ?? [:]
            let proto = (res["protocol"] as? NSNumber)?.intValue ?? -1
            let minor = (res["minor"] as? NSNumber)?.intValue ?? -1
            let need = RigSelfTest.requiredMinor
            let ok = (r["ok"] as? Bool) == true && proto == Int(RIG_BRIDGE_PROTOCOL) && minor >= need
            report.set("hello", res.isEmpty ? r : res)
            report.check("hello", ok, ms: ms(since: t),
                         "ok \(r["ok"] ?? "?"), protocol \(proto), minor \(minor) (need >= \(need)), "
                         + "engine \(res["engine"] ?? "?"), sampleRate \(res["sampleRate"] ?? "?")")
            stepBoot()
        }
    }

    private func stepBoot() {
        let t = Date()
        js(RigSelfTestScripts.bootProbe, ["timeoutMs": 25000]) { [self] d, err in
            guard let d else {
                report.check("boot", false, ms: ms(since: t), "probe failed: \(err ?? "?")")
                report.check("store", false, "not probed")
                return stepShell()
            }
            report.set("boot", d)
            let phase = d["phase"] as? String ?? "?"
            let kind = d["engineKind"] as? String ?? "?"
            let why = (d["readyError"] as? String).map { " (\($0))" } ?? ""
            report.check("boot", phase == "ok" && kind == "BridgeEngine", ms: ms(since: t),
                         "__rig.ready \(phase)\(why), engine \(kind), visibility \(d["visibility"] ?? "?")")
            let schema = (d["schema"] as? NSNumber)?.intValue ?? -1
            let songs = (d["songs"] as? NSNumber)?.intValue ?? 0
            let status = d["loadStatus"] as? String ?? "?"
            report.check("store", (d["store"] as? Bool) == true && schema == 2 && songs > 0
                         && (status == "ok" || status == "fresh"),
                         "__rig.store \((d["store"] as? Bool) == true ? "present" : "missing"), schema \(schema), "
                         + "\(songs) songs, load \(status), pristine \(d["pristine"] ?? "?")")
            stepShell()
        }
    }

    /// Lane N0: window.rig is the injected native shell, getInfo answers, __rigShell was merged (not replaced).
    private func stepShell() {
        js(RigSelfTestScripts.shellProbe, [:]) { [self] d, err in
            guard let d else {
                report.check("shell", false, "probe failed: \(err ?? "?")")
                return stepAudio()
            }
            report.set("shell", d)
            let want = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
            let version = d["version"] as? String ?? "?"
            // separate lets: one long chain of optional comparisons can hit the type checker's time limit
            let isNative: Bool = (d["shell"] as? String) == "native"
            let notElectron: Bool = (d["isElectron"] as? Bool) == false
            let menuOK: Bool = (d["menu"] as? Bool) == true && (d["menuReady"] as? Bool) == true
            let merged: Bool = (d["merged"] as? Bool) == true
            let ok = isNative && notElectron && menuOK && merged && version == want
            report.check("shell", ok, "rig.shell \(d["shell"] ?? "?"), getInfo version \(version) (bundle \(want)), "
                         + "menu \(d["menu"] ?? "?"), menuReady \(d["menuReady"] ?? "?"), merged \(d["merged"] ?? "?")")
            stepAudio()
        }
    }

    private func stepAudio() {
        let t = Date()
        // at least 0.25 s of audio at 48 kHz
        poll(5, { [self] in host.nullSinkStats().frames >= 12000 }) { [self] _ in
            let s = host.nullSinkStats()
            let running = stateEvents.contains { ($0["state"] as? String) == "running" }
            let et = host.engine.map { rig_engine_time($0) } ?? 0
            let audio: [String: Any] = ["frames": s.frames, "renderErrors": s.errors, "lateBlocks": s.late,
                                        "sinkStarts": s.starts, "engineTime": et, "stateRunning": running,
                                        "states": stateEvents.compactMap { $0["state"] as? String }]
            report.set("audio", audio)
            let ets = String(format: "%.3f", et)
            report.check("audio", s.frames > 0 && s.errors == 0 && running, ms: ms(since: t),
                         "\(s.frames) frames on the null output (\(s.starts) start(s), \(s.errors) render errors, "
                         + "\(s.late) late blocks), engine time \(ets) s, state running: \(running)")
            if s.frames > 0 { stepNote() } else { stepMigration() }
        }
    }

    private func stepNote() {
        _ = host.nullSinkPeak(reset: true)
        // `input` first: it wakes a sleeping engine as a key press would (lowres2)
        host.post(Data(#"[{"v":1,"op":"play","e":"input"},{"v":1,"op":"play","e":"on","n":60,"vel":100}]"#.utf8))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [self] in
            let peak = host.nullSinkPeak(reset: false)
            host.post(Data(#"{"v":1,"op":"play","e":"off","n":60}"#.utf8))
            // a non-finite peak (a blown-up render) must not make the whole report unserialisable: JSONSerialization
            // rejects inf/NaN, and the fallback line drops every check (E4 review E6)
            let finite = peak.isFinite
            let db = !finite ? 999 : peak > 0 ? 20 * log10(Double(peak)) : -200
            let note: [String: Any] = ["peak": finite ? Double(peak) : -1, "peakDb": (db * 10).rounded() / 10,
                                       "finite": finite]
            report.set("note", note)
            report.check("note", finite && db > -100, required: false, ms: 600,
                         finite ? "note 60 vel 100 on the current song: peak \(String(format: "%.1f", db)) dBFS"
                                : "note 60 vel 100: the output peak is not finite")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [self] in stepMigration() }
        }
    }

    private func stepMigration() {
        guard let dir = env["RIG_ELECTRON_BACKUPS"], !dir.isEmpty else {
            report.set("migration", NSNull())
            return stepPacks()
        }
        let t = Date()
        let marker = env["RIG_SELFTEST_IMPORT_MARKER"].flatMap { $0.isEmpty ? nil : $0 } ?? RigSelfTest.defaultMarker
        host.library.autoAnswer = true
        host.library.offerFirstLaunchImport { [self] outcome in
            guard outcome == "staged" else {
                let m: [String: Any] = ["dir": dir, "outcome": outcome]
                report.set("migration", m)
                report.check("migration", false, ms: ms(since: t), "first-launch offer from \(dir): \(outcome)")
                return stepPacks()
            }
            js(RigSelfTestScripts.importProbe, ["marker": marker, "timeoutMs": 10000]) { [self] d, err in
                let hit = (d?["hit"] as? Bool) == true
                let schema = (d?["schema"] as? NSNumber)?.intValue ?? -1
                let probe: [String: Any] = d ?? ["error": err ?? "?"]
                let m: [String: Any] = ["dir": dir, "outcome": outcome, "probe": probe]
                report.set("migration", m)
                let songs = d?["songs"] ?? "?"
                let why = err ?? "probe \(probe)"
                report.check("migration", hit && schema == 2, ms: ms(since: t),
                             hit ? "imported '\(marker)' from \(dir): \(songs) songs, schema \(schema)"
                                 : "'\(marker)' not in the library after the import (\(why))")
                stepPacks()
            }
        }
    }

    /// Lane N1: patch packs. RigPaths.userSampleRoots is <temp>/Samples here (missing until this step writes it).
    private func stepPacks() {
        let t = Date()
        let before = patchRequests
        guard let root = RigPaths.userSampleRoots.first else { return stepEnd() }
        js(RigSelfTestScripts.packsProbe, ["phase": "export", "timeoutMs": 10000]) { [self] d, err in
            guard let files = d?["files"] as? [String: String] else {
                let why = err ?? String(describing: d ?? [:])
                report.check("packs", false, ms: ms(since: t), "export probe failed: \(why)")
                return stepEnd()
            }
            do {
                for (rel, text) in files {
                    let url = root.appendingPathComponent(rel)
                    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                            withIntermediateDirectories: true)
                    try Data(text.utf8).write(to: url)
                }
            } catch {
                report.check("packs", false, ms: ms(since: t),
                             "could not write the packs under \(root.path): \(error.localizedDescription)")
                return stepEnd()
            }
            js(RigSelfTestScripts.packsProbe, ["phase": "check", "timeoutMs": 10000]) { [self] d, err in
                let probe: [String: Any] = d ?? ["error": err ?? "?"]
                report.set("packs", ["root": root.path, "requestsBeforePacks": before, "probe": probe] as [String: Any])
                let bank = (d?["bankSongs"] as? NSNumber)?.intValue ?? -1
                let errs = d?["errors"] as? [Any] ?? ["?"]
                let first = errs.first.map { ": \($0)" } ?? ""
                // n1-skeptic: one Bool per term (a long chain of Optional == literal terms is slow to type-check)
                let flagged = (d?["userPatches"] as? Bool) ?? false
                let inLibrary = (d?["autoInLibrary"] as? Bool) ?? false
                let added = (d?["addOk"] as? Bool) ?? false
                let ok: Bool = before == 0 && flagged && bank == 2 && inLibrary && added && errs.isEmpty
                report.check("packs", ok, ms: ms(since: t),
                             "\(before) pack request(s) before any pack; then userPatches \(d?["userPatches"] ?? "?"), "
                             + "\(d?["songs"] ?? "?") pack songs, \(bank) in the Song bank, auto song in library "
                             + "\(d?["autoInLibrary"] ?? "?"), Add to library \(d?["addOk"] ?? "?"), "
                             + "\(errs.count) error(s)\(first)")
                stepEnd()
            }
        }
    }

    private func stepEnd() {
        // let late errors (a failed fetch after boot, a rejected promise) arrive before counting
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [self] in
            let st = host.midi.clientStatus
            let srcs = MIDIGetNumberOfSources(), dsts = MIDIGetNumberOfDestinations()
            report.check("midi", st == 0, required: false,
                         "CoreMIDI client OSStatus \(st), \(srcs) sources, \(dsts) destinations")
            report.check("webcontent", terminated == 0, "\(terminated) WebContent termination(s)")
            let page: [String: Any] = ["errors": pageErrors, "errorCount": pageErrorCount, "http": httpErrors,
                                       "httpResponses": httpCount]
            report.set("page", page)
            let first = pageErrors.first ?? "?"
            report.check("console", pageErrorCount == 0,
                         pageErrorCount == 0 ? "no page errors" : "\(pageErrorCount) page error(s); first: \(first)")
            report.check("http", httpErrors.isEmpty, httpErrors.isEmpty ? "\(httpCount) rig:// responses, none >= 400"
                         : "\(httpErrors.count) of \(httpCount) responses >= 400; first: \(httpErrors[0])")
            finish()
        }
    }

    private func finish() {
        host?.stopNullSink(closing: true) // no rig_render after this: exit() below runs the C++ static destructors
        let code = report.finish(timedOut: false)
        if let tmp = tempRoot { try? FileManager.default.removeItem(at: tmp) }
        exit(code) // the path NSApp.terminate takes too: a crash at quit shows as a non-zero status (check.sh)
    }

    private func hostInfo() -> [String: Any] {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let b = Bundle.main.infoDictionary ?? [:]
        let webkit = Bundle(identifier: "com.apple.WebKit")?.infoDictionary?["CFBundleVersion"] ?? "?"
        return ["os": "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
                "app": "\(b["CFBundleShortVersionString"] ?? "?") (\(b["CFBundleVersion"] ?? "?"))",
                "webkit": webkit, "core": String(cString: rig_version_string()),
                "apiVersion": rig_api_version(), "tempRoot": tempRoot?.path ?? ""]
    }
}
#endif
