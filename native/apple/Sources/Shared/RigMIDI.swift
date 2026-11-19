// CoreMIDI glue: port enumeration and hot-plug (rig_host_midi_ports), input forwarding (the receive path is C:
// rig_apple_midi_receive), MIDI out (rig_host.midi_send). UNBUILT on Linux.
import CoreAudio
import CoreMIDI
import Foundation

final class RigMIDI {
    private unowned(unsafe) let host: RigHost // the host owns this object; no refcount traffic in the receive block
    private var client = MIDIClientRef()
    private var inPort = MIDIPortRef()
    private var outPort = MIDIPortRef()
    private var connected: [Int32: UnsafeMutablePointer<CChar>] = [:] // source uniqueID -> id string given to the core
    private var wanted = Set<String>()
    private let lock = NSLock()

    init(host: RigHost) {
        self.host = host
        MIDIClientCreateWithBlock("Worship Rig" as CFString, &client) { [weak self] note in
            // setup changed: a device appeared or went away
            if note.pointee.messageID == .msgSetupChanged || note.pointee.messageID == .msgObjectAdded
                || note.pointee.messageID == .msgObjectRemoved {
                DispatchQueue.main.async { self?.publishPorts() }
            }
        }
        // The receive block does nothing but call the C parser (no allocation, no Swift runtime work).
        let receive: MIDIReceiveBlock = { [unowned(unsafe) self] list, srcRef in
            guard let engine = self.host.engine else { return }
            guard let idPtr = srcRef.map({ $0.assumingMemoryBound(to: CChar.self) }) else { return }
            rig_apple_midi_receive(engine, idPtr, list)
        }
        MIDIInputPortCreateWithProtocol(client, "Worship Rig In" as CFString, ._1_0, &inPort, receive)
        MIDIOutputPortCreate(client, "Worship Rig Out" as CFString, &outPort)
        DispatchQueue.main.async { self.publishPorts() }
    }

    // MARK: ports

    private func name(_ obj: MIDIObjectRef, _ prop: CFString) -> String {
        var s: Unmanaged<CFString>?
        MIDIObjectGetStringProperty(obj, prop, &s)
        return (s?.takeRetainedValue() as String?) ?? ""
    }

    private func uid(_ obj: MIDIObjectRef) -> Int32 {
        var v: Int32 = 0
        MIDIObjectGetIntegerProperty(obj, kMIDIPropertyUniqueID, &v)
        return v
    }

    /// Tell the core the current ports (it diffs, releases notes of vanished inputs and emits the `midi` ports event).
    func publishPorts() {
        guard let e = host.engine else { return }
        var ports: [[String: Any]] = []
        for i in 0..<MIDIGetNumberOfSources() {
            let s = MIDIGetSource(i)
            ports.append(["id": String(uid(s)), "name": name(s, kMIDIPropertyDisplayName),
                          "manufacturer": name(s, kMIDIPropertyManufacturer), "state": "connected", "kind": "input"])
        }
        for i in 0..<MIDIGetNumberOfDestinations() {
            let d = MIDIGetDestination(i)
            ports.append(["id": String(uid(d)), "name": name(d, kMIDIPropertyDisplayName),
                          "manufacturer": name(d, kMIDIPropertyManufacturer), "state": "connected", "kind": "output"])
        }
        guard let data = try? JSONSerialization.data(withJSONObject: ports) else { return }
        data.withUnsafeBytes { raw in
            _ = rig_host_midi_ports(e, raw.baseAddress!.assumingMemoryBound(to: CChar.self), data.count)
        }
        lock.lock(); let ids = wanted; lock.unlock()
        apply(ids)
    }

    /// rig_host.midi_listen: connect exactly these source ids.
    func listen(idsJSON: String) {
        guard let d = idsJSON.data(using: .utf8), let ids = (try? JSONSerialization.jsonObject(with: d)) as? [String]
        else { return }
        lock.lock(); wanted = Set(ids); lock.unlock()
        apply(Set(ids))
    }

    private func apply(_ ids: Set<String>) {
        lock.lock(); defer { lock.unlock() }
        for i in 0..<MIDIGetNumberOfSources() {
            let src = MIDIGetSource(i)
            let u = uid(src)
            let id = String(u)
            if ids.contains(id), connected[u] == nil {
                let p = strdup(id)! // lives as long as the connection: the receive block gets it as its refCon
                connected[u] = p
                MIDIPortConnectSource(inPort, src, UnsafeMutableRawPointer(p))
            } else if !ids.contains(id), let p = connected[u] {
                MIDIPortDisconnectSource(inPort, src)
                connected[u] = nil
                free(p)
            }
        }
    }

    // MARK: output

    /// rig_host.midi_send: bytes to a destination, at a host time (0 = now).
    func send(port: String, bytes: UnsafePointer<UInt8>, count: Int, hostTimeNs: UInt64) {
        guard let want = Int32(port) else { return }
        for i in 0..<MIDIGetNumberOfDestinations() {
            let d = MIDIGetDestination(i)
            guard uid(d) == want else { continue }
            let ts: MIDITimeStamp = hostTimeNs == 0 ? 0 : AudioConvertNanosToHostTime(hostTimeNs)
            var buf = [UInt8](repeating: 0, count: 1024)
            buf.withUnsafeMutableBytes { raw in
                let list = raw.baseAddress!.assumingMemoryBound(to: MIDIPacketList.self)
                let pkt = MIDIPacketListInit(list)
                _ = MIDIPacketListAdd(list, raw.count, pkt, ts, count, bytes)
                MIDISend(outPort, d, list)
            }
            return
        }
    }
}
