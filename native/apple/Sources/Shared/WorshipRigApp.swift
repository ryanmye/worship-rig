// App entry, shared by the macOS and iPadOS targets. UNBUILT on Linux (no Swift toolchain here).
import SwiftUI

@main
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
