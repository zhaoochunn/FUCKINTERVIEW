"use strict";

const MAX_HEADER = 16384;
const MAX_PCM = 262144;

function encodePacket(header, pcm = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify({ ...header, v: 1 }));
  const packet = Buffer.alloc(8 + json.length + pcm.length);
  packet.writeUInt32BE(json.length, 0); json.copy(packet, 4);
  packet.writeUInt32BE(pcm.length, 4 + json.length); pcm.copy(packet, 8 + json.length);
  return packet;
}

class PacketReader {
  constructor(consume) { this.consume = consume; this.buffer = Buffer.alloc(0); }
  write(chunk) {
    // Feed bounded slices even when a caller supplies a very large chunk.
    for (let offset = 0; offset < chunk.length; offset += 65536) {
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + 65536)]);
      this.parse();
    }
  }
  parse() {
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      if (size < 2 || size > MAX_HEADER) throw new Error("Invalid audio protocol header length");
      if (this.buffer.length < size + 8) return;
      const length = this.buffer.readUInt32BE(size + 4);
      if (length > MAX_PCM) throw new Error("PCM packet exceeds buffer limit");
      if (this.buffer.length < size + length + 8) return;
      const header = JSON.parse(this.buffer.subarray(4, size + 4).toString("utf8"));
      if (!header || Array.isArray(header) || header.v !== 1 || typeof header.type !== "string") {
        throw new Error("Unsupported audio protocol version or message");
      }
      this.consume(header, this.buffer.subarray(size + 8, size + length + 8));
      this.buffer = this.buffer.subarray(size + length + 8);
    }
  }
  end() { if (this.buffer.length) throw new Error("Truncated audio protocol packet"); }
}

class PCMVerifier {
  constructor({ minRms = 0.001 } = {}) {
    if (!Number.isFinite(minRms) || minRms <= 0 || minRms > 1) throw new Error("Invalid RMS threshold");
    this.minRms = minRms; this.cycles = []; this.active = null;
    this.permission = null; this.complete = false; this.interrupted = false;
  }
  consume(header, pcm) {
    if (this.complete) throw new Error("Packet after completion");
    if (header.type !== "audio" && pcm.length) throw new Error("Unexpected PCM in control message");
    switch (header.type) {
      case "permission": this.permission = header.screenRecording; break;
      case "cycle-start":
        if (this.permission !== "granted" || this.active || header.cycle !== this.cycles.length + 1) throw new Error("Invalid cycle start");
        this.active = { cycle: header.cycle, packets: 0, frames: 0, samples: 0, sumSquares: 0,
          peak: 0, nonSilentPackets: 0, missingPackets: 0, sequence: 0, lastTime: null };
        break;
      case "audio": this.audio(header, pcm); break;
      case "cycle-stop": {
        const c = this.active;
        if (!c || header.cycle !== c.cycle || header.invalidAudio ||
            !Number.isSafeInteger(header.droppedPackets) || header.droppedPackets < 0 ||
            header.packets !== c.packets + header.droppedPackets || !Number.isSafeInteger(header.frames) ||
            header.frames < c.frames || (!header.droppedPackets && header.frames !== c.frames)) throw new Error("Invalid cycle completion");
        c.droppedPackets = header.droppedPackets;
        c.rms = Math.sqrt(c.sumSquares / Math.max(c.samples, 1));
        c.audioSeconds = c.frames / (c.sampleRate || 1);
        delete c.sumSquares; delete c.lastTime; delete c.sequence;
        this.cycles.push(c); this.active = null;
        break;
      }
      case "complete":
        if (this.active || header.completedCycles !== this.cycles.length || typeof header.interrupted !== "boolean") throw new Error("Incomplete capture cycles");
        this.complete = true; this.interrupted = header.interrupted; break;
      case "error": throw new Error(`Native probe failed: ${header.code} (${header.domain}/${header.systemCode})`);
      default: throw new Error("Unknown audio protocol message");
    }
  }
  audio(h, pcm) {
    const c = this.active;
    if (!c || h.cycle !== c.cycle || h.format !== "f32le" ||
        !Number.isFinite(h.sampleRate) || h.sampleRate < 8000 || h.sampleRate > 96000 ||
        !Number.isInteger(h.channels) || h.channels < 1 || h.channels > 2 ||
        !Number.isSafeInteger(h.frames) || h.frames < 1 ||
        h.frames * h.channels * 4 !== pcm.length || pcm.length > MAX_PCM ||
        !Number.isSafeInteger(h.sequence) || h.sequence <= c.sequence ||
        typeof h.presentationTimeNs !== "string" || typeof h.arrivalHostTimeNs !== "string" ||
        !/^\d{1,20}$/.test(h.presentationTimeNs) || !/^\d{1,20}$/.test(h.arrivalHostTimeNs)) throw new Error("Invalid PCM format, size or sequence");
    const time = BigInt(h.presentationTimeNs);
    if (c.lastTime !== null && time <= c.lastTime) throw new Error("PCM presentation timestamp did not advance");
    if (c.sampleRate && (c.sampleRate !== h.sampleRate || c.channels !== h.channels)) throw new Error("Audio format changed within a cycle");
    c.sampleRate = h.sampleRate; c.channels = h.channels;
    let sum = 0, peak = 0;
    for (let i = 0; i < pcm.length; i += 4) {
      const value = pcm.readFloatLE(i);
      if (!Number.isFinite(value)) throw new Error("Non-finite PCM sample");
      sum += value * value; peak = Math.max(peak, Math.abs(value));
    }
    c.missingPackets += h.sequence - c.sequence - 1;
    c.sequence = h.sequence; c.lastTime = time;
    c.packets++; c.frames += h.frames; c.samples += pcm.length / 4;
    c.sumSquares += sum; c.peak = Math.max(c.peak, peak);
    if (Math.sqrt(sum / (pcm.length / 4)) >= this.minRms) c.nonSilentPackets++;
  }
  finish({ cycles, requireSignal = false, permissionsOnly = false, minAudioSeconds = 0 } = {}) {
    if (permissionsOnly) {
      if (!this.permission) throw new Error("No permission status received");
      return { permission: this.permission };
    }
    if (this.permission !== "granted" || !this.complete || this.interrupted || this.cycles.length !== cycles) throw new Error("Capture did not complete requested cycles with permission");
    if (this.cycles.some((c) => !c.frames || c.droppedPackets || c.missingPackets)) throw new Error("No PCM received or capture dropped packets");
    if (this.cycles.some((c) => c.audioSeconds < minAudioSeconds)) throw new Error("Insufficient PCM duration for validation");
    if (requireSignal && this.cycles.some((c) => !c.nonSilentPackets)) throw new Error("No non-silent PCM detected in one or more cycles");
    return { permission: this.permission, complete: true, cycles: this.cycles };
  }
}

module.exports = { PacketReader, PCMVerifier, encodePacket };
