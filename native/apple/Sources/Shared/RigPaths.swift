// Where things live in the bundle and on disk. UNBUILT on Linux.
//
//   macOS  recordings  ~/Music/Worship Rig/                         (same folder the Electron app used)
//          backups     ~/Library/Application Support/Worship Rig Native/backups/
//   iPad   recordings  <container>/Documents/Recordings/            (Files > On My iPad > Worship Rig > Recordings)
//          backups     <container>/Documents/Backups/               (visible in Files so they can be AirDropped out)
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

    private static var documents: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    /// Where the core's `rec` writer puts WAV files (rig_config.recordings_dir). The shell never writes these files.
    static var recordingsDir: URL {
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
        #if os(macOS)
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(supportDirName, isDirectory: true)
            .appendingPathComponent("backups", isDirectory: true)
        #else
        return documents.appendingPathComponent("Backups", isDirectory: true)
        #endif
    }

    static func ensureDirectories() {
        for dir in [recordingsDir, backupsDir] {
            do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) } catch {
                NSLog("rig: cannot create %@: %@", dir.path, error.localizedDescription)
            }
        }
    }

    static var userSamplesManifest: URL? { nil } // later task: merged My Samples manifest (importer)
}
