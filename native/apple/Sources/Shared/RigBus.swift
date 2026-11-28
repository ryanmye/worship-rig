// The Mac command bus and the browser remote (remote lane, D34 / D45; native/docs/lanes/REMOTE.md §2.6). UNBUILT on
// Linux (compiled only by CI mac-check). JS side: app/js/native-shell/40-bus.js. Everything that decides is C++ in
// rig_hostkit (rig_bus.h: bus.js's checks; rig_remote.h: the server, pairing, limits, Lock); this file only passes
// messages along and keeps the on/off setting.
//
//   page rig.busPublish(json) --busPublish--> rig_bus_check_state --> last state --> rig_remote_publish_state
//                                                                                  (later also N7's popover)
//   phone --LAN--> rig_remote (its own thread) --on_command--> main queue --> page __rigShell.bus(json)
//
// Remote commands come only from rig_remote's callback, which builds them itself with `via:"remote"`: nothing a page
// sends is ever relayed back as a command (the controller's Lock gate trusts `via` to come from here; skeptic note).
import Foundation
import WebKit

final class RigBus: NSObject, RigShellFeature {
    let methods: [String] = ["busPublish", "remoteInfo", "remoteSetEnabled", "remoteNewCode", "remoteForgetAll"]
    weak var host: RigHost?
    /// UserDefaults key for Settings › Remote's switch. Off by default (D34).
    static let enabledKey = "rig.remote.enabled.v1"
    /// false in the self-test: it never reads or writes Ryan's real setting.
    var persist = true
    private var lastState: String?
    private var remote: OpaquePointer? // rig_remote*, created on first use; main thread only

    deinit {
        if let r = remote { rig_remote_destroy(r) } // stops the server thread before anything here goes away
    }

    /// The app launched: switch the remote on if Settings left it on.
    func restore() {
        #if os(macOS)
        if persist, UserDefaults.standard.bool(forKey: Self.enabledKey) { _ = setEnabled(true) }
        #endif
    }

    func handle(_ m: String, _ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        switch m {
        case "busPublish":
            guard let json = body["json"] as? String else { return reply(["error": "expected a JSON string"], nil) }
            if let why = Self.checkState(json) { return reply(["error": why], nil) }
            lastState = json
            if let r = remote { Self.publish(r, json) }
            reply(["ok": true], nil)
        #if os(macOS)
        case "remoteInfo":
            reply(info(), nil)
        case "remoteSetEnabled":
            let on = body["on"] as? Bool ?? false
            if let err = setEnabled(on) { return reply(["error": err], nil) }
            reply(info(), nil)
        case "remoteNewCode":
            if let r = remote { rig_remote_new_code(r) }
            reply(info(), nil)
        case "remoteForgetAll":
            if let r = remote { rig_remote_forget_all(r) }
            reply(info(), nil)
        #endif
        default:
            reply(["error": "not available here"], nil)
        }
    }

    // MARK: the bus

    /// rig_bus_check_state: nil when valid, else the reason (bus.js's words).
    static func checkState(_ json: String) -> String? {
        var reason: UnsafeMutablePointer<CChar>?
        let rc = json.withCString { rig_bus_check_state($0, json.utf8.count, &reason) }
        defer { rig_hostkit_free(reason) }
        if rc == 0 { return nil }
        return reason.map { String(cString: $0) } ?? "invalid"
    }

    private static func publish(_ r: OpaquePointer, _ json: String) {
        _ = json.withCString { rig_remote_publish_state(r, $0, json.utf8.count) }
    }

    /// A relayed command into the page (main thread). `json` comes from rig_remote, never from a page.
    private func deliver(_ json: String) {
        host?.webView.evaluateJavaScript(
            "window.__rigShell && window.__rigShell.bus && window.__rigShell.bus(\(Self.jsString(json)))",
            completionHandler: nil)
    }

    private func deliverInfo() {
        guard remote != nil, let text = infoText() else { return }
        host?.webView.evaluateJavaScript(
            "window.__rigShell && window.__rigShell.remoteInfo && window.__rigShell.remoteInfo(\(Self.jsString(text)))",
            completionHandler: nil)
    }

    /// A JS string literal for `s` (JSON quoting, plus U+2028 / U+2029, which old JS parsers end a line at).
    static func jsString(_ s: String) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed]) else { return "''" }
        return String(decoding: d, as: UTF8.self)
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    // MARK: the remote (macOS)

    /// rig_remote calls these on its own thread (on_info also on the caller's); both hop to the main queue.
    private static let onCommand: rig_remote_command_fn = { ctx, json in
        guard let ctx = ctx, let json = json else { return }
        let s = String(cString: json)
        let bus = Unmanaged<RigBus>.fromOpaque(ctx).takeUnretainedValue()
        DispatchQueue.main.async { [weak bus] in bus?.deliver(s) }
    }
    private static let onInfo: rig_remote_info_fn = { ctx in
        guard let ctx = ctx else { return }
        let bus = Unmanaged<RigBus>.fromOpaque(ctx).takeUnretainedValue()
        DispatchQueue.main.async { [weak bus] in bus?.deliverInfo() }
    }

    /// Switch the server on or off; nil, or the reason it could not start.
    @discardableResult
    func setEnabled(_ on: Bool) -> String? {
        if persist { UserDefaults.standard.set(on, forKey: Self.enabledKey) }
        if !on {
            if let r = remote { rig_remote_stop(r) }
            return nil
        }
        if remote == nil {
            remote = rig_remote_create(Self.onCommand, Self.onInfo, Unmanaged.passUnretained(self).toOpaque())
        }
        guard let r = remote else { return "out of memory" }
        let page = RigPaths.appDir.appendingPathComponent("remote/index.html")
        guard let html = try? Data(contentsOf: page) else { return "the remote page is missing from the app" }
        html.withUnsafeBytes { raw in
            rig_remote_set_page(r, raw.baseAddress?.assumingMemoryBound(to: CChar.self), raw.count)
        }
        var err: UnsafeMutablePointer<CChar>?
        let port = rig_remote_start(r, 0, &err)
        defer { rig_hostkit_free(err) }
        if port < 0 {
            if persist { UserDefaults.standard.set(false, forKey: Self.enabledKey) }
            return err.map { String(cString: $0) } ?? "could not start"
        }
        if let s = lastState { Self.publish(r, s) }
        return nil
    }

    private func infoText() -> String? {
        guard let r = remote, let p = rig_remote_info_json(r) else { return nil }
        defer { rig_hostkit_free(p) }
        return String(cString: p)
    }

    /// rig_remote_info_json as a property list for the reply ({"on":false} before the first switch-on).
    func info() -> Any {
        guard let text = infoText(), let d = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) else { return ["on": false] }
        return obj
    }

    /// Self-test: start on a given port (0 = 8450..8459) without touching the setting. Returns the port or nil.
    func startForTest() -> Int? {
        let saved = persist
        persist = false
        defer { persist = saved }
        if setEnabled(true) != nil { return nil }
        return (info() as? [String: Any])?["port"] as? Int
    }
}
