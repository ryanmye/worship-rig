// WKNavigationDelegate for the single web view. UNBUILT on Linux. SETUP_REVIEW 27 / 3.5 (HIGH 8).
//
//  1. External links: anything that is not the rig:// app is opened in the system browser and cancelled here, so the
//     app's only web view can never navigate away from rig://app/ (docs, update check, target=_blank links).
//  2. WebContent process termination (routine on iPad under memory pressure; also a crash): the window would stay
//     blank while the core keeps sounding. Reset the event pump, silence and finalise what the dead page owned, and
//     load the UI again. The fresh page runs the normal boot: BridgeEngine -> `hello` -> `state` -> `get state` ->
//     the controller re-prepares and commits the current song from the library (localStorage survives the crash).
//     A loop of crashes (3 in 60 s) stops at a static page with a Reload link instead of reloading forever.
//  3. Every main-frame commit (lane N0, NMA review O5): panic + rec stop for whatever the previous page held.
//  4. Files (lane N3, B2): a main-frame blob: / data: load is cancelled, an <a download> becomes a WKDownload
//     (RigFiles), and <input type=file> gets NSOpenPanel on macOS (runOpenPanelWith).
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

final class RigNavigationDelegate: NSObject, WKNavigationDelegate, WKUIDelegate {
    weak var host: RigHost?
    private var terminations: [Date] = []

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        let local = scheme == RigSchemeHandler.scheme || scheme == "blob" || scheme == "data"
        // Lane N3 (B2, NATIVE-GAPS finding 8, n0-skeptic O1): an <a download> the page's listener (native-shell
        // 30-files.js) did not take over becomes a WKDownload (RigFiles: a temp file at once, then the save panel),
        // never a page load
        if local && navigationAction.shouldPerformDownload { return decisionHandler(.download) }
        switch scheme {
        case RigSchemeHandler.scheme, "about":
            decisionHandler(.allow)
        case "blob", "data":
            // a main-frame (or new-window) load of a blob: / data: URL would replace the UI, and its commit sends
            // panic + rec stop (pageDidCommit), ending a recording; frames inside the page may still use them
            if navigationAction.targetFrame?.isMainFrame ?? true {
                NSLog("rig: cancelled a page load of a %@: URL", scheme)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        case "http", "https", "mailto":
            // a user click or window.open; never load it in this view
            RigExternal.open(url)
            decisionHandler(.cancel)
        default:
            NSLog("rig: blocked navigation to %@", url.absoluteString)
            decisionHandler(.cancel)
        }
    }

    /// Lane N3: the `.download` answer above hands the download over here; RigFiles is its delegate.
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        host?.files.adopt(download)
    }

    #if os(macOS)
    /// Lane N3 (B2, LaneR F2): <input type=file> (Settings › Import…, Edit's Import…, the chart's Import file, pad
    /// files). Without this WKWebView on macOS shows no panel at all. The iPad shows WebKit's own picker.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard let files = host?.files else { return completionHandler(nil) }
        files.runOpenPanel(parameters, completionHandler: completionHandler)
    }
    #endif

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let now = Date()
        terminations = terminations.filter { now.timeIntervalSince($0) < 60 } + [now]
        NSLog("rig: web content process terminated (%ld in the last minute)", terminations.count)
        host?.selfTest?.contentTerminated?()
        host?.webContentDidTerminate(loop: terminations.count >= 3)
    }

    /// New-window requests (target=_blank, window.open) that decidePolicyFor did not already cancel: never create a
    /// second web view; http(s)/mailto open outside. Belt and braces for WebKit versions that skip the policy call
    /// for new windows [verify on the Mac] (WAVE0B_REVIEW S6).
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let external = ["http", "https", "mailto"]
        if let url = navigationAction.request.url, external.contains(url.scheme?.lowercased() ?? "") {
            RigExternal.open(url)
        }
        return nil
    }

    /// Lane N0 (NMA review O5): the old page is gone once a main-frame navigation commits; release what it held in
    /// the core (RigHost.pageDidCommit: panic + rec stop), whatever replaced it (a reload, the crash page, the UI).
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        host?.selfTest?.pageCommitted?(webView.url)
        host?.pageDidCommit()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        host?.selfTest?.pageFinished?(webView.url)
        // first successful load of the app: the one-time Electron library offer (RigLibrary; not in the self-test,
        // which starts it itself)
        if webView.url?.scheme == RigSchemeHandler.scheme { host?.library.offerFirstLaunchImport() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("rig: navigation failed: %@", error.localizedDescription)
        host?.selfTest?.pageFailed?(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("rig: provisional navigation failed: %@", error.localizedDescription)
        host?.selfTest?.pageFailed?("provisional: \(error.localizedDescription)")
    }

    static let crashLoopHTML = """
    <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <body style="font:17px -apple-system,system-ui;background:#111;color:#eee;padding:48px;text-align:center">
    <h2>Worship Rig's interface stopped repeatedly</h2>
    <p>The sound engine is still running. Your library is saved.</p>
    <p><a style="color:#8cf" href="rig://app/index.html">Reload the interface</a></p>
    """
}
