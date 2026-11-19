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
    func start(deviceId: String?, latency: Double, channels: UInt32) {
        queue.sync {
            lastRequest = (deviceId, latency, channels)
            reopen()
        }
    }

    func stop() {
        queue.sync {
            if let u = unit {
                rig_apple_audio_close(u)
                unit = nil
            }
        }
        if let e = host.engine { rig_host_audio_state(e, RIG_DEVICE_SUSPENDED, nil) }
    }

    private func reopen() {
        guard let e = host.engine, let req = lastRequest else { return }
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
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setPreferredIOBufferDuration(128.0 / max(session.sampleRate, 44100))
            try session.setActive(true)
        } catch {
            rig_host_audio_state(e, RIG_DEVICE_CLOSED, "AVAudioSession: \(error.localizedDescription)")
            return
        }
        r.session_sample_rate = session.sampleRate
        r.session_latency_sec = session.outputLatency + session.ioBufferDuration
        r.session_buffer_frames = UInt32((session.ioBufferDuration * session.sampleRate).rounded())
        let opened = rig_apple_audio_open(e, &r, &info, &status)
        #endif
        guard let opened else {
            rig_host_audio_state(e, RIG_DEVICE_CLOSED, "could not open the output device (OSStatus \(status))")
            return
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
    private func installSessionObservers() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            guard let self, let e = self.host.engine,
                  let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began {
                rig_host_audio_state(e, RIG_DEVICE_INTERRUPTED, nil)
            } else {
                self.queue.async { if self.unit != nil || self.lastRequest != nil { self.reopen() } }
            }
        }
        nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] n in
            guard let self, let e = self.host.engine else { return }
            rig_host_devices_changed(e)
            let why = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt)
                .flatMap { AVAudioSession.RouteChangeReason(rawValue: $0) }
            if why == .oldDeviceUnavailable || why == .newDeviceAvailable {
                self.queue.async { if self.unit != nil { self.reopen() } }
            }
        }
    }
    #endif
}

private func withOptionalCString<R>(_ s: String?, _ body: (UnsafePointer<CChar>?) -> R) -> R {
    if let s, !s.isEmpty { return s.withCString { body($0) } }
    return body(nil)
}
