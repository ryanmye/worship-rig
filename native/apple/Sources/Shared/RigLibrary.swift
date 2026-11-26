// Library backups and the one-time import of the Electron app's library. UNBUILT on Linux.
//
// Why: the UI keeps the whole library in localStorage under the page origin. Electron's origin was
// http://127.0.0.1:8438 (the port can differ), the native app's is rig://app, so a new install looks empty.
// The Electron app already writes `rig-YYYYMMDD-HHMMSS[-n].json` rotation files (newest 10, tagged
// `{"origin":"...",...library}`) to <userData>/backups on every edit (30 s debounce) and on window close; the UI's
// existing "import latest backup" path (controller.importLatestBackup -> window.rig.latestBackup()) reads one.
// This file provides a minimal window.rig (isElectron:false) over a WKScriptMessageHandlerWithReply named `rigShell`:
//     backupNow(json, kind)  -> {path} | {error}       writes the same rotation into RigPaths.backupsDir
//     latestBackup()         -> {path, origin, savedAt, text, via} | {error}   (via, D11: 'backups' | 'first-launch'
//                               | 'picked'; 'files' = the iPad's Backups folder)
//                               a staged file (picker / AirDrop) wins once, else the newest library file that
//                               parses among our own backups and, on macOS, the Electron app's backups
//     onMenu(cb)             -> unsubscribe            the shell calls cb('importLatestBackup') from Swift
// No app/js file changes. isElectron stays false, so recording, menus and shortcuts keep their non-Electron paths.
import Foundation
import WebKit
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum RigBackups {
    static let maxBytes = 16 * 1024 * 1024
    /// Library rotation files kept, as main.js (`BACKUPS_KEEP = 10`). Review E5 open item 4: with 3, the debounce
    /// backup of an imported library plus two more pushed the pre-import backup out (DECISIONS O-AW-F1).
    static let keepLibrary = 10
    /// app/js/store.js `SCHEMA`: a newer file is never offered by latestAnywhere (test/unit/selftest checks the pair).
    static let maxSchema = 2
    private static let nameRE = try! NSRegularExpression(pattern: #"^rig-\d{8}-\d{6}(-\d+)?\.json$"#)

    struct Entry { let url: URL; let mtime: Date }

    /// Newer mtime first, then the later name: a git export gives every fixture file the same mtime.
    static func newerFirst(_ a: Entry, _ b: Entry) -> Bool {
        a.mtime != b.mtime ? a.mtime > b.mtime : a.url.lastPathComponent > b.url.lastPathComponent
    }

    static func isRotationName(_ n: String) -> Bool {
        nameRE.firstMatch(in: n, range: NSRange(n.startIndex..., in: n)) != nil
    }

    static func list(_ dir: URL, prefix: String? = nil) -> [Entry] {
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        guard let urls = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else {
            return []
        }
        return urls.compactMap { u in
            let n = u.lastPathComponent
            guard prefix.map({ n.hasPrefix($0) && n.hasSuffix(".json") }) ?? isRotationName(n) else { return nil }
            let t = (try? u.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? .distantPast
            return Entry(url: u, mtime: t)
        }.sorted(by: newerFirst)
    }

    private static func stamp() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f.string(from: Date())
    }

    private static func prune(_ dir: URL, prefix: String?, keep: Int) {
        for e in list(dir, prefix: prefix).dropFirst(keep) { try? FileManager.default.removeItem(at: e.url) }
    }

    /// window.rig.backupNow: 'library' rotates (newest `keepLibrary`), 'unreadable' keeps the newest 5 separately
    /// (as main.js).
    static func write(_ text: String, kind: String) -> [String: Any] {
        guard !text.isEmpty, text.utf8.count <= maxBytes else { return ["error": "backup too large or empty"] }
        let dir = RigPaths.backupsDir
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let s = stamp()
            if kind == "unreadable" {
                let ms = Int(Date().timeIntervalSince1970 * 1000) % 1000
                let url = dir.appendingPathComponent("rig-unreadable-\(s)-\(ms).json")
                try text.write(to: url, atomically: true, encoding: .utf8)
                prune(dir, prefix: "rig-unreadable-", keep: 5)
                return ["path": url.path]
            }
            var url = dir.appendingPathComponent("rig-\(s).json")
            var i = 1
            while fm.fileExists(atPath: url.path) {
                url = dir.appendingPathComponent("rig-\(s)-\(i).json")
                i += 1
            }
            try text.write(to: url, atomically: true, encoding: .utf8)
            prune(dir, prefix: nil, keep: keepLibrary)
            return ["path": url.path]
        } catch {
            return ["error": error.localizedDescription]
        }
    }

    /// False in the self-test (E4): only RIG_ELECTRON_BACKUPS is read, never the real Application Support.
    static var scanApplicationSupport = true

    /// macOS: rotation files of the Electron app. Its userData folder is named after the app (productName "Worship
    /// Rig" when packaged, possibly "worship-rig" or "Electron" in dev: [verify on the Mac]), so scan every folder in
    /// Application Support that has a backups/ child, except ours. RIG_ELECTRON_BACKUPS overrides (tests).
    static func electronEntries() -> [Entry] {
        #if os(macOS)
        let fm = FileManager.default
        if let o = ProcessInfo.processInfo.environment["RIG_ELECTRON_BACKUPS"], !o.isEmpty {
            return list(URL(fileURLWithPath: o, isDirectory: true))
        }
        guard scanApplicationSupport else { return [] }
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let kids = (try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        return kids.filter { $0.lastPathComponent != RigPaths.supportDirName }
            .flatMap { list($0.appendingPathComponent("backups", isDirectory: true)) }
            .sorted(by: newerFirst)
        #else
        return []
        #endif
    }

    /// The `{"origin":"<origin>"` tag the UI prefixes to every backup (controller.libraryJSON), if present.
    static func origin(of text: String) -> String? {
        let head = String(text.prefix(200))
        guard let r = head.range(of: #"^\{"origin":"([^"]+)""#, options: .regularExpression) else { return nil }
        return String(head[r].dropFirst(11).dropLast())
    }

    /// Review E5 open item 3: a file `latestAnywhere` may offer. It must parse as a JSON object, as
    /// `RigLibrary.stage(fileURL:)` checks, and be a whole library the UI can import (store.importJSON's library
    /// branch): `songs` an object or array, or `kind` "library"; not a song file; `schema` absent or a number no newer
    /// than `maxSchema`. A truncated write, a newer app's backup or a stray .json is skipped, not served.
    static func isLibrary(_ data: Data) -> Bool {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        if (obj["kind"] as? String) == "song" { return false }
        let songs = obj["songs"]
        guard songs is [String: Any] || songs is [Any] || (obj["kind"] as? String) == "library" else { return false }
        if let sch = obj["schema"] {
            // JSON true / false also arrive as NSNumber (CFBoolean); the store refuses a non-number schema
            guard let n = sch as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
                  n.doubleValue <= Double(maxSchema) else { return false }
        }
        return true
    }

    static func payload(_ e: Entry) -> [String: Any]? {
        // review F1: latestAnywhere now walks past bad files, so a huge stray rotation-named file is not read whole
        if let size = (try? e.url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size > maxBytes { return nil }
        guard let data = try? Data(contentsOf: e.url), data.count <= maxBytes, isLibrary(data),
              let text = String(data: data, encoding: .utf8) else { return nil }
        let tag: Any = origin(of: text).map { $0 as Any } ?? NSNull()
        return ["path": e.url.path, "origin": tag, "savedAt": e.mtime.timeIntervalSince1970 * 1000, "text": text]
    }

    /// Newest library file that parses (`payload`) among our own backups and (macOS) the Electron ones; older good
    /// files are offered when newer ones are bad. Order: `newerFirst`.
    static func latestAnywhere() -> [String: Any] {
        let all = (list(RigPaths.backupsDir) + electronEntries()).sorted(by: newerFirst)
        for e in all { if let p = payload(e) { return p } }
        return ["error": "no backup found"]
    }
}

final class RigLibrary: NSObject, WKScriptMessageHandlerWithReply {
    weak var host: RigHost?
    private var staged: [String: Any]?
    private var didOffer = false
    /// The first-launch offer runs by itself after the first rig:// load (false in the self-test, which starts it).
    var autoOffer = true
    /// The answer is stored in UserDefaults (false in the self-test: Ryan's real first-launch offer stays intact).
    var persistAnswer = true
    /// Non-nil: every dialog of this class is answered with this value instead of being shown (self-test, E4).
    var autoAnswer: Bool?
    private let io = DispatchQueue(label: "rig.library.io", qos: .utility)
    private static let migrationKey = "rig.electronImportAnswered.v1"
    #if os(iOS)
    private var pickerDelegate: PickerDelegate?
    #endif

    // MARK: window.rig polyfill (runs at document start, before any page script)

    static func polyfill(platform: String) -> String {
        """
        (function () {
          var shell = window.__rigShell = window.__rigShell || {};
          var menu = [];
          shell.menu = function (id) {
            menu.slice().forEach(function (cb) { try { cb(id); } catch (e) { console.warn(e); } });
          };
          shell.menuReady = function () { return menu.length > 0; };
          function call(m, a) {
            var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.rigShell;
            if (!h) return Promise.resolve({ error: 'shell unavailable' });
            return h.postMessage(Object.assign({ m: m }, a || {})).catch(function (e) {
              return { error: String((e && e.message) || e) };
            });
          }
          if (window.rig) return;
          window.rig = {
            isElectron: false,
            platform: '\(platform)',
            backupNow: function (json, kind) {
              return call('backupNow', { json: typeof json === 'string' ? json : JSON.stringify(json), kind: kind });
            },
            latestBackup: function () { return call('latestBackup'); },
            onMenu: function (cb) {
              if (typeof cb !== 'function') return function () {};
              menu.push(cb);
              return function () { menu = menu.filter(function (f) { return f !== cb; }); };
            }
          };
        })();
        """
    }

    // MARK: JS -> Swift

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let m = body["m"] as? String else {
            return replyHandler(nil, "bad message")
        }
        switch m {
        case "backupNow":
            guard let json = body["json"] as? String else { return replyHandler(["error": "no json"], nil) }
            let kind = (body["kind"] as? String) == "unreadable" ? "unreadable" : "library"
            io.async {
                let r = RigBackups.write(json, kind: kind)
                DispatchQueue.main.async { replyHandler(r, nil) }
            }
        case "latestBackup":
            if let s = staged { // an explicit choice (picker / AirDrop) wins, once
                staged = nil
                return replyHandler(s, nil)
            }
            io.async {
                var r = RigBackups.latestAnywhere()
                // D11: say how the file was found; JS applies a 1.1.1 device block only from this Mac's folders.
                // The iPad's Backups folder is open in Files (anything can be put there): never "this machine".
                #if os(macOS)
                if r["error"] == nil { r["via"] = "backups" }
                #else
                if r["error"] == nil { r["via"] = "files" }
                #endif
                DispatchQueue.main.async { replyHandler(r, nil) }
            }
        default:
            replyHandler(["error": "unknown method \(m)"], nil)
        }
    }

    // MARK: Swift -> JS

    func emitMenu(_ id: String) {
        host?.webView.evaluateJavaScript(
            "window.__rigShell && window.__rigShell.menu && window.__rigShell.menu('\(id)')", completionHandler: nil)
    }

    // MARK: first launch: offer the Electron library (macOS)

    /// Waits for the UI (store + controller menu hook), and only offers when the library is still the factory seed.
    private static let readyProbe = """
    for (let i = 0; i < 120; i++) {
      const s = window.__rig && window.__rig.store;
      if (s && window.__rigShell && window.__rigShell.menuReady()) return s.pristine === true;
      await new Promise(r => setTimeout(r, 250));
    }
    return false;
    """

    /// `done` (self-test) gets the outcome on the main thread: "staged" (Yes: the import was handed to the
    /// controller), "declined", "no-backup", "not-pristine" (or the UI never got ready), "probe-failed: …",
    /// "already-offered", "already-answered", "stage-failed: …". Without `done` this only runs when `autoOffer`.
    func offerFirstLaunchImport(done: ((String) -> Void)? = nil) {
        guard autoOffer || done != nil else { return }
        let report: (String) -> Void = { s in done?(s) }
        if didOffer { return report("already-offered") }
        if persistAnswer, UserDefaults.standard.bool(forKey: Self.migrationKey) { return report("already-answered") }
        didOffer = true
        io.async { [weak self] in
            // the newest Electron file that passes isLibrary; Yes stages this same file (stageOfferedAndImport), so
            // the date asked about is the date imported; none on iPad: Files/AirDrop path
            guard let newest = RigBackups.electronEntries().first(where: { RigBackups.payload($0) != nil }) else {
                return DispatchQueue.main.async { report("no-backup") }
            }
            DispatchQueue.main.async { self?.askIfPristine(newest, report) }
        }
    }

    private func askIfPristine(_ e: RigBackups.Entry, _ report: @escaping (String) -> Void) {
        host?.webView.callAsyncJavaScript(Self.readyProbe, arguments: [:], in: nil, in: .page) { [weak self] r in
            guard let self else { return }
            guard case .success(let v) = r else {
                if case .failure(let err) = r { report("probe-failed: \(err.localizedDescription)") }
                return
            }
            guard (v as? Bool) == true else { return report("not-pristine") }
            let when = DateFormatter.localizedString(from: e.mtime, dateStyle: .medium, timeStyle: .short)
            self.confirm("Import your Worship Rig library?",
                         "Found a library saved by the previous Worship Rig on \(when). Import it into this app? "
                         + "This app's current library is empty. You can also import later from the Settings button "
                         + "or File > Import Library Backup.",
                         ok: "Import") { yes in
                if self.persistAnswer { UserDefaults.standard.set(true, forKey: Self.migrationKey) }
                if yes { self.stageOfferedAndImport(e, report) } else { report("declined") }
            }
        }
    }

    /// Stages the very file the offer dated. Review F1: this used to stage `latestAnywhere()`, which also reads our
    /// own rotation, so with an own backup newer than the Electron one (site data reset, library pristine again) Yes
    /// imported a file the dialog never named. A file that no longer parses fails ("stage-failed"), never a substitute.
    private func stageOfferedAndImport(_ e: RigBackups.Entry, _ report: @escaping (String) -> Void) {
        io.async { [weak self] in
            let gone: [String: Any] = ["error": "\(e.url.lastPathComponent) is no longer a library"]
            var p = RigBackups.payload(e) ?? gone
            // D11: this Mac's own backups folder (device settings apply). Set here, not in the main-queue block:
            // that block is @Sendable in current SDKs, where mutating a captured var warns.
            if p["error"] == nil { p["via"] = "first-launch" }
            let r = p
            DispatchQueue.main.async {
                guard let self else { return }
                if let err = r["error"] { return report("stage-failed: \(err)") }
                self.staged = r
                self.emitMenu("importLatestBackup")
                report("staged")
            }
        }
    }

    // MARK: explicit import: File > Import Library Backup..., AirDrop / "Open in", drag onto the icon

    func pickBackup() {
        #if os(macOS)
        let p = NSOpenPanel()
        p.allowedContentTypes = [.json]
        p.allowsMultipleSelection = false
        p.message = "Choose a Worship Rig library backup (rig-….json)"
        if p.runModal() == .OK, let u = p.url { stage(fileURL: u) }
        #else
        let d = PickerDelegate { [weak self] u in self?.stage(fileURL: u) }
        pickerDelegate = d
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.json], asCopy: true)
        picker.delegate = d
        picker.allowsMultipleSelection = false
        RigLibrary.topViewController()?.present(picker, animated: true)
        #endif
    }

    /// onOpenURL from SwiftUI: a .json handed over by AirDrop, Files or Finder.
    func handleOpen(_ url: URL) {
        guard url.isFileURL, url.pathExtension.lowercased() == "json" else { return }
        confirm("Import this library?", "\(url.lastPathComponent) will replace the current library. "
                + "The current library is backed up first.", ok: "Import") { [weak self] yes in
            if yes { self?.stage(fileURL: url) }
        }
    }

    private func stage(fileURL url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url), data.count <= RigBackups.maxBytes,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let text = String(data: data, encoding: .utf8) else {
            return confirm("Not a library file", "\(url.lastPathComponent) is not a Worship Rig library backup.",
                           ok: "OK", cancel: nil) { _ in }
        }
        let tag: Any = (obj["origin"] as? String).map { $0 as Any } ?? NSNull()
        // D11 "via": a picked / received file may come from another computer (its device block is not applied)
        staged = ["path": url.path, "origin": tag, "via": "picked",
                  "savedAt": Date().timeIntervalSince1970 * 1000, "text": text]
        emitMenu("importLatestBackup") // controller.importLatestBackup() -> window.rig.latestBackup() -> `staged`
    }

    // MARK: small native dialogs

    private func confirm(_ title: String, _ message: String, ok: String, cancel: String? = "Not now",
                         _ done: @escaping (Bool) -> Void) {
        if let a = autoAnswer { return done(a) } // self-test: no modal on a runner nobody watches
        #if os(macOS)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.addButton(withTitle: ok)
        if let cancel { a.addButton(withTitle: cancel) }
        done(a.runModal() == .alertFirstButtonReturn)
        #else
        let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: ok, style: .default) { _ in done(true) })
        if let cancel { a.addAction(UIAlertAction(title: cancel, style: .cancel) { _ in done(false) }) }
        RigLibrary.topViewController()?.present(a, animated: true)
        #endif
    }

    #if os(iOS)
    static func topViewController() -> UIViewController? {
        var vc = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first?.rootViewController
        while let next = vc?.presentedViewController { vc = next }
        return vc
    }

    private final class PickerDelegate: NSObject, UIDocumentPickerDelegate {
        let done: (URL) -> Void
        init(_ done: @escaping (URL) -> Void) { self.done = done }
        func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            if let u = urls.first { done(u) }
        }
    }
    #endif
}

/// WKUserContentController retains its handlers: weak proxy for the reply flavour (see WeakScriptHandler).
final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WKScriptMessageHandlerWithReply?
    init(_ target: WKScriptMessageHandlerWithReply) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else { return replyHandler(nil, "shell gone") }
        target.userContentController(c, didReceive: m, replyHandler: replyHandler)
    }
}
