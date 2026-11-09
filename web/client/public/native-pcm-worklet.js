/* Local PCM only. No device capture, speaker connection, persistence or network. */
class NativePCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 24000;
    this.ring = new Float32Array(this.capacity * 2);
    this.read = 0; this.write = 0; this.size = 0;
    this.playing = false; this.failed = false;
    this.frames = 0; this.underrunFrames = 0; this.overRangeSamples = 0; this.peak = 0;
    this.reportAt = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'stop') { this.failed = true; this.size = 0; this.ring.fill(0); return; }
      if (this.failed) return;
      const pcm = data.pcm;
      if (!(pcm instanceof Float32Array) || pcm.length % 2 || pcm.length / 2 > this.capacity - this.size) {
        this.fail('PCM worklet buffer overflow or invalid stereo packet'); return;
      }
      for (const value of pcm) {
        if (!Number.isFinite(value)) { this.fail('Non-finite PCM sample'); return; }
      }
      for (let frame = 0; frame < pcm.length / 2; frame++) {
        for (let ch = 0; ch < 2; ch++) {
          const value = pcm[frame * 2 + ch];
          this.ring[this.write * 2 + ch] = value;
          this.peak = Math.max(this.peak, Math.abs(value));
          if (Math.abs(value) > 1) this.overRangeSamples++;
        }
        this.write = (this.write + 1) % this.capacity;
        this.size++;
      }
      this.port.postMessage({ type: 'ack', sequence: data.sequence });
    };
  }
  fail(message) {
    this.failed = true; this.size = 0; this.ring.fill(0);
    this.port.postMessage({ type: 'error', message });
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.length) return !this.failed;
    for (const channel of output) channel.fill(0);
    if (this.failed) return false;
    // ~43 ms preroll, rebuffer after starvation. Never stretch, clip or change gain.
    if (!this.playing && this.size >= 2048) this.playing = true;
    if (this.playing) {
      for (let frame = 0; frame < output[0].length; frame++) {
        if (!this.size) {
          this.underrunFrames += output[0].length - frame;
          this.playing = false; break;
        }
        for (let ch = 0; ch < Math.min(output.length, 2); ch++) output[ch][frame] = this.ring[this.read * 2 + ch];
        this.ring[this.read * 2] = 0; this.ring[this.read * 2 + 1] = 0;
        this.read = (this.read + 1) % this.capacity; this.size--; this.frames++;
      }
    }
    if (this.frames - this.reportAt >= 48000) {
      this.reportAt = this.frames;
      this.port.postMessage({ type: 'stats', renderedFrames: this.frames, bufferedFrames: this.size,
        underrunFrames: this.underrunFrames, peak: this.peak, overRangeSamples: this.overRangeSamples });
    }
    return true;
  }
}
registerProcessor('native-pcm', NativePCMProcessor);
