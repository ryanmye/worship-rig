// Output device lifecycle for the core (rig_host.audio_start / audio_stop). The render callback itself is C
// (Sources/Audio/rig_apple_audio.c). UNBUILT on Linux.
import Foundation
#if os(macOS)
import CoreAudio
#else
import AVFoundation
#endif

final class RigAudio {
    private unowned let host: RigHost
    private var unit: OpaquePointer? // rig_apple_audio*
    private var lastRequest: (deviceId: String?, latency: Double, channels: UInt32)?
    /// True between rig_host.audio_start and rig_host.audio_stop: the core wants sound, so an interruption or a
    /// media-services reset is followed by a reopen. Only touched on `queue`.
    private var wantsRunning = false
    private let queue = DispatchQueue(label: "rig.audio.control")
    #if os(macOS)
    private var listener: AudioObjectPropertyListenerBlock?
    private var followsDefault = true
    #endif

    init(host: RigHost) {
        self.host = host
        #if os(macOS)
        installDeviceListeners()
        #else
        installSessionObservers()
        #endif
    }

    /// rig_host.audio_start: open (or reopen) the device and report with rig_host_audio_started / _state.
    /// `async`: a device switch (AUHAL open, session activation) takes hundreds of ms and must not stall the core's
    /// control thread (SETUP_REVIEW 25); completion is reported by rig_host_audio_started / _state from `queue`.
    func start(deviceId: String?, latency: Double, channels: UInt32) {
        queue.async {
            self.wantsRunning = true
            self.lastRequest = (deviceId, latency, channels)
            _ = self.reopen()
        }
    }

    func stop() {
        queue.sync {
            wantsRunning = false
            if let u = unit {
                rig_apple_audio_close(u)
                unit = nil
            }
        }
        if let e = host.engine { rig_host_audio_state(e, RIG_DEVICE_SUSPENDED, nil) }
    }

    /// Reopens the output with the last request. `quiet`: do not report a failure to the core (a retry follows).
    @discardableResult
    private func reopen(quiet: Bool = false) -> Bool {
        guard let e = host.engine, let req = lastRequest else { return false }
        if let u = unit { rig_apple_audio_close(u); unit = nil }
        var r = rig_apple_audio_request()
        r.latency_sec = req.latency
        r.channels = req.channels
        var status: Int32 = 0
        var info = rig_apple_audio_info()
        #if os(macOS)
        followsDefault = (req.deviceId ?? "").isEmpty
        let opened: OpaquePointer? = withOptionalCString(req.deviceId) { uid in
            r.device_uid = uid // valid for the duration of this call only; the C side copies what it needs
            return rig_apple_audio_open(e, &r, &info, &status)
        }
        #else
        let session = AVAudioSession.sharedInstance()
        do {
            // playback: sound with the silent switch on, continues in the background (UIBackgroundModes audio),
            // not mixable by default so a live rig owns the output; flip RigAudio.mixWithOthers to play over a
            // backing track from another app
            try session.setCategory(.playback, mode: .default,
                                    options: RigAudio.mixWithOthers ? [.mixWithOthers] : [])
            try session.setPreferredIOBufferDuration(128.0 / max(session.sampleRate, 44100))
            try session.setActive(true)
        } catch {
            if !quiet { rig_host_audio_state(e, RIG_DEVICE_CLOSED, "AVAudioSession: \(error.localizedDescription)") }
            return false
        }
        r.session_sample_rate = session.sampleRate
        r.session_latency_sec = session.outputLatency + session.ioBufferDuration
        r.session_buffer_frames = UInt32((session.ioBufferDuration * session.sampleRate).rounded())
        let opened = rig_apple_audio_open(e, &r, &info, &status)
        #endif
        guard let opened else {
            if !quiet {
                rig_host_audio_state(e, RIG_DEVICE_CLOSED, "could not open the output device (OSStatus \(status))")
            }
            return false
        }
        unit = opened
        let uid = withUnsafePointer(to: &info.device_uid) {
            $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) }
        }
        let name = withUnsafePointer(to: &info.device_name) {
            $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) }
        }
        uid.withCString { uidC in
            name.withCString { nameC in
                var di = rig_device_info()
                di.struct_size = UInt32(MemoryLayout<rig_device_info>.size)
                di.device_id = uidC
                di.device_name = nameC
                di.sample_rate = info.sample_rate
                di.channels = info.channels
                di.buffer_frames = info.buffer_frames
                di.output_latency_sec = info.output_latency_sec
                rig_host_audio_started(e, &di)
            }
        }
        return true
    }

    static func listDevices(into buf: UnsafeMutablePointer<CChar>, cap: Int) -> Int {
        rig_apple_audio_list_devices(buf, cap)
    }

    // MARK: device and session changes

    #if os(macOS)
    private func installDeviceListeners() {
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self, let e = self.host.engine else { return }
            rig_host_devices_changed(e)
            self.queue.async {
                // following the system default: move with it
                if self.followsDefault, self.unit != nil { self.reopen() }
            }
        }
        listener = block
        for sel in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultOutputDevice] {
            var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal,
                                                  mElement: kAudioObjectPropertyElementMain)
            let system = AudioObjectID(kAudioObjectSystemObject)
            AudioObjectAddPropertyListenerBlock(system, &addr, DispatchQueue.main, block)
        }
    }
    #else
    /// Set to true to let other apps' audio keep playing next to the rig (AVAudioSessionCategoryOptionMixWithOthers).
    static let mixWithOthers = false

    private func closeUnit() { // on `queue`
        if let u = unit {
            rig_apple_audio_close(u)
            unit = nil
        }
    }

    /// After an interruption, a media-services reset or a return to the foreground: reopen if the core wants sound
    /// and the unit is gone. Retries a few times: activating the session right after an interruption often fails
    /// (AVAudioSessionErrorCodeCannotInterruptOthers / insufficient priority) for a fraction of a second.
    func resumeIfNeeded(attempt: Int = 0) {
        queue.async {
            guard self.wantsRunning, self.unit == nil else { return }
            if self.reopen(quiet: attempt < 3) { return }
            if attempt < 3 {
                self.queue.asyncAfter(deadline: .now() + 0.5) { self.resumeIfNeeded(attempt: attempt + 1) }
            }
        }
    }

    private func installSessionObservers() {
        let nc = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        // phone call, Siri, another app took the session: the OS has stopped our unit already
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: session,
                       queue: .main) { [weak self] n in
            guard let self, let e = self.host.engine,
                  let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began {
                self.queue.async { self.closeUnit() }
                rig_host_audio_state(e, RIG_DEVICE_INTERRUPTED, nil)
            } else {
                // .shouldResume is only a hint; a rig should come back whenever it can, so try regardless
                self.resumeIfNeeded()
            }
        }
        // headphones / USB / Bluetooth / AirPlay changes. categoryChange is excluded: our own setCategory posts it.
        nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: session,
                       queue: .main) { [weak self] n in
            guard let self, let e = self.host.engine else { return }
            rig_host_devices_changed(e)
            let why = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt)
                .flatMap { AVAudioSession.RouteChangeReason(rawValue: $0) }
            switch why {
            case .newDeviceAvailable?, .oldDeviceUnavailable?, .override?:
                // the new route may have another sample rate / latency: reopen so the core re-reads rig_device_info.
                // Unplugging headphones keeps playing on the built-in speaker (open question: pause instead?)
                self.queue.async { if self.wantsRunning, self.unit != nil { self.reopen() } }
            default:
                break
            }
        }
        // mediaserverd restarted: every AVAudioSession object and our audio unit are invalid
        nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session,
                       queue: .main) { [weak self] _ in
            guard let self else { return }
            self.queue.async { self.closeUnit() }
            self.resumeIfNeeded()
        }
    }
    #endif
}

private func withOptionalCString<R>(_ s: String?, _ body: (UnsafePointer<CChar>?) -> R) -> R {
    if let s, !s.isEmpty { return s.withCString { body($0) } }
    return body(nil)
}
