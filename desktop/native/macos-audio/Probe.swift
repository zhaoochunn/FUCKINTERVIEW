import Foundation
import CoreGraphics
import CoreMedia
import AudioToolbox
import ScreenCaptureKit
import Darwin

enum ProbeError: Error { case invalidArguments, permissionRequired, noDisplay, invalidAudio, outputBlocked }

struct Options {
    var seconds = 10.0
    var cycles = 2
    var request = false
    var permissionOnly = false
    var binary = false
    init(_ args: [String]) throws {
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--request-permission": request = true
            case "--permissions": permissionOnly = true
            case "--pcm": binary = true
            case "--duration", "--cycles":
                let key = args[i]; i += 1
                guard i < args.count, let number = Double(args[i]), number.isFinite else { throw ProbeError.invalidArguments }
                if key == "--duration" { seconds = number }
                else {
                    guard number.rounded() == number, number >= 1, number <= 20 else { throw ProbeError.invalidArguments }
                    cycles = Int(number)
                }
            default: throw ProbeError.invalidArguments
            }
            i += 1
        }
        guard seconds >= 1, seconds <= 60, !binary || isatty(STDOUT_FILENO) == 0 else { throw ProbeError.invalidArguments }
    }
}

// Only the writer queue touches stdout. At most 16 encoded packets are retained.
// Slow consumers cause counted audio drops, never an unbounded audio queue.
final class PacketWriter {
    private let binary: Bool
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "audio-probe.output")
    private var pending = 0
    private var failed = false
    init(binary: Bool) { self.binary = binary }
    var isFailed: Bool { lock.lock(); defer { lock.unlock() }; return failed }
    @discardableResult func send(_ values: [String: Any], pcm: Data = Data()) -> Bool {
        if !binary && values["type"] as? String == "audio" { return true }
        var header = values; header["v"] = 1
        guard let json = try? JSONSerialization.data(withJSONObject: header) else { return false }
        var packet = Data()
        if binary {
            var length = UInt32(json.count).bigEndian
            withUnsafeBytes(of: &length) { packet.append(contentsOf: $0) }
            packet.append(json)
            length = UInt32(pcm.count).bigEndian
            withUnsafeBytes(of: &length) { packet.append(contentsOf: $0) }
            packet.append(pcm)
        } else { packet.append(json); packet.append(10) }
        lock.lock()
        guard !failed && pending < 16 else { lock.unlock(); return false }
        pending += 1; lock.unlock()
        queue.async {
            do { try FileHandle.standardOutput.write(contentsOf: packet) }
            catch { self.lock.lock(); self.failed = true; self.lock.unlock() }
            self.lock.lock(); self.pending -= 1; self.lock.unlock()
        }
        return true
    }
    func control(_ values: [String: Any]) throws {
        guard send(values) else { throw ProbeError.outputBlocked }
    }
    func flush() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async { continuation.resume() }
        }
    }
}

final class AudioOutput: NSObject, SCStreamOutput {
    let queue = DispatchQueue(label: "audio-probe.samples")
    let writer: PacketWriter
    let cycle: Int
    private var active = true
    private var packets = 0
    private var frames = 0
    private var drops = 0
    private var invalid = false
    init(writer: PacketWriter, cycle: Int) { self.writer = writer; self.cycle = cycle }
    var hasError: Bool { queue.sync { invalid } }
    func finish() -> [String: Any] {
        queue.sync {
            active = false
            return ["type": "cycle-stop", "cycle": cycle, "packets": packets, "frames": frames,
                    "droppedPackets": drops, "invalidAudio": invalid]
        }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard active, type == .audio, CMSampleBufferDataIsReady(sampleBuffer), CMSampleBufferGetNumSamples(sampleBuffer) > 0 else { return }
        do { try audio(sampleBuffer) } catch { invalid = true }
    }
    private func audio(_ sample: CMSampleBuffer) throws {
        guard let description = CMSampleBufferGetFormatDescription(sample),
              let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description) else { throw ProbeError.invalidAudio }
        let format = basic.pointee
        let count = CMSampleBufferGetNumSamples(sample)
        let channels = Int(format.mChannelsPerFrame)
        guard format.mFormatID == kAudioFormatLinearPCM, format.mBitsPerChannel == 32,
              format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
              channels >= 1, channels <= 2, format.mSampleRate.isFinite,
              format.mSampleRate >= 8000, format.mSampleRate <= 96000,
              count <= 32768, count * channels * 4 <= 262144 else { throw ProbeError.invalidAudio }
        var needed = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &needed,
            bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard needed >= MemoryLayout<AudioBufferList>.size, needed <= 4096 else { throw ProbeError.invalidAudio }
        let allocation = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { allocation.deallocate() }
        let list = allocation.assumingMemoryBound(to: AudioBufferList.self)
        var retained: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: nil,
            bufferListOut: list, bufferListSize: needed, blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil, flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &retained)
        guard status == noErr else { throw ProbeError.invalidAudio }
        var pcm = Data(count: count * channels * 4)
        try pcm.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
            let output = bytes.bindMemory(to: Float.self)
            var channelOffset = 0
            for buffer in UnsafeMutableAudioBufferListPointer(list) {
                let n = Int(buffer.mNumberChannels)
                guard n > 0, channelOffset + n <= channels,
                      Int(buffer.mDataByteSize) >= count * n * 4, let data = buffer.mData else { throw ProbeError.invalidAudio }
                let input = data.assumingMemoryBound(to: Float.self)
                for frame in 0..<count {
                    for channel in 0..<n {
                        let value = input[frame * n + channel]
                        guard value.isFinite else { throw ProbeError.invalidAudio }
                        output[frame * channels + channelOffset + channel] = value
                    }
                }
                channelOffset += n
            }
            guard channelOffset == channels else { throw ProbeError.invalidAudio }
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        guard pts.isValid, !pts.isIndefinite else { throw ProbeError.invalidAudio }
        let ns = CMTimeConvertScale(pts, timescale: 1_000_000_000, method: .roundTowardZero).value
        guard ns >= 0 else { throw ProbeError.invalidAudio }
        packets += 1; frames += count
        if !writer.send(["type": "audio", "cycle": cycle, "sequence": packets, "format": "f32le",
                         "sampleRate": format.mSampleRate, "channels": channels, "frames": count,
                         "presentationTimeNs": String(ns), "arrivalHostTimeNs": String(DispatchTime.now().uptimeNanoseconds)], pcm: pcm) { drops += 1 }
    }
}

@MainActor final class Capture: NSObject, SCStreamDelegate {
    var stopped = false
    var streamError: NSError?
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in self.streamError = error as NSError; self.stopped = true }
    }
    func run(_ options: Options, writer: PacketWriter) async throws {
        var allowed = CGPreflightScreenCaptureAccess()
        if !allowed && options.request { allowed = CGRequestScreenCaptureAccess() }
        try writer.control(["type": "permission", "screenRecording": allowed ? "granted" : "denied-or-not-determined",
                            "requestAttempted": options.request])
        if options.permissionOnly { return }
        guard allowed else { throw ProbeError.permissionRequired }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw ProbeError.noDisplay }
        var sources: [DispatchSourceSignal] = []
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in Task { @MainActor in self?.stopped = true } }
            source.resume(); sources.append(source)
        }
        defer { sources.forEach { $0.cancel() } }
        var completed = 0
        for cycle in 1...options.cycles {
            if stopped { break }
            let config = SCStreamConfiguration()
            config.capturesAudio = true; config.sampleRate = 48000; config.channelCount = 2
            config.excludesCurrentProcessAudio = true
            config.width = 2; config.height = 2; config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.queueDepth = 3
            let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            let output = AudioOutput(writer: writer, cycle: cycle)
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
            defer { try? stream.removeStreamOutput(output, type: .audio) }
            try writer.control(["type": "cycle-start", "cycle": cycle, "requestedSampleRate": 48000, "requestedChannels": 2])
            do {
                try await stream.startCapture()
                let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(options.seconds * 1_000_000_000)
                var permissionCheck = DispatchTime.now().uptimeNanoseconds
                while !stopped && DispatchTime.now().uptimeNanoseconds < deadline {
                    if DispatchTime.now().uptimeNanoseconds >= permissionCheck {
                        guard CGPreflightScreenCaptureAccess() else {
                            try writer.control(["type": "permission", "screenRecording": "revoked", "requestAttempted": false])
                            throw ProbeError.permissionRequired
                        }
                        permissionCheck = DispatchTime.now().uptimeNanoseconds + 1_000_000_000
                    }
                    if writer.isFailed { throw ProbeError.outputBlocked }
                    if output.hasError { throw ProbeError.invalidAudio }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                try await stream.stopCapture()
            } catch {
                try? await stream.stopCapture()
                _ = output.finish()
                throw error
            }
            try writer.control(output.finish())
            if let error = streamError { throw error }
            completed += 1
        }
        try writer.control(["type": "complete", "completedCycles": completed, "interrupted": stopped])
    }
}

@main struct Main {
    @MainActor static func main() async {
        signal(SIGPIPE, SIG_IGN)
        var writer: PacketWriter?
        do {
            let options = try Options(Array(CommandLine.arguments.dropFirst()))
            let output = PacketWriter(binary: options.binary); writer = output
            try await Capture().run(options, writer: output)
            await output.flush()
            exit(0)
        } catch {
            let error = error as NSError
            if let output = writer {
                _ = output.send(["type": "error", "code": "capture-or-permission-failed",
                                 "domain": error.domain, "systemCode": error.code])
                await output.flush()
            } else {
                FileHandle.standardError.write(Data("Usage: SystemAudioProbe [--permissions] [--request-permission] [--pcm] [--duration 1..60] [--cycles 1..20]\n".utf8))
            }
            exit(1)
        }
    }
}
