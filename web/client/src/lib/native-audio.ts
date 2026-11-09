export type NativeAudioStats = {
  renderedFrames: number; bufferedFrames: number; underrunFrames: number;
  peak: number; overRangeSamples: number;
};
export type NativeAudioPacket = {
  token: string; type: string; permission?: string; message?: string;
  pcm?: Uint8Array;
  header?: { sequence: number; frames: number; sampleRate: number; channels: number };
};

/** Same source contract as browser capture. No connection to speakers or transport here. */
export async function captureNativeAudio({ signal, onStats }: {
  signal?: AbortSignal; onStats?: (stats: NativeAudioStats) => void;
} = {}) {
  const api = window.desktop?.nativeAudio;
  if (!api || window.desktop?.platform !== 'darwin') throw new Error('Native audio is unavailable');
  if (signal?.aborted) throw new Error('Native audio cancelled');
  // Construct/resume in the user gesture before any await. Chromium handles later WebRTC encoding.
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const resumed = context.resume();
  const token = crypto.randomUUID();
  let node: AudioWorkletNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let disposed = false, started = false, removeListener: (() => void) | undefined;
  let rejectReady: (reason: Error) => void = () => {};
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Attach a rejection handler while setup is awaiting worklet/module loading.
  void ready.catch(() => {});
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    rejectReady(new Error('Native audio stopped or cancelled'));
    signal?.removeEventListener('abort', dispose);
    window.removeEventListener('pagehide', dispose);
    removeListener?.();
    node?.port.postMessage({ type: 'stop' });
    node?.disconnect(); node?.port.close();
    for (const track of destination?.stream.getTracks() ?? []) track.stop();
    void context.close().catch(() => {});
    if (started) void api.stop(token).catch(() => {});
  };
  const fail = (message: string) => {
    rejectReady(new Error(message));
    // stop() doesn't emit ended. Notify the existing interview source listener explicitly.
    for (const track of destination?.stream.getTracks() ?? []) track.dispatchEvent(new Event('ended'));
    dispose();
  };
  signal?.addEventListener('abort', dispose, { once: true });
  window.addEventListener('pagehide', dispose, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await resumed;
    if (context.sampleRate !== 48000 || context.state !== 'running') throw new Error('48 kHz running AudioContext is required');
    await context.audioWorklet.addModule(`${import.meta.env?.BASE_URL ?? "./"}native-pcm-worklet.js`);
    if (disposed) throw new Error('Native audio cancelled');
    destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
    node = new AudioWorkletNode(context, 'native-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(destination); // Deliberately never connect context.destination: no local echo.
    node.onprocessorerror = () => fail('Native PCM AudioWorklet failed');
    node.port.onmessage = ({ data }) => {
      if (disposed) return;
      if (data.type === 'ack') { api.ack(token, data.sequence); resolveReady(); }
      if (data.type === 'stats') onStats?.(data);
      if (data.type === 'error') fail(data.message);
    };
    removeListener = api.onPacket((packet) => {
      if (disposed || packet.token !== token) return;
      if (packet.type === 'error') { fail(packet.message || 'Native capture failed'); return; }
      if (packet.type !== 'audio') return;
      const h = packet.header, bytes = packet.pcm;
      if (!h || h.sampleRate !== 48000 || h.channels !== 2 || !bytes || bytes.byteLength !== h.frames * 8) {
        fail('Invalid native PCM packet'); return;
      }
      // Explicit little-endian decode, avoiding assumptions about IPC Buffer/typed-array alignment.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const pcm = new Float32Array(h.frames * 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getFloat32(i * 4, true);
      node!.port.postMessage({ type: 'audio', sequence: h.sequence, pcm }, [pcm.buffer]);
    });
    context.onstatechange = () => {
      if (!disposed && context.state !== 'running') fail('Native audio context stopped running');
    };
    timer = setTimeout(() => fail('No native PCM received within 30 seconds'), 30000);
    started = true;
    await api.start(token);
    await ready;
    if (disposed) throw new Error('Native audio cancelled');
    // A transport/manager stopping the track must also release the helper.
    for (const track of destination.stream.getTracks()) {
      const stop = track.stop.bind(track);
      track.stop = () => { stop(); dispose(); };
    }
    return { stream: destination.stream, source: destination.stream, dispose };
  } catch (error) {
    dispose(); throw error;
  } finally { clearTimeout(timer); }
}
