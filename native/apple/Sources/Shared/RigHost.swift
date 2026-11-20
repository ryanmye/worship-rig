// RigHost: owns the core engine (rig_engine*), the WKWebView, and the glue between them. UNBUILT on Linux.
//
//   page JS --webkit.messageHandlers.rig--> RigBridgeHandler --JSON--> rig_post()            (main thread)
//   core event callback (control thread) --> pending batch --main--> window.__rigNative.receive([...])
//   core --rig_host vtable--> RigAudio (AUHAL/RemoteIO, C render callback) and RigMIDI (CoreMIDI)
//
// What this deliberately does not do yet (native/docs/SHELL.md, "later tasks"): menu bar, hotkeys, the rest of
// window.rig (only backupNow/latestBackup/onMenu exist: RigLibrary), importer, pads, update check.
import Foundation
import SwiftUI
import WebKit

final class RigHost: NSObject, ObservableObject {
    private(set) var engine: OpaquePointer?
    let webView: WKWebView
    private let scheme: RigSchemeHandler
    private let bridge: RigBridgeHandler
    private let navigation: RigNavigationDelegate
    let library: RigLibrary
    private(set) var audio: RigAudio!
    private(set) var midi: RigMIDI!
    private var lifecycle: RigLifecycle?

    // C strings handed to rig_config / rig_host must outlive the engine.
    private var keep: [UnsafeMutablePointer<CChar>] = []
    private var hostPtr = UnsafeMutablePointer<rig_host>.allocate(capacity: 1)

    // event pump (core control thread -> main thread, one evaluateJavaScript per turn)
    private let pumpLock = NSLock()
    private var pending: [String] = []
    private var flushScheduled = false

    override init() {
        // Phase 1 of a class init must not read `self` (scheme, bridge) before super.init: build locals first
        // (SETUP_REVIEW S1).
        let conf = WKWebViewConfiguration()
        let schemeHandler = RigSchemeHandler(root: RigPaths.appDir, docs: RigPaths.docsDir)
        let bridgeHandler = RigBridgeHandler()
        let navDelegate = RigNavigationDelegate()
        let libraryHandler = RigLibrary()
        scheme = schemeHandler
        bridge = bridgeHandler
        navigation = navDelegate
        library = libraryHandler
        conf.setURLSchemeHandler(schemeHandler, forURLScheme: RigSchemeHandler.scheme)
        let ucc = WKUserContentController()
        ucc.add(WeakScriptHandler(bridgeHandler), name: "rig")
        ucc.addScriptMessageHandler(WeakReplyHandler(libraryHandler), contentWorld: .page, name: "rigShell")
        ucc.addUserScript(WKUserScript(source: RigHost.documentStartScript, injectionTime: .atDocumentStart,
                                       forMainFrameOnly: true))
        conf.userContentController = ucc
        conf.preferences.javaScriptCanOpenWindowsAutomatically = false
        #if os(iOS)
        conf.allowsInlineMediaPlayback = true
        #endif
        let wv = WKWebView(frame: .zero, configuration: conf)
        #if DEBUG
        wv.isInspectable = true // Safari > Develop > <device> > Worship Rig
        #endif
        #if os(iOS)
        wv.scrollView.pinchGestureRecognizer?.isEnabled = false // WEBKIT_AUDIT 6: inputs < 16 px zoom the page
        wv.scrollView.bounces = false
        #endif
        wv.navigationDelegate = navDelegate
        wv.uiDelegate = navDelegate // target=_blank / window.open (RigNavigation)
        webView = wv
        super.init()
        bridge.host = self
        navigation.host = self
        library.host = self
        RigPaths.ensureDirectories()
        audio = RigAudio(host: self)
        midi = RigMIDI(host: self)
        createEngine()
        lifecycle = RigLifecycle(host: self)
        loadUI()
    }

    private func loadUI() {
        let url = URL(string: "\(RigSchemeHandler.scheme)://\(RigSchemeHandler.host)/index.html")!
        webView.load(URLRequest(url: url))
    }

    /// The web content process died (SETUP_REVIEW 27a). The core keeps running; the dead page can no longer release
    /// its notes or stop its recording, so do that here, drop events addressed to the dead page, and load the UI again.
    func webContentDidTerminate(loop: Bool) {
        pumpLock.lock()
        pending.removeAll()
        pumpLock.unlock()
        post(Data(#"[{"v":1,"op":"play","e":"panic"},{"v":1,"op":"rec","action":"stop"}]"#.utf8))
        if loop {
            webView.loadHTMLString(RigNavigationDelegate.crashLoopHTML, baseURL: nil)
        } else {
            loadUI() // reload() is unreliable here: webView.url may be nil after a termination
        }
    }

    deinit {
        audio?.stop()
        rig_destroy(engine)
        hostPtr.deallocate()
        keep.forEach { free($0) }
    }

    /// Runs before any page script: native -> JS deliveries that arrive early are parked in `queue`, and
    /// webkitTransport() (app/js/engine-bridge/transports.js) replays them when the engine bridge attaches.
    static let documentStartScript = """
    (function () {
      if (!window.__rigNative) window.__rigNative = { queue: [], receive: function (b) { this.queue.push(b); } };
      window.__rigShell = { native: true, platform: '\(RigHost.platformName)', shellVersion: 2 };
    })();
    \(RigLibrary.polyfill(platform: RigHost.platformName))
    """

    static var platformName: String {
        #if os(macOS)
        return "macos"
        #else
        return "ipados"
        #endif
    }

    // MARK: engine creation

    private func cstr(_ s: String) -> UnsafePointer<CChar> {
        let p = strdup(s)!
        keep.append(p)
        return UnsafePointer(p)
    }

    private func createEngine() {
        var cfg = rig_config()
        rig_config_init(&cfg)
        cfg.struct_size = UInt32(MemoryLayout<rig_config>.size)
        cfg.mode = RIG_MODE_REALTIME
        #if os(iOS)
        cfg.profile = RIG_PROFILE_IPAD
        #else
        cfg.profile = RIG_PROFILE_DESKTOP
        #endif
        cfg.app_dir = cstr(RigPaths.appDir.path)
        cfg.recordings_dir = cstr(RigPaths.recordingsDir.path)
        cfg.on_event = { user, json, len in
            guard let user, let json else { return }
            let host = Unmanaged<RigHost>.fromOpaque(user).takeUnretainedValue()
            let bytes = UnsafeRawPointer(json).assumingMemoryBound(to: UInt8.self)
            let text = String(decoding: UnsafeBufferPointer(start: bytes, count: len), as: UTF8.self)
            host.enqueue(text)
        }
        cfg.event_user = Unmanaged.passUnretained(self).toOpaque()
        cfg.on_log = { _, level, msg in
            if let msg { NSLog("rig[%d] %@", level, String(cString: msg)) }
        }

        var host = rig_host()
        host.struct_size = UInt32(MemoryLayout<rig_host>.size)
        host.user = Unmanaged.passUnretained(self).toOpaque()
        host.audio_start = { user, deviceId, latency, channels in
            RigHost.from(user).audio.start(deviceId: deviceId.map { String(cString: $0) }, latency: latency,
                                           channels: channels)
        }
        // T00c D2 (UNBUILT here): the core prefers this over audio_start; it carries `audio {bufferFrames}`
        host.audio_start_frames = { user, deviceId, latency, channels, frames in
            RigHost.from(user).audio.start(deviceId: deviceId.map { String(cString: $0) }, latency: latency,
                                           channels: channels, bufferFrames: frames)
        }
        host.audio_stop = { user in RigHost.from(user).audio.stop() }
        host.audio_list_devices = { _, buf, cap in
            guard let buf else { return rig_apple_audio_list_devices(nil, 0) }
            return RigAudio.listDevices(into: buf, cap: cap)
        }
        host.midi_listen = { user, idsJson in
            guard let idsJson else { return }
            RigHost.from(user).midi.listen(idsJSON: String(cString: idsJson))
        }
        host.midi_send = { user, port, bytes, len, hostNs in
            guard let port, let bytes else { return }
            RigHost.from(user).midi.send(port: String(cString: port), bytes: bytes, count: len, hostTimeNs: hostNs)
        }
        host.decode_file = { user, path, out in
            guard let path, let out else { return -1 }
            return rig_apple_decode_file(user, path, out)
        }
        host.free_decoded = { user, audio in
            guard let audio else { return }
            rig_apple_free_decoded(user, audio)
        }
        host.host_time_ns = { user in rig_apple_host_time_ns(user) }
        hostPtr.initialize(to: host)
        cfg.host = UnsafePointer(hostPtr)

        var status = RIG_OK
        engine = rig_create(&cfg, &status)
        if engine == nil {
            NSLog("rig_create failed: %@", String(cString: rig_status_string(status))) // %@: Swift String (S2)
        }
    }

    static func from(_ user: UnsafeMutableRawPointer?) -> RigHost {
        Unmanaged<RigHost>.fromOpaque(user!).takeUnretainedValue()
    }

    // MARK: JS -> core

    /// One BRIDGE v1 message or array, JSON bytes. Processed FIFO by the core's control queue.
    func post(_ data: Data) {
        guard let engine else { return }
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            let s = rig_post(engine, base.assumingMemoryBound(to: CChar.self), data.count)
            if s != RIG_OK { NSLog("rig_post: %@", String(cString: rig_status_string(s))) }
        }
    }

    // MARK: core -> JS

    fileprivate func enqueue(_ json: String) {
        pumpLock.lock()
        pending.append(json)
        let schedule = !flushScheduled
        flushScheduled = true
        pumpLock.unlock()
        if schedule { DispatchQueue.main.async { [weak self] in self?.flush() } }
    }

    private func flush() {
        pumpLock.lock()
        let batch = pending
        pending.removeAll(keepingCapacity: true)
        flushScheduled = false
        pumpLock.unlock()
        guard !batch.isEmpty else { return }
        // each entry is a message object or an array of them: nested arrays are flattened by BridgeLink._receive
        let js = "window.__rigNative.receive([\(batch.joined(separator: ","))]);"
        webView.evaluateJavaScript(js) { _, error in
            if let error { NSLog("receive failed: %@", error.localizedDescription) }
        }
    }
}

/// WKUserContentController retains its handlers: go through a weak proxy so RigHost can deinit.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

final class RigBridgeHandler: NSObject, WKScriptMessageHandler {
    weak var host: RigHost?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let host else { return }
        guard JSONSerialization.isValidJSONObject(message.body),
              let data = try? JSONSerialization.data(withJSONObject: message.body, options: [])
        else {
            NSLog("rig bridge: message is not JSON")
            return
        }
        host.post(data)
    }
}
