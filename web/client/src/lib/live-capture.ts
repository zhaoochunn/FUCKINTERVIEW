import type { CapturedSystemAudio } from './capture.ts';
import type { SystemAudioMediaManager } from './system-audio-media-manager.ts';

type Attempt = { controller: AbortController; capture?: CapturedSystemAudio; removeEnded?: () => void };

/** Own pending capture as well as the live stream. A late old attempt cannot replace a new one. */
export class LiveCapture {
  private current: Attempt | null = null;
  private microphoneSetup: Promise<void> = Promise.resolve();
  private manager: SystemAudioMediaManager;
  constructor(manager: SystemAudioMediaManager) { this.manager = manager; }

  async start(capture: (options: { signal: AbortSignal }) => Promise<CapturedSystemAudio>, onEnded: () => void) {
    if (this.current) throw new Error('System audio is already preparing or active');
    const attempt = { controller: new AbortController() } as Attempt;
    this.current = attempt;
    try {
      const result = await capture({ signal: attempt.controller.signal });
      if (this.current !== attempt || attempt.controller.signal.aborted) {
        result.dispose(); throw new Error('Audio capture cancelled');
      }
      attempt.capture = result;
      this.manager.setStream(result.stream);
      const track = result.source.getAudioTracks()[0];
      const ended = () => { if (this.current === attempt) onEnded(); };
      track?.addEventListener('ended', ended);
      attempt.removeEnded = () => track?.removeEventListener('ended', ended);
      if (!track || track.readyState !== 'live') throw new Error('System audio track ended before connection');
      return attempt.controller.signal;
    } catch (error) {
      if (this.current === attempt) this.stop();
      throw error;
    }
  }
  assertActive(signal: AbortSignal) {
    if (!this.current || this.current.controller.signal !== signal || signal.aborted) throw new Error('Audio capture cancelled');
  }
  async prepareMicrophone(signal: AbortSignal, prepare: (check: () => void) => Promise<void>, disconnect: () => Promise<void>) {
    const previous = this.microphoneSetup;
    const next = (async () => {
      await previous;
      this.assertActive(signal);
      try {
        await prepare(() => this.assertActive(signal));
        this.assertActive(signal);
      } catch (error) {
        if (signal.aborted) await disconnect().catch(() => {});
        throw error;
      }
    })();
    // New attempts wait for stale device initialization and its cleanup to settle.
    this.microphoneSetup = next.catch(() => {});
    return next;
  }
  stop() {
    const attempt = this.current;
    this.current = null;
    attempt?.controller.abort(); attempt?.removeEnded?.();
    this.manager.stop(); attempt?.capture?.dispose();
  }
}
