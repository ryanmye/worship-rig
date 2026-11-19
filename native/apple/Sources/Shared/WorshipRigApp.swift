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
        }
        #if os(macOS)
        .windowResizability(.contentMinSize)
        .commands {
            // Later task: the real menu bar (WEBKIT_AUDIT section 5, `onMenu` ids). Only SwiftUI's free items now.
            CommandGroup(replacing: .newItem) {}
        }
        #endif
    }
}
