// App entry, shared by the macOS and iPadOS targets. UNBUILT on Linux (no Swift toolchain here).
import SwiftUI

/// Entry point: `--self-test` / RIG_SELFTEST=1 runs the UI-less check of RigSelfTest.swift (macOS only, E4) instead
/// of the SwiftUI app; everything else starts the app as before.
@main
@MainActor // App.main() is main-actor isolated in current SDKs; the entry point runs on the main thread anyway
enum RigEntry {
    static func main() {
        #if os(macOS)
        if RigSelfTest.requested { RigSelfTest.run() }
        #endif
        WorshipRigApp.main()
    }
}

struct WorshipRigApp: App {
    @StateObject private var host = RigHost()

    var body: some Scene {
        WindowGroup {
            RigWebView(host: host)
                #if os(macOS)
                .frame(minWidth: 1024, minHeight: 700)
                #endif
                // a library .json from AirDrop / Files / Finder (CFBundleDocumentTypes in project.yml)
                .onOpenURL { host.library.handleOpen($0) }
        }
        #if os(macOS)
        .windowResizability(.contentMinSize)
        #endif
        .commands {
            // Later task: the real menu bar (WEBKIT_AUDIT section 5, `onMenu` ids). Only these items for now.
            #if os(macOS)
            CommandGroup(replacing: .newItem) {}
            #endif
            CommandGroup(after: .importExport) {
                Button("Import Library Backup\u{2026}") { host.library.pickBackup() }
                    .keyboardShortcut("i", modifiers: [.command, .shift])
            }
        }
    }
}
