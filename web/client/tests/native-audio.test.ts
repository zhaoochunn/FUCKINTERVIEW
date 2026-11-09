import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNativeAudio } from '../src/lib/native-audio.ts';
import { captureSystemAudio } from '../src/lib/capture.ts';

function setup({ failStart = false, blockModule = false } = {}) {
  const state = { starts: 0, stops: 0, ack: 0, removed: 0, closed: 0, tracksStopped: 0, speakerConnections: 0 };
  let listener: ((packet: unknown) => void) | undefined, currentToken = '', release = () => {};
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop() { state.tracksStopped++; this.readyState = 'ended'; } });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Context {
    state = 'running'; sampleRate = 48000;
    destination = {};
    audioWorklet = { addModule: () => blockModule ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve() };
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; state.closed++; return Promise.resolve(); }
    createMediaStreamDestination() { return { stream, channelCount: 2 }; }
  }
  class Worklet {
    port = { onmessage: undefined as ((e: { data: unknown }) => void) | undefined,
      postMessage: (data: { type: string; sequence?: number }) => {
        if (data.type === 'audio') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ack', sequence: data.sequence } }));
      }, close() {} };
    connect(destination: object) { if (!(destination as { stream?: unknown }).stream) state.speakerConnections++; }
    disconnect() {}
  }
  const host = Object.assign(new EventTarget(), { desktop: { platform: 'darwin', nativeAudio: {
    onPacket(fn: typeof listener) { listener = fn; return () => { listener = undefined; state.removed++; }; },
    async start(token: string) {
      state.starts++; currentToken = token;
      if (failStart) throw new Error('helper unavailable');
      listener?.({ token, type: 'audio', header: { sequence: 1, sampleRate: 48000, channels: 2, frames: 16 }, pcm: new Uint8Array(128) });
      return token;
    },
    async stop() { state.stops++; }, ack() { state.ack++; },
  } } });
  const saved = ['window', 'AudioContext', 'AudioWorkletNode'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, { window: host, AudioContext: Context, AudioWorkletNode: Worklet });
  return { state, host, track, release: () => release(),
    error: () => listener?.({ token: currentToken, type: 'error', message: 'permission revoked' }),
    restore() { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } };
}

test('native stream readiness waits for worklet ACK; manager track.stop tears down helper and listeners', async () => {
  const f = setup();
  try {
    const capture = await captureSystemAudio();
    assert.equal(f.state.ack, 1); assert.equal(f.state.speakerConnections, 0);
    capture.stream.getAudioTracks()[0].stop(); capture.dispose();
    assert.equal(f.state.stops, 1); assert.equal(f.state.closed, 1); assert.equal(f.state.removed, 1);
  } finally { f.restore(); }
});
test('native setup failure and abort during module loading release context without a late spawn', async () => {
  const failed = setup({ failStart: true });
  try { await assert.rejects(captureNativeAudio(), /helper unavailable/); assert.equal(failed.state.closed, 1); }
  finally { failed.restore(); }
  const f = setup({ blockModule: true });
  try {
    const controller = new AbortController(); const pending = captureNativeAudio({ signal: controller.signal });
    await new Promise(setImmediate); controller.abort(); f.release();
    await assert.rejects(pending, /cancelled/); assert.equal(f.state.starts, 0); assert.equal(f.state.closed, 1);
  } finally { f.restore(); }
});
test('runtime helper failure emits ended for existing transport cleanup and releases resources', async () => {
  const f = setup();
  try {
    await captureNativeAudio(); let ended = 0;
    f.track.addEventListener('ended', () => { ended++; }); f.error();
    assert.equal(ended, 1); assert.equal(f.state.stops, 1); assert.equal(f.state.closed, 1);
  } finally { f.restore(); }
});
