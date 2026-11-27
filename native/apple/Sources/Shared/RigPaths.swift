// Where things live in the bundle and on disk. UNBUILT on Linux.
//
//   macOS  recordings  ~/Music/Worship Rig/                         (same folder the Electron app used)
//          backups     ~/Library/Application Support/Worship Rig Native/backups/
//          My Samples  ~/Music/Worship Rig/Samples/                 (the Electron app's folder; patch packs, lane N1)
//   iPad   recordings  <container>/Documents/Recordings/            (Files > On My iPad > Worship Rig > Recordings)
//          backups     <container>/Documents/Backups/               (visible in Files so they can be AirDropped out)
//          My Samples  <container>/Documents/Samples/               (Files > On My iPad > Worship Rig > Samples)
//
// The iPad folders are visible in Files only because project.yml sets UIFileSharingEnabled and
// LSSupportsOpeningDocumentsInPlace (see SHELL.md "Recording ownership").
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

    /// Folder name under Application Support. Deliberately not "Worship Rig": the Electron app's userData is
    /// ~/Library/Application Support/Worship Rig (or worship-rig) and the migration scan must not read our own files.
    static let supportDirName = "Worship Rig Native"

    /// Self-test (E4): the folders the shell writes (recordings, backups) go under this temporary root instead, so a
    /// run on Ryan's Mac leaves his real folders alone. nil in the normal app.
    static var overrideRoot: URL?

    private static var documents: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    /// Where the core's `rec` writer puts WAV files (rig_config.recordings_dir). The shell never writes these files.
    static var recordingsDir: URL {
        if let r = overrideRoot { return r.appendingPathComponent("Recordings", isDirectory: true) }
        #if os(macOS)
        let music = FileManager.default.urls(for: .musicDirectory, in: .userDomainMask).first
            ?? documents
        return music.appendingPathComponent("Worship Rig", isDirectory: true)
        #else
        return documents.appendingPathComponent("Recordings", isDirectory: true)
        #endif
    }

    /// The rotation of library backups written for window.rig.backupNow.
    static var backupsDir: URL {
        if let r = overrideRoot { return r.appendingPathComponent("Backups", isDirectory: true) }
        #if os(macOS)
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(supportDirName, isDirectory: true)
            .appendingPathComponent("backups", isDirectory: true)
        #else
        return documents.appendingPathComponent("Backups", isDirectory: true)
        #endif
    }

    /// The My Samples roots, in priority order (server.js defaultUserSampleRoots; an earlier root wins a pack name).
    /// The self-test's temporary root first (hermetic: it writes its own packs there), then RIG_USER_SAMPLES
    /// (':'-separated, replaces the default, as in 1.x), then the platform folder. Only patch packs are read from
    /// them so far (/api/user-patches, lane N1); My Samples sound is lane N2. The Mac app is not sandboxed
    /// (project.yml), so plain paths work, spaces and non-ASCII included.
    static var userSampleRoots: [URL] {
        if let r = overrideRoot { return [r.appendingPathComponent("Samples", isDirectory: true)] }
        let env = ProcessInfo.processInfo.environment["RIG_USER_SAMPLES"] ?? ""
        let over = env.split(separator: ":").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if !over.isEmpty { return over.map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL } }
        #if os(macOS)
        let music = FileManager.default.urls(for: .musicDirectory, in: .userDomainMask).first ?? documents
        return [music.appendingPathComponent("Worship Rig", isDirectory: true)
            .appendingPathComponent("Samples", isDirectory: true)]
        #else
        return [documents.appendingPathComponent("Samples", isDirectory: true)]
        #endif
    }

    /// `userSampleRoots` as the JSON array of paths rig_hostkit takes.
    static var userSampleRootsJSON: String {
        let paths = userSampleRoots.map { $0.path }
        guard let d = try? JSONSerialization.data(withJSONObject: paths), let s = String(data: d, encoding: .utf8)
        else { return "[]" }
        return s
    }

    static func ensureDirectories() {
        var dirs = [recordingsDir, backupsDir]
        #if os(iOS)
        dirs.append(contentsOf: userSampleRoots) // so Files shows On My iPad > Worship Rig > Samples to copy packs into
        #endif
        for dir in dirs {
            do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) } catch {
                NSLog("rig: cannot create %@: %@", dir.path, error.localizedDescription)
            }
        }
    }

    static var userSamplesManifest: URL? { nil } // later task: merged My Samples manifest (importer)
}
