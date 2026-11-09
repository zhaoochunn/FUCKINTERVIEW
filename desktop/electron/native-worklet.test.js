"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function worklet() {
  let Processor; const messages = [];
  const context = vm.createContext({ Float32Array, Number, Math, AudioWorkletProcessor: class {
    constructor() { this.port = { postMessage: (data) => messages.push(data) }; }
  }, registerProcessor(_name, constructor) { Processor = constructor; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../web/client/public/native-pcm-worklet.js'), 'utf8'), context);
  const p = new Processor();
  const push = (pcm, sequence = 1) => p.port.onmessage({ data: { pcm, sequence, type: 'audio' } });
  const render = () => { const channels = [new Float32Array(128), new Float32Array(128)]; p.process([], [channels]); return channels; };
  return { p, messages, push, render };
}
test('worklet preserves channel order and >1 float headroom, renders in FIFO order without local playback', () => {
  const f = worklet(); const pcm = new Float32Array(4096);
  for (let i = 0; i < 2048; i++) { pcm[i * 2] = 1.1; pcm[i * 2 + 1] = -0.25; }
  f.push(pcm); assert.equal(f.messages[0].type, 'ack');
  const [left, right] = f.render(); assert.equal(left[0], pcm[0]); assert.equal(right[127], -0.25);
  assert.equal(f.p.overRangeSamples, 2048); assert.equal(f.p.size, 1920);
  for (let i = 0; i < 15; i++) f.render();
  assert.equal(f.p.size, 0); assert.ok(f.render()[0].every((value) => value === 0));
  assert.equal(f.p.underrunFrames, 128);
});
test('worklet has bounded preroll/rebuffer and fails explicitly on overflow or invalid samples', () => {
  const f = worklet(); f.push(new Float32Array(1024));
  assert.ok(f.render()[0].every((v) => v === 0)); assert.equal(f.p.size, 512);
  f.push(new Float32Array(48000)); assert.equal(f.messages.at(-1).type, 'error'); assert.equal(f.p.size, 0);
  const invalid = worklet(); invalid.push(new Float32Array([NaN, 0])); assert.equal(invalid.messages.at(-1).type, 'error');
  assert.equal(invalid.p.failed, true);
});
test('worklet ring wraps without changing stereo data and stop releases retained audio', () => {
  const f = worklet();
  for (let round = 0; round < 30; round++) {
    const pcm = new Float32Array(4096).fill(round / 100);
    f.push(pcm, round + 1);
    for (let i = 0; i < 16; i++) assert.equal(f.render()[0][0], pcm[0]);
  }
  assert.equal(f.p.frames, 61440); assert.ok(f.messages.some((m) => m.type === 'stats'));
  f.p.port.onmessage({ data: { type: 'stop' } });
  assert.equal(f.p.size, 0); assert.ok(f.p.ring.every((v) => v === 0));
});
