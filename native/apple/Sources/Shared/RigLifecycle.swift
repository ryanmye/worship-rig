// Memory pressure and app lifecycle hooks. UNBUILT on Linux. SETUP_REVIEW 21a / 3.3 (iPad memory).
//
//   iPad   UIApplication.didReceiveMemoryWarning -> rig_host_memory_pressure(level) + a page event.
//          The first warning is level 1 (drop unpinned decoded buffers and idle reverb units); a second one within
//          30 s is level 2 (critical: also drop pins beyond the current song). iOS has no separate "critical" signal.
//   macOS  DispatchSource memory-pressure source: .warning -> 1, .critical -> 2.
//   iPad   didBecomeActive: if the output was interrupted and never resumed, try again (RigAudio.resumeIfNeeded).
// The core answers with a `warn` event (code 'memory') that reaches JS over the normal bridge; the extra DOM event
// `rig:memory` {detail:{level}} lets UI code that does not listen to the bridge (nobody yet) trim its own caches.
import Foundation
import WebKit
#if os(iOS)
import UIKit
#endif

final class RigLifecycle {
    private unowned let host: RigHost
    private var lastWarning: Date?
    private var tokens: [NSObjectProtocol] = []
    #if os(macOS)
    private var source: DispatchSourceMemoryPressure?
    #endif

    init(host: RigHost) {
        self.host = host
        #if os(iOS)
        let nc = NotificationCenter.default
        tokens.append(nc.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil,
                                     queue: .main) { [weak self] _ in
            guard let self else { return }
            let now = Date()
            let repeated = self.lastWarning.map { now.timeIntervalSince($0) < 30 } ?? false
            self.lastWarning = now
            self.pressure(level: repeated ? 2 : 1)
        })
        tokens.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil,
                                     queue: .main) { [weak self] _ in self?.host.audio.resumeIfNeeded() })
        #else
        let src = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        // read the event through self.source: `[weak src]` needs a class-bound protocol type, which
        // DispatchSourceMemoryPressure is not guaranteed to be (WAVE0B_REVIEW S5)
        src.setEventHandler { [weak self] in
            guard let self, let s = self.source else { return }
            self.pressure(level: s.data.contains(.critical) ? 2 : 1)
        }
        src.resume()
        source = src
        #endif
    }

    deinit {
        tokens.forEach { NotificationCenter.default.removeObserver($0) }
        #if os(macOS)
        source?.cancel()
        #endif
    }

    func pressure(level: Int32) {
        NSLog("rig: memory pressure level %d", level)
        // Declared in rig_engine.h by T00b (SETUP_REVIEW 21a). If the core you linked predates it, the link fails with
        // "Undefined symbols: _rig_host_memory_pressure": rebuild the core (scripts/build-core.sh) or comment this out.
        if let e = host.engine { rig_host_memory_pressure(e, level) }
        host.webView.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('rig:memory', { detail: { level: \(level) } }));",
            completionHandler: nil)
    }
}
