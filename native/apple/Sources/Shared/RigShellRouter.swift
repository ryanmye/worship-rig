// window.rig in the native shell (lane N0): the injected JS files and the one message handler behind them. UNBUILT on
// Linux (compiled only by CI mac-check).
//
//   app/js/native-shell/NN-*.js  --RigShellScripts (name order, after one config line)--> WKUserScript, document start
//   page: __rigShell.call(m, args) --webkit.messageHandlers.rigShell {m, ...}--> RigShellRouter --> the feature for m
//
// Each feature of window.rig is one JS file (its members, over __rigShell.call) plus one RigShellFeature here that
// answers its methods (`RigLibrary`: backupNow / latestBackup; `RigInfo`: getInfo). A later lane adds a file and a
// feature and registers it in RigHost; nothing else changes. The JS is tested on Linux against a fake handler
// (test/unit/native-shell); keep the Swift side to argument checks and native calls.
import Foundation
import WebKit

/// One feature of window.rig: the `{m}` methods it answers. Called on the main thread; `reply` must be called once,
/// on the main thread, with a property-list value (dictionary, array, string, number, NSNull) or an error string.
protocol RigShellFeature: AnyObject {
    var methods: [String] { get }
    func handle(_ m: String, _ body: [String: Any], reply: @escaping (Any?, String?) -> Void)
}

/// The `rigShell` WKScriptMessageHandlerWithReply: dispatches `{m}` to the feature that registered it.
final class RigShellRouter: NSObject, WKScriptMessageHandlerWithReply {
    private var table: [String: RigShellFeature] = [:]

    /// A method name belongs to one feature (test/unit/native-shell checks the declared names are unique).
    func register(_ feature: RigShellFeature) {
        for m in feature.methods {
            if table[m] != nil { NSLog("rig shell: method %@ registered twice; the first one wins", m) }
            if table[m] == nil { table[m] = feature }
        }
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let m = body["m"] as? String else {
            return replyHandler(nil, "bad message")
        }
        guard let feature = table[m] else { return replyHandler(["error": "unknown method \(m)"], nil) }
        feature.handle(m, body, reply: replyHandler)
    }
}

/// The document-start script: `window.__rigShellConfig = {...};` then every app/js/native-shell/*.js in name order.
enum RigShellScripts {
    static let dirName = "js/native-shell"
    static let separator = "\n;\n"

    static func documentStart(appDir: URL, config: [String: Any]) -> String {
        let dir = appDir.appendingPathComponent(dirName, isDirectory: true)
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
            .filter { $0.hasSuffix(".js") }.sorted()
        if names.isEmpty { NSLog("rig shell: no scripts in %@ (window.rig will be missing)", dir.path) }
        let cfg = (try? JSONSerialization.data(withJSONObject: config, options: [.sortedKeys]))
            .map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        var parts = ["window.__rigShellConfig = \(cfg);"]
        for n in names {
            guard let s = try? String(contentsOf: dir.appendingPathComponent(n), encoding: .utf8) else {
                NSLog("rig shell: cannot read %@", n)
                continue
            }
            parts.append("// \(n)\n\(s)")
        }
        return parts.joined(separator: separator)
    }
}

/// window.rig.getInfo (Settings › About, the D11 pad check, the self-test's `shell` step): the 1.x shape (main.js
/// 'rig:getInfo') without `electron`. The rig://app origin never changes, so port 0 and no other library (M5).
/// padsRoot / userSamplesDir stay null until lanes N4 / N2 own those folders.
final class RigInfo: RigShellFeature {
    let methods: [String] = ["getInfo"]

    func handle(_ m: String, _ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        reply(Self.info(), nil)
    }

    static func info() -> [String: Any] {
        let d = Bundle.main.infoDictionary ?? [:]
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        #if os(macOS)
        let userData = base.appendingPathComponent(RigPaths.supportDirName, isDirectory: true)
        #else
        let userData = base
        #endif
        return [
            "version": (d["CFBundleShortVersionString"] as? String) ?? "?",
            "build": (d["CFBundleVersion"] as? String) ?? "?",
            "shell": "native",
            "platform": RigHost.platformName,
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "userData": userData.path,
            "port": 0,
            "portChanged": false,
            "otherLibrary": NSNull(),
            "padsRoot": NSNull(),
            "userSamplesDir": NSNull(),
            "userSampleRoots": [String](),
            "recordingsDir": RigPaths.recordingsDir.path,
            "backupsDir": RigPaths.backupsDir.path,
        ]
    }
}
