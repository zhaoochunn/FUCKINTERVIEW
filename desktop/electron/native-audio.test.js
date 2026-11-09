"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NativeAudio, installNativeAudio } = require('./native-audio');
const { encodePacket } = require('./native-pcm-protocol');
const token = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const packets = [], children = [];
  const capture = new NativeAudio({ executable: '/fixed/helper', platform: 'darwin', arch: 'arm64',
    spawnChild(executable, args, options) {
      assert.equal(executable, '/fixed/helper'); assert.ok(args.includes('--continuous'));
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), signals: [],
        kill(signal) { this.signals.push(signal); queueMicrotask(() => this.emit('close', 0)); } });
      children.push(child); return child;
    } });
  const owner = {};
  const start = () => capture.start(owner, token, (packet) => packets.push(packet));
  const control = (h) => children.at(-1).stdout.emit('data', encodePacket(h));
  const audio = (sequence, overrides = {}, value = 1.1) => {
    const frames = 1024, pcm = Buffer.alloc(frames * 8);
    for (let i = 0; i < pcm.length; i += 4) pcm.writeFloatLE(value, i);
    controlPacket({ type: 'audio', cycle: 1, sequence, format: 'f32le', sampleRate: 48000, channels: 2, frames,
      presentationTimeNs: String(1000000000n + BigInt(Math.round((sequence - 1) * frames * 1e9 / 48000))),
      arrivalHostTimeNs: '1000000000', ...overrides }, pcm);
  };
  function controlPacket(header, pcm) { children.at(-1).stdout.emit('data', encodePacket(header, pcm)); }
  const ready = () => { control({ type: 'permission', screenRecording: 'granted' }); control({ type: 'cycle-start', cycle: 1 }); };
  return { capture, packets, children, owner, start, ready, control, audio };
}
test('native audio preserves stereo >1 samples, validates timestamps and isolates ACK/session ownership', async () => {
  const f = fixture(); f.start(); f.ready(); f.audio(1);
  const packet = f.packets.find((p) => p.type === 'audio');
  assert.ok(Math.abs(new DataView(packet.pcm.buffer).getFloat32(0, true) - 1.1) < 1e-6);
  assert.equal(f.capture.current.frames, 1024);
  f.capture.ack({}, token, 1); assert.equal(f.capture.current.frames, 1024);
  f.capture.ack(f.owner, token, 1); assert.equal(f.capture.current.frames, 0);
  await f.capture.stop({}, token); assert.ok(f.capture.current);
  assert.throws(f.start, /already active/);
  f.audio(2, { presentationTimeNs: '2000000000' });
  assert.match(f.packets.at(-1).message, /discontinuity/);
  await f.capture.stop(); assert.equal(f.capture.current, null);
});
test('unacknowledged PCM and packet loss fail closed rather than growing memory or hiding loss', async () => {
  for (const mode of ['backpressure', 'loss', 'format', 'denied', 'spawn']) {
    const f = fixture(); f.start();
    if (mode === 'denied') f.control({ type: 'error', code: 'permissionRequired', domain: 'Probe', systemCode: 1 });
    else if (mode === 'spawn') f.children[0].emit('error', new Error('ENOENT'));
    else {
      f.ready();
      if (mode === 'backpressure') for (let i = 1; i <= 9; i++) f.audio(i);
      if (mode === 'loss') f.audio(2);
      if (mode === 'format') f.audio(1, { sampleRate: 44100 });
    }
    assert.equal(f.packets.at(-1).type, 'error', mode);
    assert.deepEqual(f.children[0].signals, ['SIGTERM']);
    await f.capture.stop(); assert.equal(f.capture.current, null);
  }
});
test('stop waits for child close, is idempotent, and permits a fresh capture only after cleanup', async () => {
  const f = fixture(); f.start(); const child = f.children[0];
  child.kill = (signal) => { child.signals.push(signal); };
  const stopping = f.capture.stop();
  assert.throws(f.start, /stopping/);
  const again = f.capture.stop(); assert.deepEqual(child.signals, ['SIGTERM']);
  child.emit('close', 0); await Promise.all([stopping, again]);
  f.start(); assert.equal(f.children.length, 2); await f.capture.stop();
});
test('unexpected exit notifies consumer and unsupported hosts never spawn', async () => {
  const f = fixture(); f.start(); f.children[0].emit('close', 1);
  assert.equal(f.capture.current, null); assert.match(f.packets.at(-1).message, /exited/);
  f.capture.platform = 'win32'; assert.throws(f.start, /ARM64 macOS/); assert.equal(f.children.length, 1);
});
test('audio IPC rejects subframes, other origins and windows, including ACK and stop', async () => {
  const handles = new Map(), listeners = new Map();
  const frame = { url: 'http://127.0.0.1:7870/client/' }, owner = { mainFrame: frame, isDestroyed: () => false, send() {} };
  const window = { webContents: owner, isDestroyed: () => false };
  const calls = [];
  installNativeAudio({ ipcMain: { handle: (c, fn) => handles.set(c, fn), on: (c, fn) => listeners.set(c, fn) },
    getWindow: () => window, isAppOrigin: (url) => url === frame.url,
    capture: { start: (...a) => calls.push(['start', ...a]), stop: (...a) => calls.push(['stop', ...a]), ack: (...a) => calls.push(['ack', ...a]) } });
  for (const e of [{ sender: owner, senderFrame: { url: frame.url } }, { sender: {}, senderFrame: frame }]) {
    assert.throws(() => handles.get('native-audio:start')(e, token), /Untrusted/);
    assert.throws(() => handles.get('native-audio:stop')(e, token), /Untrusted/);
    listeners.get('native-audio:ack')(e, token, 1);
  }
  assert.equal(calls.length, 0);
  const event = { sender: owner, senderFrame: frame };
  handles.get('native-audio:start')(event, token); listeners.get('native-audio:ack')(event, token, 1);
  handles.get('native-audio:stop')(event, token); assert.deepEqual(calls.map((c) => c[0]), ['start', 'ack', 'stop']);
});

test('shutdown escalates TERM to KILL and never declares cleanup when the child has not closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(); f.start(); const child = f.children[0];
  child.kill = (signal) => { child.signals.push(signal); };
  const stopping = assert.rejects(f.capture.stop(), /has not exited/);
  t.mock.timers.tick(4000); assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  t.mock.timers.tick(2500); await stopping;
  assert.ok(f.capture.current); assert.throws(f.start, /stopping/);
  child.emit('close', 0); assert.equal(f.capture.current, null);
});
