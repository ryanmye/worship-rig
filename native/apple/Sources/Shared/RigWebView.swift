// SwiftUI wrapper around the host's WKWebView. UNBUILT on Linux.
import SwiftUI
import WebKit

#if os(macOS)
struct RigWebView: NSViewRepresentable {
    let host: RigHost
    func makeNSView(context: Context) -> WKWebView { host.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#else
struct RigWebView: UIViewRepresentable {
    let host: RigHost
    func makeUIView(context: Context) -> WKWebView { host.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#endif
