// RigHost: owns the core engine (rig_engine*), the WKWebView, and the glue between them. UNBUILT on Linux.
//
//   page JS --webkit.messageHandlers.rig--> RigBridgeHandler --JSON--> rig_post()            (main thread)
//   core event callback (control thread) --> pending batch --main--> window.__rigNative.receive([...])
//   core --rig_host vtable--> RigAudio (AUHAL/RemoteIO, C render callback) and RigMIDI (CoreMIDI)
//
//   page JS --webkit.messageHandlers.rigShell {m}--> RigShellRouter --> RigLibrary / RigInfo / RigFiles
//            (window.rig, lane N0: the JS is app/js/native-shell/*.js, injected at document start by RigShellScripts)
//
// What this deliberately does not do yet (native/docs/lanes/NATIVE-GAPS.md lanes N1-N9): menu bar, hotkeys, the rest
// of window.rig (backupNow / latestBackup / onMenu / getInfo / saveText exist), importer, pads, update check.
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
    /// window.rig.saveText, WKDownloads and the open panel (lane N3, RigFiles.swift).
    let files: RigFiles
    /// The Mac command bus and the browser remote (remote lane, D45, RigBus.swift).
    let bus: RigBus
    /// window.rig's message handler (`rigShell`); WeakReplyHandler holds it weakly, so the host keeps it.
    private let shellRouter: RigShellRouter
    private(set) var audio: RigAudio!
    private(set) var midi: RigMIDI!
    private var lifecycle: RigLifecycle?
    /// Self-test mode (RigSelfTest.swift, E4): observation hooks, a non-persistent data store and the null output
    /// instead of RigAudio. nil in the normal app.
    let selfTest: RigSelfTestHooks?
    private let sinkLock = NSLock()
    private var nullSink: OpaquePointer? // rig_apple_null_sink*, self-test only; guarded by sinkLock
    private var nullSinkStarts = 0
    private var nullSinkClosed = false // set by stopNullSink(closing:): no audio_start may start another (E4 review E5)

    // C strings handed to rig_config / rig_host must outlive the engine.
    private var keep: [UnsafeMutablePointer<CChar>] = []
    private var hostPtr = UnsafeMutablePointer<rig_host>.allocate(capacity: 1)

    // event pump (core control thread -> main thread, one evaluateJavaScript per turn)
    private let pumpLock = NSLock()
    private var pending: [String] = []
    private var flushScheduled = false

    init(selfTest: RigSelfTestHooks? = nil) {
        // Phase 1 of a class init must not read `self` (scheme, bridge) before super.init: build locals first
        // (SETUP_REVIEW S1).
        self.selfTest = selfTest
        let conf = WKWebViewConfiguration()
        let schemeHandler = RigSchemeHandler(root: RigPaths.appDir, docs: RigPaths.docsDir)
        let bridgeHandler = RigBridgeHandler()
        let navDelegate = RigNavigationDelegate()
        let libraryHandler = RigLibrary()
        let filesHandler = RigFiles()
        let busHandler = RigBus()
        let router = RigShellRouter()
        router.register(libraryHandler)
        router.register(RigInfo())
        router.register(filesHandler)
        router.register(busHandler)
        shellRouter = router
        scheme = schemeHandler
        bridge = bridgeHandler
        navigation = navDelegate
        library = libraryHandler
        files = filesHandler
        bus = busHandler
        if selfTest != nil { busHandler.persist = false } // the self-test never reads or writes the remote setting
        conf.setURLSchemeHandler(schemeHandler, forURLScheme: RigSchemeHandler.scheme)
        let ucc = WKUserContentController()
        if let hooks = selfTest {
            // E4: nothing of the run survives it (no localStorage left in the app's real data store), and the page
            // hook is the first document-start script, so it sees errors thrown by everything after it
            conf.websiteDataStore = .nonPersistent()
            schemeHandler.onStatus = { url, status in hooks.httpStatus?(url, status) }
            libraryHandler.autoOffer = false
            libraryHandler.persistAnswer = false
            ucc.add(RigSelfTestMessageHandler(hooks), name: "rigSelfTest")
            ucc.addUserScript(WKUserScript(source: RigSelfTestScripts.pageHook, injectionTime: .atDocumentStart,
                                           forMainFrameOnly: true))
        }
        ucc.add(WeakScriptHandler(bridgeHandler), name: "rig")
        ucc.addScriptMessageHandler(WeakReplyHandler(router), contentWorld: .page, name: "rigShell")
        let shellScript = RigShellScripts.documentStart(appDir: RigPaths.appDir, config: RigHost.shellConfig)
        ucc.addUserScript(WKUserScript(source: shellScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
        files.host = self
        bus.host = self
        RigPaths.ensureDirectories()
        audio = RigAudio(host: self)
        midi = RigMIDI(host: self)
        createEngine()
        lifecycle = RigLifecycle(host: self)
        loadUI()
        bus.restore() // the remote on, if Settings › Remote left it on (D34: off by default)
    }

    private func loadUI() {
        let url = URL(string: "\(RigSchemeHandler.scheme)://\(RigSchemeHandler.host)/index.html")!
        webView.load(URLRequest(url: url))
    }

    /// What a page leaves behind in the core when it goes: its held notes and pedal, and its recording.
    private static let releasePage = Data(#"[{"v":1,"op":"play","e":"panic"},{"v":1,"op":"rec","action":"stop"}]"#.utf8)

    /// The web content process died (SETUP_REVIEW 27a). The core keeps running; the dead page can no longer release
    /// its notes or stop its recording, so do that here, drop events addressed to the dead page, and load the UI again.
    func webContentDidTerminate(loop: Bool) {
        pumpLock.lock()
        pending.removeAll()
        pumpLock.unlock()
        post(Self.releasePage)
        if loop {
            webView.loadHTMLString(RigNavigationDelegate.crashLoopHTML, baseURL: nil)
        } else {
            loadUI() // reload() is unreliable here: webView.url may be nil after a termination
        }
    }

    /// NMA review O5 (lane N0): every main-frame load (a reload such as Settings › My Samples "Reload", the crash
    /// reload, the first load) gets the same release as a crash: the core outlives the page, and the new page's
    /// controller cannot release notes, a pedal or a recording the old one held. `play panic` keeps the drone
    /// (ENGINE_CONTRACT allNotesOff); `rec stop` with nothing recording is a no-op (SHELL.md "Recording ownership":
    /// a reload stops the recording, as a 1.x reload did). The pump queue is NOT dropped here: didCommit can arrive
    /// after the new page has already posted `hello`, whose reply must not be lost. The page side does its own
    /// allNotesOff after `hello` (skeptic NMA F1); this is the native belt.
    func pageDidCommit() {
        post(Self.releasePage)
    }

    deinit {
        audio?.stop()
        stopNullSink()
        rig_destroy(engine)
        hostPtr.deallocate()
        keep.forEach { free($0) }
    }

    /// window.__rigShellConfig for app/js/native-shell/00-core.js (which also parks early native -> JS deliveries in
    /// `__rigNative.queue` for webkitTransport()). menuOwnsShortcuts / keepsAwake stay false until lane N5 binds the
    /// menu key equivalents and holds the display-sleep assertion: true without them would leave ⌘. ⌘E ⌘R ⌘⇧F dead
    /// and the screen free to sleep.
    static var shellConfig: [String: Any] {
        ["platform": platformName, "menuOwnsShortcuts": false, "keepsAwake": false]
    }

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
            RigHost.from(user).audioStart(deviceId: deviceId.map { String(cString: $0) }, latency: latency,
                                          channels: channels, bufferFrames: 0)
        }
        // T00c D2 (UNBUILT here): the core prefers this over audio_start; it carries `audio {bufferFrames}`
        host.audio_start_frames = { user, deviceId, latency, channels, frames in
            RigHost.from(user).audioStart(deviceId: deviceId.map { String(cString: $0) }, latency: latency,
                                          channels: channels, bufferFrames: frames)
        }
        host.audio_stop = { user in RigHost.from(user).audioStop() }
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

    // MARK: output device (rig_host.audio_start / audio_stop, on the core's device thread)

    fileprivate func audioStart(deviceId: String?, latency: Double, channels: UInt32, bufferFrames: UInt32) {
        guard selfTest != nil else {
            return audio.start(deviceId: deviceId, latency: latency, channels: channels, bufferFrames: bufferFrames)
        }
        // E4 self-test: no device (the CI runner has none). The null output reports itself to the core and renders
        // on its own thread at 48 kHz; a restart (audio_stop then audio_start) replaces it.
        guard let e = engine else { return }
        sinkLock.lock()
        defer { sinkLock.unlock() }
        guard !nullSinkClosed else { return } // the run is ending: the process exits next (RigSelfTestRunner.finish)
        if let old = nullSink { rig_apple_null_sink_stop(old, 0) }
        nullSink = rig_apple_null_sink_start(e, 48000, channels, bufferFrames)
        nullSinkStarts += 1
    }

    fileprivate func audioStop() {
        guard selfTest != nil else { return audio.stop() }
        stopNullSink(report: true)
    }

    /// Self-test: stop the null output (joins its thread: no rig_render after this returns). `closing`: also refuse
    /// every later audio_start, so a restart the core issues on its device thread while the runner exits cannot
    /// start rendering again under exit()'s static destructors.
    func stopNullSink(report: Bool = false, closing: Bool = false) {
        sinkLock.lock()
        defer { sinkLock.unlock() }
        if closing { nullSinkClosed = true }
        if let s = nullSink { rig_apple_null_sink_stop(s, report ? 1 : 0) }
        nullSink = nil
    }

    /// Self-test: what the null output has rendered (zeros when it is not running).
    func nullSinkStats() -> (frames: UInt64, errors: UInt64, late: UInt64, starts: Int) {
        sinkLock.lock()
        defer { sinkLock.unlock() }
        guard let s = nullSink else { return (0, 0, 0, nullSinkStarts) }
        return (rig_apple_null_sink_frames(s), rig_apple_null_sink_errors(s), rig_apple_null_sink_late(s),
                nullSinkStarts)
    }

    /// Self-test: peak |sample| on the null output since the last reset.
    func nullSinkPeak(reset: Bool) -> Float {
        sinkLock.lock()
        defer { sinkLock.unlock() }
        guard let s = nullSink else { return 0 }
        return rig_apple_null_sink_peak(s, reset ? 1 : 0)
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
        selfTest?.incoming?(batch)
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
        host.selfTest?.outgoing?(message.body)
        host.post(data)
    }
}
