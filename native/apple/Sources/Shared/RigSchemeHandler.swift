// rig://app/... : serves the bundled app/ folder to the WKWebView, replacing server.js (WEBKIT_AUDIT section 2).
// UNBUILT on Linux.
//
// Routes: the static tree under app/ (no samples: the native engine reads them straight from the bundle),
// /docs/<name>.md as text/plain, and the JSON routes /api/health, /api/user-samples,
// /api/user-samples/manifest.json, /api/user-patches. /api/heartbeat answers 204 (inert on a non-http scheme anyway).
// Anything outside app/ or containing ".." is a 404 (safeJoin semantics of server.js).
// Patch packs (DECISIONS O-AW-PP, lane N1): the My Samples roots are RigPaths.userSampleRoots. /api/health says
// userPatches: true and lists 'user-patches' only when a pack there has a songs/*.json (rig_hostkit_has_patches,
// server.js hasUserPatches), so a Mac without packs makes no request; /api/user-patches is rig_hostkit's port of
// server.js scanUserPatches, byte for byte (test/unit/hostkit/parity.test.mjs). Both run on `queue` (file I/O), never
// on the main thread. `user:` instruments are not checked (null ids) until My Samples sound exists (lane N2).
// The manifest stays empty: no audio is served over rig:// (the core reads files itself, N2).
//
// While the app edit of native/docs/SHELL.md section 2 is not applied, `patchMain` serves js/main.js with its engine
// import swapped for ./engine-bridge/select.js (the same one-line change the Playwright smoke applies). The needle is
// checked; if main.js changed, it is served untouched and a log line says so.
import Foundation
import WebKit

final class RigSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "rig"
    static let host = "app"

    private let root: URL
    private let docs: URL
    private let patchMain: Bool
    private let queue = DispatchQueue(label: "rig.scheme", qos: .userInitiated, attributes: .concurrent)
    private let lock = NSLock()
    private var stopped = Set<ObjectIdentifier>()
    /// Every response's URL and status, on the main thread (the self-test counts the ones >= 400, E4). nil normally.
    var onStatus: ((String, Int) -> Void)?

    init(root: URL, docs: URL, patchMain: Bool = true) {
        self.root = root.standardizedFileURL
        self.docs = docs.standardizedFileURL
        self.patchMain = patchMain
    }

    private static let mime: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json", "svg": "image/svg+xml", "png": "image/png",
        "woff2": "font/woff2", "ico": "image/x-icon", "md": "text/plain; charset=utf-8",
        "txt": "text/plain; charset=utf-8",
        "mp3": "audio/mpeg", "wav": "audio/wav", "webmanifest": "application/manifest+json",
    ]

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        lock.lock(); stopped.remove(id); lock.unlock()
        guard let url = task.request.url else { return fail(task, 400, "bad url") }
        var path = url.path.removingPercentEncoding ?? url.path
        if path.isEmpty || path.hasSuffix("/") { path += "index.html" }
        if path.contains("..") { return fail(task, 404, "not found") }
        let range = task.request.value(forHTTPHeaderField: "Range")

        switch path {
        case "/api/health":
            return queue.async { [weak self] in
                let packs = rig_hostkit_has_patches(RigPaths.userSampleRootsJSON) == 1
                let features: [String] = packs ? ["native", "user-samples", "user-patches"] : ["native", "user-samples"]
                self?.json(task, ["ok": true, "app": "worship-rig", "version": "native", "userSamples": true,
                                  "userPatches": packs, "features": features])
            }
        case "/api/user-samples":
            let roots = RigPaths.userSampleRoots.map { $0.path }
            let shown = RigPaths.userSamplesShownName ?? roots.first ?? "" // Settings' "Folder: …" line
            return json(task, ["enabled": true, "dir": shown, "path": shown, "roots": roots,
                               "count": 0, "packs": [String](), "errors": [String]()])
        case "/api/user-samples/manifest.json":
            return json(task, ["app": "worship-rig", "kind": "user-samples", "instruments": [String](),
                               "roots": RigPaths.userSampleRoots.map { $0.path },
                               "packs": [String](), "errors": [String]()])
        case "/api/user-patches":
            return queue.async { [weak self] in
                guard let body = rig_hostkit_user_patches_json(RigPaths.userSampleRootsJSON, nil) else {
                    self?.fail(task, 500, "out of memory")
                    return
                }
                defer { rig_hostkit_free(body) }
                self?.respond(task, status: 200, type: "application/json; charset=utf-8",
                              body: Data(bytes: body, count: strlen(body)))
            }
        case "/api/heartbeat", "/favicon.ico":
            return respond(task, status: 204, type: "text/plain", body: Data())
        default:
            break
        }

        let file: URL
        if path.hasPrefix("/docs/"), path.hasSuffix(".md") {
            file = docs.appendingPathComponent(String(path.dropFirst(6))).standardizedFileURL
            guard file.path.hasPrefix(docs.path) else { return fail(task, 404, "not found") }
        } else {
            file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
            guard file.path.hasPrefix(root.path) else { return fail(task, 404, "not found") }
        }
        queue.async { [weak self] in
            guard let self else { return }
            guard var data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
                return self.fail(task, 404, "not found")
            }
            if self.patchMain, path == "/js/main.js" { data = Self.patchedMain(data) }
            let type = Self.mime[file.pathExtension.lowercased()] ?? "application/octet-stream"
            if let r = range, let (lo, hi) = Self.parseRange(r, size: data.count) {
                let part = data.subdata(in: lo..<(hi + 1))
                self.respond(task, status: 206, type: type, body: part,
                             extra: ["Content-Range": "bytes \(lo)-\(hi)/\(data.count)", "Accept-Ranges": "bytes"])
            } else {
                self.respond(task, status: 200, type: type, body: data, extra: ["Accept-Ranges": "bytes"])
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock()
    }

    // MARK: helpers

    static func patchedMain(_ data: Data) -> Data {
        let needle = "import { AudioEngine } from './engine/index.js';"
        let repl = "import { AudioEngine } from './engine-bridge/select.js';"
        guard var s = String(data: data, encoding: .utf8), s.contains(needle) else {
            NSLog("RigSchemeHandler: main.js engine import not found; served untouched (apply the SHELL.md app edit)")
            return data
        }
        s = s.replacingOccurrences(of: needle, with: repl)
        return Data(s.utf8)
    }

    static func parseRange(_ header: String, size: Int) -> (Int, Int)? {
        guard header.hasPrefix("bytes="), size > 0 else { return nil }
        let spec = header.dropFirst(6).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard spec.count == 2 else { return nil }
        if spec[0].isEmpty, let n = Int(spec[1]), n > 0 { return (max(0, size - n), size - 1) }
        guard let lo = Int(spec[0]), lo < size else { return nil }
        let hi = Int(spec[1]).map { min($0, size - 1) } ?? size - 1
        return hi >= lo ? (lo, hi) : nil
    }

    private func json(_ task: any WKURLSchemeTask, _ obj: [String: Any]) {
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        respond(task, status: 200, type: "application/json", body: data)
    }

    private func fail(_ task: any WKURLSchemeTask, _ status: Int, _ text: String) {
        respond(task, status: status, type: "text/plain", body: Data(text.utf8))
    }

    /// WKURLSchemeTask must be answered on the main thread, and never after `stop`.
    private func respond(_ task: any WKURLSchemeTask, status: Int, type: String, body: Data,
                         extra: [String: String] = [:]) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let id = ObjectIdentifier(task)
            self.lock.lock(); let gone = self.stopped.contains(id); self.lock.unlock()
            if gone { return }
            var headers = ["Content-Type": type, "Content-Length": String(body.count), "Cache-Control": "no-store",
                           "X-Content-Type-Options": "nosniff"]
            extra.forEach { headers[$0.key] = $0.value }
            guard let url = task.request.url,
                  let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                             headerFields: headers)
            else { return }
            task.didReceive(resp)
            task.didReceive(body)
            task.didFinish()
            self.onStatus?(url.absoluteString, status)
        }
    }
}
