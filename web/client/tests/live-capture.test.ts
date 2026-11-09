import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveCapture } from '../src/lib/live-capture.ts';
import { SystemAudioMediaManager } from '../src/lib/system-audio-media-manager.ts';
function fixture() {
  let stops = 0, disposed = 0;
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop() { stops++; } });
  const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
  return { track, stream, capture: { stream, source: stream, dispose() { disposed++; } }, counts: () => ({ stops, disposed }) };
}
test('live system stream uses the existing media manager, isolates ended events and releases once', async () => {
  const manager = new SystemAudioMediaManager(); const owner = new LiveCapture(manager); const f = fixture(); let ended = 0;
  const signal = await owner.start(async () => f.capture, () => ended++);
  assert.equal(manager.tracks().local.audio, f.track); owner.assertActive(signal);
  f.track.dispatchEvent(new Event('ended')); assert.equal(ended, 1);
  owner.stop(); owner.stop(); assert.equal(signal.aborted, true);
  f.track.dispatchEvent(new Event('ended')); assert.equal(ended, 1);
  assert.deepEqual(f.counts(), { stops: 1, disposed: 1 }); assert.equal(manager.tracks().local.audio, undefined);
});
test('stop during permission/setup aborts pending capture; late resolution cannot replace a newer session', async () => {
  const manager = new SystemAudioMediaManager(), owner = new LiveCapture(manager), old = fixture(), fresh = fixture();
  let resolve!: (value: typeof old.capture) => void; let pendingSignal!: AbortSignal;
  const pending = owner.start(({ signal }) => { pendingSignal = signal; return new Promise((r) => { resolve = r; }); }, () => {});
  await assert.rejects(owner.start(async () => fresh.capture, () => {}), /already/);
  owner.stop(); assert.equal(pendingSignal.aborted, true);
  const current = await owner.start(async () => fresh.capture, () => {});
  resolve(old.capture); await assert.rejects(pending, /cancelled/);
  assert.equal(old.counts().disposed, 1); assert.equal(manager.tracks().local.audio, fresh.track);
  assert.throws(() => owner.assertActive(pendingSignal), /cancelled/); owner.assertActive(current); owner.stop();
});
test('failed permission and ended source leave no track or active lease and allow a new attempt', async () => {
  const owner = new LiveCapture(new SystemAudioMediaManager());
  await assert.rejects(owner.start(async () => { throw new Error('permission denied'); }, () => {}), /permission denied/);
  const f = fixture(); f.track.readyState = 'ended';
  await assert.rejects(owner.start(async () => f.capture, () => {}), /ended/); assert.equal(f.counts().disposed, 1);
  const fresh = fixture(); await owner.start(async () => fresh.capture, () => {}); owner.stop();
});

test('cancelled microphone initialization settles and cleans up before a newer lane may connect', async () => {
  const owner = new LiveCapture(new SystemAudioMediaManager()), calls: string[] = [];
  const old = await owner.start(async () => fixture().capture, () => {});
  let release!: () => void;
  const first = owner.prepareMicrophone(old, async (check) => {
    calls.push('old-init'); await new Promise<void>((resolve) => { release = resolve; }); check(); calls.push('old-connect');
  }, async () => { calls.push('old-disconnect'); });
  await new Promise(setImmediate); owner.stop();
  const current = await owner.start(async () => fixture().capture, () => {});
  const next = owner.prepareMicrophone(current, async (check) => { check(); calls.push('new-connect'); }, async () => {});
  const rejected = assert.rejects(first, /cancelled/); release(); await rejected; await next;
  assert.deepEqual(calls, ['old-init', 'old-disconnect', 'new-connect']); owner.stop();
});
