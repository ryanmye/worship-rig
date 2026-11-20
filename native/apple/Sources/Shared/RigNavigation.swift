// WKNavigationDelegate for the single web view. UNBUILT on Linux. SETUP_REVIEW 27 / 3.5 (HIGH 8).
//
//  1. External links: anything that is not the rig:// app is opened in the system browser and cancelled here, so the
//     app's only web view can never navigate away from rig://app/ (docs, update check, target=_blank links).
//  2. WebContent process termination (routine on iPad under memory pressure; also a crash): the window would stay
//     blank while the core keeps sounding. Reset the event pump, silence and finalise what the dead page owned, and
//     load the UI again. The fresh page runs the normal boot: BridgeEngine -> `hello` -> `state` -> `get state` ->
//     the controller re-prepares and commits the current song from the library (localStorage survives the crash).
//     A loop of crashes (3 in 60 s) stops at a static page with a Reload link instead of reloading forever.
import Foundation
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum RigExternal {
    static func open(_ url: URL) {
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        #endif
    }
}

final class RigNavigationDelegate: NSObject, WKNavigationDelegate {
    weak var host: RigHost?
    private var terminations: [Date] = []

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        switch url.scheme?.lowercased() ?? "" {
        case RigSchemeHandler.scheme, "about", "blob", "data":
            decisionHandler(.allow)
        case "http", "https", "mailto":
            // a user click or window.open; never load it in this view
            RigExternal.open(url)
            decisionHandler(.cancel)
        default:
            NSLog("rig: blocked navigation to %@", url.absoluteString)
            decisionHandler(.cancel)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let now = Date()
        terminations = terminations.filter { now.timeIntervalSince($0) < 60 } + [now]
        NSLog("rig: web content process terminated (%d in the last minute)", terminations.count)
        host?.webContentDidTerminate(loop: terminations.count >= 3)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // first successful load of the app: the one-time Electron library offer (RigLibrary)
        if webView.url?.scheme == RigSchemeHandler.scheme { host?.library.offerFirstLaunchImport() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("rig: navigation failed: %@", error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("rig: provisional navigation failed: %@", error.localizedDescription)
    }

    static let crashLoopHTML = """
    <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <body style="font:17px -apple-system,system-ui;background:#111;color:#eee;padding:48px;text-align:center">
    <h2>Worship Rig's interface stopped repeatedly</h2>
    <p>The sound engine is still running. Your library is saved.</p>
    <p><a style="color:#8cf" href="rig://app/index.html">Reload the interface</a></p>
    """
}
