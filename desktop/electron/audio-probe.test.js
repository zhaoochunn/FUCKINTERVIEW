"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PacketReader, PCMVerifier, encodePacket } = require("../scripts/audio-probe-protocol");
const { options } = require("../scripts/audio-probe");

function audio(overrides = {}, value = 0.1) {
  const header = { v: 1, type: "audio", cycle: 1, sequence: 1, format: "f32le",
    sampleRate: 48000, channels: 2, frames: 16, presentationTimeNs: "1000000000", arrivalHostTimeNs: "1000000010", ...overrides };
  const pcm = Buffer.alloc(header.frames * header.channels * 4);
  for (let i = 0; i < pcm.length; i += 4) pcm.writeFloatLE(value, i);
  return { header, pcm };
}
function started() {
  const verifier = new PCMVerifier();
  verifier.consume({ type: "permission", screenRecording: "granted" }, Buffer.alloc(0));
  verifier.consume({ type: "cycle-start", cycle: 1 }, Buffer.alloc(0));
  return verifier;
}
function finish(verifier, overrides = {}) {
  verifier.consume({ type: "cycle-stop", cycle: 1, packets: 1, frames: 16, droppedPackets: 0, invalidAudio: false, ...overrides }, Buffer.alloc(0));
  verifier.consume({ type: "complete", completedCycles: 1, interrupted: false }, Buffer.alloc(0));
}

test("framed PCM parses arbitrary partial/coalesced reads without logging PCM", () => {
  const { header, pcm } = audio();
  const verifier = started(); const reader = new PacketReader((h, p) => verifier.consume(h, p));
  const packet = encodePacket(header, pcm);
  for (let i = 0; i < packet.length; i++) reader.write(packet.subarray(i, i + 1));
  reader.end(); finish(verifier);
  const result = verifier.finish({ cycles: 1, requireSignal: true });
  assert.equal(result.cycles[0].frames, 16);
  assert.ok(Math.abs(result.cycles[0].rms - 0.1) < 1e-6);
  assert.equal(result.cycles[0].nonSilentPackets, 1);
  assert.equal("pcm" in result.cycles[0], false);
});

test("silence, missing data, drops and cancelled cycles cannot pass signal validation", () => {
  const silent = started(); const { header, pcm } = audio({}, 0);
  silent.consume(header, pcm); finish(silent);
  assert.throws(() => silent.finish({ cycles: 1, requireSignal: true }), /non-silent/);
  const dropped = started(); dropped.consume(header, pcm); finish(dropped, { packets: 2, droppedPackets: 1 });
  assert.throws(() => dropped.finish({ cycles: 1 }), /dropped packets/);
  assert.throws(() => started().finish({ cycles: 1 }), /did not complete/);
  const missing = started(); finish(missing, { packets: 0, frames: 0 });
  assert.throws(() => missing.finish({ cycles: 1 }), /No PCM/);
});

test("invalid PCM format, size, non-finite data and timestamp regression are rejected", () => {
  for (const change of [{ format: "s16le" }, { sampleRate: 0 }, { sequence: 0 }, { presentationTimeNs: 1 }]) {
    const verifier = started(); const { header, pcm } = audio(change);
    assert.throws(() => verifier.consume(header, pcm), /Invalid PCM/);
  }
  const bad = audio({}, NaN);
  assert.throws(() => started().consume(bad.header, bad.pcm), /Non-finite/);
  const verifier = started(); const first = audio(); verifier.consume(first.header, first.pcm);
  assert.throws(() => verifier.consume({ ...first.header, sequence: 2 }, first.pcm), /timestamp/);
  assert.throws(() => started().consume(first.header, first.pcm.subarray(4)), /Invalid PCM/);
});

test("oversized, truncated and unsupported protocol messages are rejected", () => {
  const reader = new PacketReader(() => {});
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(20000);
  assert.throws(() => reader.write(oversized), /header length/);
  const short = new PacketReader(() => {}); short.write(Buffer.from([0]));
  assert.throws(() => short.end(), /Truncated/);
  const p = encodePacket({ type: "complete" });
  p.writeUInt32BE(300000, p.readUInt32BE(0) + 4);
  assert.throws(() => new PacketReader(() => {}).write(p), /buffer limit/);
});

test("multiple cycles, permission denial and bounded CLI options have explicit outcomes", () => {
  const verifier = started(); const first = audio(); verifier.consume(first.header, first.pcm);
  verifier.consume({ type: "cycle-stop", cycle: 1, packets: 1, frames: 16, droppedPackets: 0 }, Buffer.alloc(0));
  verifier.consume({ type: "cycle-start", cycle: 2 }, Buffer.alloc(0));
  verifier.consume({ ...first.header, cycle: 2 }, first.pcm);
  verifier.consume({ type: "cycle-stop", cycle: 2, packets: 1, frames: 16, droppedPackets: 0 }, Buffer.alloc(0));
  verifier.consume({ type: "complete", completedCycles: 2, interrupted: false }, Buffer.alloc(0));
  assert.equal(verifier.finish({ cycles: 2, requireSignal: true }).cycles.length, 2);
  const denied = new PCMVerifier(); denied.consume({ type: "permission", screenRecording: "denied-or-not-determined" }, Buffer.alloc(0));
  assert.throws(() => denied.consume({ type: "cycle-start", cycle: 1 }, Buffer.alloc(0)), /cycle start/);
  assert.throws(() => denied.consume({ type: "error", code: "denied", domain: "test", systemCode: 1 }, Buffer.alloc(0)), /denied/);
  assert.throws(() => options(["--duration", "999"]), /duration/);
  assert.throws(() => options(["--cycles", "1.5"]), /duration/);
  assert.throws(() => options(["--upload"]), /Unknown/);
});
