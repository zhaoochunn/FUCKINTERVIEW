import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { captureSystemAudio, type CapturedSystemAudio } from '@/lib/capture';

/** Local-only check through the same entry used by live interviews. No transport is constructed. */
export function NativeAudioCheck({ zh }: { zh: boolean }) {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState('');
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const start = async () => {
    if (cleanup.current) return;
    setRunning(true); setReport(zh ? '等待权限与系统音频…' : 'Waiting for permission and PCM…');
    let latest: import("@/lib/native-audio").NativeAudioStats | undefined;
    let capture: CapturedSystemAudio | undefined;
    let context: AudioContext | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    // The common capture entry accepts a signal for setup cancellation as well as active capture.
    const stop = () => {
      controller.abort(); clearInterval(timer); clearTimeout(deadline);
      capture?.dispose(); void context?.close().catch(() => {});
      if (cleanup.current === stop) { cleanup.current = null; setRunning(false); }
    };
    cleanup.current = stop;
    try {
      // Create/resume the measurement context inside this same user gesture.
      context = new AudioContext({ sampleRate: 48000 });
      const resumed = context.resume();
      void resumed.catch(() => {});
      capture = await captureSystemAudio({ signal: controller.signal, onStats: (stats) => { latest = stats; } });
      if (controller.signal.aborted) { capture.dispose(); return; }
      await resumed;
      const source = context.createMediaStreamSource(capture.stream);
      const splitter = context.createChannelSplitter(2);
      source.connect(splitter);
      const analysers = [context.createAnalyser(), context.createAnalyser()];
      analysers.forEach((analyser, channel) => { analyser.fftSize = 2048; splitter.connect(analyser, channel); });
      const values = new Float32Array(2048);
      let observations = 0, nonSilentObservations = 0, maxMediaPeak = 0;
      timer = setInterval(() => {
        let squares = 0;
        for (const analyser of analysers) {
          analyser.getFloatTimeDomainData(values);
          for (const value of values) { squares += value * value; maxMediaPeak = Math.max(maxMediaPeak, Math.abs(value)); }
        }
        const rms = Math.sqrt(squares / (values.length * 2));
        observations++; if (rms >= 0.001) nonSilentObservations++;
        setReport(JSON.stringify({ trackState: capture!.stream.getAudioTracks()[0]?.readyState,
          contextSampleRate: context!.sampleRate, observations, nonSilentObservations,
          mediaStreamRms: rms, maxMediaPeak, worklet: latest }, null, 2));
      }, 500);
      capture.source.getAudioTracks()[0]?.addEventListener('ended', () => {
        setReport(zh ? '采集异常结束，请检查权限/后端并重试。' : 'Capture ended unexpectedly. Check permissions/backend.'); stop();
      }, { once: true });
      deadline = setTimeout(stop, 30000);
    } catch (error) {
      if (!controller.signal.aborted) setReport(error instanceof Error ? error.message : String(error));
      stop();
    }
  };
  return <div className="grid gap-2">
    <p>{zh ? '系统音频桥接检查（30 秒，仅本机；不会连接语音识别或 AI）。请先播放测试音频。' : 'System audio bridge check (30 seconds, local only; no ASR or AI). Play test audio first.'}</p>
    <div className="flex gap-2">
      <Button type="button" variant="outline" size="sm" disabled={running} onClick={() => void start()}>{zh ? '开始本机音频检查' : 'Start local audio check'}</Button>
      <Button type="button" variant="outline" size="sm" disabled={!running} onClick={() => cleanup.current?.()}>{zh ? '停止检查' : 'Stop check'}</Button>
    </div>
    {report && <pre className="whitespace-pre-wrap break-all" role="status">{report}</pre>}
  </div>;
}
