"use strict";
const { spawn } = require("node:child_process");
const { PacketReader, PCMVerifier } = require("./native-pcm-protocol");
const { trustedSender } = require("./desktop-services");

// One owner, one child, bounded unacknowledged IPC. No audio is logged or persisted.
class NativeAudio {
  constructor({ executable, spawnChild = spawn, platform = process.platform, arch = process.arch }) {
    Object.assign(this, { executable, spawnChild, platform, arch });
    this.current = null;
  }
  start(owner, token, send) {
    if (this.platform !== "darwin" || this.arch !== "arm64") throw new Error("Native audio requires ARM64 macOS");
    if (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token)) throw new Error("Invalid audio session");
    if (this.current) throw new Error("System audio is already active or stopping");
    const child = this.spawnChild(this.executable, ["--pcm", "--continuous", "--request-permission"],
      { stdio: ["ignore", "pipe", "pipe"] });
    const s = { owner, token, child, pending: new Map(), frames: 0, stopping: false, last: null };
    this.current = s;
    s.closed = new Promise((resolve) => { s.resolve = resolve; });
    const report = (packet) => { try { send(packet); } catch { /* owner may have closed during teardown */ } };
    const verifier = new PCMVerifier();
    const fail = (message) => {
      if (s.stopping) return;
      report({ token, type: "error", message });
      void this.stop().catch(() => {}); // close/quit retries retain this session until actual close
    };
    const reader = new PacketReader((header, pcm) => {
      if (s.stopping) return;
      verifier.consume(header, pcm);
      if (header.type === "audio") {
        if (header.sampleRate !== 48000 || header.channels !== 2) throw new Error("Expected 48 kHz stereo PCM");
        if (header.sequence !== (s.lastSequence || 0) + 1) throw new Error("Native PCM packet loss");
        s.lastSequence = header.sequence;
        const pts = BigInt(header.presentationTimeNs);
        if (s.last) {
          const delta = Number(pts - s.last.pts) / 1e9 - s.last.frames / 48000;
          if (Math.abs(delta) > 0.002) throw new Error("PCM timestamp discontinuity");
        }
        s.last = { pts, frames: header.frames };
        if (s.pending.size >= 8 || s.frames + header.frames > 24000) throw new Error("PCM IPC backpressure limit exceeded");
        s.pending.set(header.sequence, header.frames); s.frames += header.frames;
        // Copy only this PCM packet, never expose pooled Buffer backing memory.
        send({ token, type: "audio", header, pcm: Uint8Array.from(pcm) });
      } else if (header.type === "permission") {
        send({ token, type: "permission", permission: header.screenRecording });
      }
    });
    s.watchdog = setInterval(() => {
      if (Date.now() - s.activity > (s.last ? 15000 : 30000)) fail("Native audio stalled or consumer stopped acknowledging");
    }, 1000);
    s.activity = Date.now();
    child.stdout.on("data", (chunk) => {
      try { reader.write(chunk); } catch (error) { fail(error.message); }
    });
    child.stdout.on("error", () => fail("Native PCM pipe failed"));
    child.stderr.on("error", () => fail("Native helper diagnostic pipe failed"));
    child.stderr.on("data", () => {}); // drain framework diagnostics; never forward raw stderr/PCM
    child.once("error", () => fail("Native helper failed to start; build the helper first"));
    child.once("close", () => {
      clearInterval(s.watchdog); clearTimeout(s.killTimer);
      if (!s.stopping) {
        try { reader.end(); } catch { /* emit a single controlled failure below */ }
        report({ token, type: "error", message: "Native audio helper exited" });
      }
      if (this.current === s) this.current = null;
      s.resolve();
    });
    return token;
  }
  ack(owner, token, sequence) {
    const s = this.current;
    if (!s || s.owner !== owner || s.token !== token || !s.pending.has(sequence)) return;
    s.frames -= s.pending.get(sequence); s.pending.delete(sequence); s.activity = Date.now();
  }
  async stop(owner, token) {
    const s = this.current;
    if (!s || (owner && (s.owner !== owner || s.token !== token))) return;
    if (!s.stopping) {
      s.stopping = true; clearInterval(s.watchdog);
      s.child.kill("SIGTERM");
      s.killTimer = setTimeout(() => s.child.kill("SIGKILL"), 4000);
    }
    let timeout;
    try {
      await Promise.race([s.closed, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Native helper has not exited")), 6500);
      })]);
    } finally { clearTimeout(timeout); }
  }
}

function installNativeAudio({ ipcMain, getWindow, isAppOrigin, capture, enabled = true }) {
  const check = (event) => {
    if (!enabled || !trustedSender(event, getWindow(), isAppOrigin)) throw new Error("Untrusted or unavailable audio request");
    return event.sender;
  };
  ipcMain.handle("native-audio:start", (event, token) => {
    const owner = check(event);
    return capture.start(owner, token, (packet) => {
      if (!owner.isDestroyed()) owner.send("native-audio:packet", packet);
    });
  });
  ipcMain.handle("native-audio:stop", (event, token) => capture.stop(check(event), token));
  ipcMain.on("native-audio:ack", (event, token, sequence) => {
    if (enabled && trustedSender(event, getWindow(), isAppOrigin)) capture.ack(event.sender, token, sequence);
  });
}
module.exports = { NativeAudio, installNativeAudio };
