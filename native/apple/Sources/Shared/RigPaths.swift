// Where things live in the bundle and on disk. UNBUILT on Linux.
import Foundation

enum RigPaths {
    /// The app/ folder copied into the bundle as a folder reference (project.yml `resources`).
    static var appDir: URL {
        Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
    }

    /// docs/ (only /docs/<name>.md is served; settings.js links docs/garageband-import.md).
    static var docsDir: URL {
        Bundle.main.resourceURL!.appendingPathComponent("docs", isDirectory: true)
    }

    static var recordingsDir: URL {
        let base = FileManager.default.urls(for: .musicDirectory, in: .userDomainMask).first
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Worship Rig/Recordings", isDirectory: true)
    }

    static var userSamplesManifest: URL? { nil } // later task: merged My Samples manifest (importer)
}
