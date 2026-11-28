// Saving and opening files from the page (lane N3, release blocker B2). UNBUILT on Linux (compiled only by CI
// mac-check). The JS is app/js/native-shell/30-files.js; it is tested on Linux against a fake handler
// (test/unit/native-shell/files.test.mjs) and in the real app (test/phase2/native-shell).
//
//   saveFile {name, text | base64} -> {saved: true, name, path?} | {canceled: true} | {error}   (window.rig.saveText)
//       Mac: NSSavePanel (a sheet on the window), then an atomic write. iPad: a temp file handed to
//       UIDocumentPickerViewController(forExporting:asCopy: true) (Files, AirDrop through the share sheet).
//       `saveDir` (RIG_SAVE_DIR, the self-test) writes there with no panel.
//   adopt(WKDownload)  the fallback for an <a download> the page's listener did not see (RigNavigation answers
//       `.download`): WebKit writes it to a temp file at once (the blob can be revoked under a slow panel, NATIVE-GAPS
//       finding 8), then the same panel / picker moves or copies it.
//   runOpenPanel       (macOS) <input type=file>: WKUIDelegate's runOpenPanelWith. WebKit passes no accept list, so
//       the page checks the file as in Chrome. The iPad shows WebKit's own picker.
// Everything here runs on the main thread (RigShellRouter, the panels' completions, WKDownloadDelegate); only the
// write itself goes to a utility queue. One panel at a time: a second request while one is open answers `busy`.
import Foundation
import WebKit
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

final class RigFiles: NSObject, RigShellFeature, WKDownloadDelegate {
    let methods: [String] = ["saveFile"]
    weak var host: RigHost?
    /// The largest file written (app/js/native-shell/30-files.js MAX_BYTES; a library export is a few MB).
    static let maxBytes = 64 * 1024 * 1024
    /// Non-nil: save here without a panel (RIG_SAVE_DIR, or the self-test's temp folder).
    var saveDir: URL? = ProcessInfo.processInfo.environment["RIG_SAVE_DIR"].flatMap {
        $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true)
    }
    private var busy = false
    private let io = DispatchQueue(label: "rig.files.io", qos: .userInitiated)
    /// WKDownload → its temp file (keyed by object identity; the delegate calls hand back the same object).
    private var downloads: [ObjectIdentifier: URL] = [:]
    #if os(iOS)
    private var exporter: ExportDelegate? // the picker's delegate is weak: keep it until it answers
    #endif

    // MARK: JS -> Swift

    func handle(_ m: String, _ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard m == "saveFile" else { return reply(["error": "unknown method \(m)"], nil) }
        let data: Data
        if let text = body["text"] as? String {
            data = Data(text.utf8)
        } else if let b64 = body["base64"] as? String, let d = Data(base64Encoded: b64) {
            data = d
        } else {
            return reply(["error": "nothing to save"], nil)
        }
        guard data.count <= Self.maxBytes else { return reply(["error": "file too large"], nil) }
        let name = Self.safeName(body["name"] as? String)
        save(data, name: name, reply: reply)
    }

    /// A file name the panel and the file system accept: no path separators, colons or control characters, no
    /// leading dot (a hidden file), at most 200 characters; "Worship Rig export.json" if nothing is left.
    static func safeName(_ raw: String?) -> String {
        let bad = CharacterSet(charactersIn: "/\\:").union(.controlCharacters)
        let dash: Unicode.Scalar = "-"
        var view = String.UnicodeScalarView()
        for c in (raw ?? "").unicodeScalars { view.append(bad.contains(c) ? dash : c) }
        var s = String(view)
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasPrefix(".") { s.removeFirst() }
        if s.count > 200 { s = String(s.prefix(200)) }
        return s.isEmpty ? "Worship Rig export.json" : s
    }

    private func save(_ data: Data, name: String, reply: @escaping (Any?, String?) -> Void) {
        if let dir = saveDir {
            let url = dir.appendingPathComponent(name)
            return write(data, to: url) { err in
                if let err { return reply(["error": err], nil) }
                reply(["saved": true, "name": name, "path": url.path] as [String: Any], nil)
            }
        }
        guard !busy else { return reply(["error": "busy"], nil) }
        busy = true
        #if os(macOS)
        choose(name) { [weak self] url in
            guard let self else { return reply(["error": "shell gone"], nil) }
            guard let url else {
                self.busy = false
                return reply(["canceled": true], nil)
            }
            self.write(data, to: url) { err in
                self.busy = false
                if let err {
                    self.alert("Could not save \(url.lastPathComponent)", err)
                    return reply(["error": err], nil)
                }
                reply(["saved": true, "name": url.lastPathComponent, "path": url.path] as [String: Any], nil)
            }
        }
        #else
        let tmp = Self.tempFile(name)
        write(data, to: tmp) { [weak self] err in
            guard let self else { return reply(["error": "shell gone"], nil) }
            if let err {
                self.busy = false
                return reply(["error": err], nil)
            }
            self.export(tmp) { picked in
                self.busy = false
                guard let picked else { return reply(["canceled": true], nil) }
                reply(["saved": true, "name": picked.lastPathComponent] as [String: Any], nil)
            }
        }
        #endif
    }

    /// Writes on the io queue (atomically: a cancelled or failed write never leaves half a file); `done` on main.
    private func write(_ data: Data, to url: URL, _ done: @escaping (String?) -> Void) {
        io.async {
            var err: String?
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                        withIntermediateDirectories: true)
                try data.write(to: url, options: .atomic)
            } catch {
                err = error.localizedDescription
            }
            let e = err
            DispatchQueue.main.async { done(e) }
        }
    }

    /// <tmp>/rig-files/<uuid>/<name>: one folder per file, so the name is kept as is (Files and the panel show it).
    private static func tempFile(_ name: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("rig-files", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true).appendingPathComponent(name)
    }

    private static func removeTemp(_ url: URL) {
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }

    // MARK: the fallback: a WKDownload (RigNavigationDelegate answered .download)

    func adopt(_ download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let url = Self.tempFile(Self.safeName(suggestedFilename))
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
        } catch {
            NSLog("rig files: no temp folder for a download: %@", error.localizedDescription)
            return completionHandler(nil)
        }
        downloads[ObjectIdentifier(download)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let tmp = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        deliver(tmp)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        NSLog("rig files: download failed: %@", error.localizedDescription)
        if let tmp = downloads.removeValue(forKey: ObjectIdentifier(download)) { Self.removeTemp(tmp) }
    }

    /// A finished download in its temp folder: into `saveDir`, or through the panel / picker; the temp goes after.
    private func deliver(_ tmp: URL) {
        let name = tmp.lastPathComponent
        if let dir = saveDir {
            return place(tmp, at: dir.appendingPathComponent(name))
        }
        guard !busy else {
            NSLog("rig files: a save panel is open; dropped the download %@", name)
            return Self.removeTemp(tmp)
        }
        busy = true
        #if os(macOS)
        choose(name) { [weak self] url in
            self?.busy = false
            guard let url else { return Self.removeTemp(tmp) }
            self?.place(tmp, at: url)
        }
        #else
        export(tmp) { [weak self] _ in self?.busy = false }
        #endif
    }

    /// Moves `tmp` to `dest` (replacing a file the user agreed to overwrite) and removes the temp folder.
    private func place(_ tmp: URL, at dest: URL) {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: dest.path) {
                _ = try fm.replaceItemAt(dest, withItemAt: tmp)
            } else {
                try fm.moveItem(at: tmp, to: dest)
            }
        } catch {
            NSLog("rig files: could not save %@: %@", dest.path, error.localizedDescription)
            alert("Could not save \(dest.lastPathComponent)", error.localizedDescription)
        }
        Self.removeTemp(tmp)
    }

    // MARK: panels

    #if os(macOS)
    /// NSSavePanel for `name`, as a sheet on the app's window (or on its own without one); `done(nil)` on cancel.
    private func choose(_ name: String, _ done: @escaping (URL?) -> Void) {
        let p = NSSavePanel()
        p.nameFieldStringValue = name
        p.canCreateDirectories = true
        p.isExtensionHidden = false
        let ext = (name as NSString).pathExtension
        if !ext.isEmpty, let t = UTType(filenameExtension: ext) { p.allowedContentTypes = [t] }
        let finish: (NSApplication.ModalResponse) -> Void = { r in done(r == .OK ? p.url : nil) }
        if let w = host?.webView.window {
            p.beginSheetModal(for: w, completionHandler: finish)
        } else {
            p.begin(completionHandler: finish)
        }
    }

    /// <input type=file> (RigNavigationDelegate's runOpenPanelWith): NSOpenPanel with the page's multiple /
    /// directory flags; nil on cancel or while another panel is open (the input then stays empty, as on cancel).
    func runOpenPanel(_ parameters: WKOpenPanelParameters, completionHandler: @escaping ([URL]?) -> Void) {
        guard !busy else { return completionHandler(nil) }
        busy = true
        let p = NSOpenPanel()
        p.canChooseFiles = true
        p.canChooseDirectories = parameters.allowsDirectories
        p.allowsMultipleSelection = parameters.allowsMultipleSelection
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] r in
            self?.busy = false
            completionHandler(r == .OK ? p.urls : nil)
        }
        if let w = host?.webView.window {
            p.beginSheetModal(for: w, completionHandler: finish)
        } else {
            p.begin(completionHandler: finish)
        }
    }

    private func alert(_ title: String, _ message: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.addButton(withTitle: "OK")
        if let w = host?.webView.window {
            a.beginSheetModal(for: w, completionHandler: nil)
        } else {
            _ = a.runModal()
        }
    }
    #else
    /// The Files export picker for a temp file (a copy: the temp folder is removed once it answers).
    /// `done(url)` with the exported copy, or nil on cancel / no screen to show it on.
    private func export(_ tmp: URL, _ done: @escaping (URL?) -> Void) {
        guard let top = RigLibrary.topViewController() else {
            Self.removeTemp(tmp)
            return done(nil)
        }
        let d = ExportDelegate { [weak self] url in
            self?.exporter = nil
            Self.removeTemp(tmp)
            done(url)
        }
        exporter = d
        let picker = UIDocumentPickerViewController(forExporting: [tmp], asCopy: true)
        picker.delegate = d
        top.present(picker, animated: true)
    }

    private func alert(_ title: String, _ message: String) {
        let a = UIAlertController(title: title, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        RigLibrary.topViewController()?.present(a, animated: true)
    }

    private final class ExportDelegate: NSObject, UIDocumentPickerDelegate {
        private var done: ((URL?) -> Void)?
        init(_ done: @escaping (URL?) -> Void) { self.done = done }
        private func answer(_ url: URL?) {
            let d = done
            done = nil // once: a picker may report both
            d?(url)
        }
        func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { answer(urls.first) }
        func documentPickerWasCancelled(_ c: UIDocumentPickerViewController) { answer(nil) }
    }
    #endif
}
