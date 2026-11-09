/**
 * System-audio capture for the browser build.
 *
 * The desktop shell will replace the source with a native loopback stream,
 * but the rest of the chain (this module's output shape, the media manager,
 * the pipeline) stays the same.
 */

export type CaptureErrorCode = "unsupported" | "cancelled" | "no-audio";

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;

  constructor(code: CaptureErrorCode) {
    super(code);
    this.name = "CaptureError";
    this.code = code;
  }
}

export interface CapturedSystemAudio {
  /** 做过音量归一化的音频流，交给 transport。 */
  stream: MediaStream;
  /** 原始采集流；视频轨留在这里维持 Electron 的环回会话。 */
  source: MediaStream;
  /** 结束采集：停掉处理链和原始轨。 */
  dispose: () => void;
}

/** 目标语音响度（RMS）。系统音量开到 10% 时原始 RMS 约 0.005。 */
const TARGET_RMS = 0.09;
/** 最多放大 8 倍（约 +18dB），再高会把底噪一起抬起来。 */
const MAX_GAIN = 8;
/** 低于这个 RMS 视为没有人在说话，增益慢慢退回 1。 */
const SPEECH_RMS = 0.0015;
/** 说完一句后先保持增益一段时间，避免句间停顿把声音压回去。 */
const HOLD_MS = 1500;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 复用同一个 AudioContext。必须在用户点击的调用栈里创建/唤醒：等
 * getDisplayMedia 走完再建，浏览器的自动播放策略可能让它停在 suspended，
 * 整条处理链就只会输出静音。
 */
let sharedContext: AudioContext | null = null;

function ensureAudioContext(): AudioContext | null {
  const AudioContextClass =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextClass) return null;

  if (!sharedContext || sharedContext.state === "closed") {
    try {
      sharedContext = new AudioContextClass({ latencyHint: "interactive" });
    } catch {
      return null;
    }
  }
  void sharedContext.resume().catch(() => {});
  return sharedContext;
}

/**
 * 把系统音频接到一条 WebAudio 处理链上：高通滤掉低频轰鸣，按当前响度
 * 自动增益，再过一道限幅器防止削顶。
 *
 * 系统音频常常是「面试官那边把播放音量调得很小」：原始 RMS 只有 0.005
 * 左右（约 -46dBFS），服务端 VAD 会丢掉轻声帧、ASR 也容易听不清。
 * 这里把语音段拉到接近正常说话的水平，间奏和静音段不放大。
 *
 * 处理链只有几毫秒延迟；返回的轨道替换原始音轨送进 WebRTC。
 * 浏览器不支持 WebAudio 或上下文没能运行时退回原始音频，采集本身不受影响。
 */
function amplifyQuietAudio(
  source: MediaStream,
  context: AudioContext
): {
  stream: MediaStream;
  dispose: () => void;
} {
  let sourceNode: MediaStreamAudioSourceNode;
  let destination: MediaStreamAudioDestinationNode;
  try {
    sourceNode = context.createMediaStreamSource(source);
    destination = context.createMediaStreamDestination();
  } catch {
    return { stream: source, dispose: () => {} };
  }

  const highpass = context.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 80;
  highpass.Q.value = 0.7;

  const gain = context.createGain();
  gain.gain.value = 1;

  // 增益之后再限幅：安静时大幅提升，突然变响也不会削顶。
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 3;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.2;

  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;

  sourceNode.connect(highpass);
  highpass.connect(gain);
  gain.connect(limiter);
  limiter.connect(destination);
  sourceNode.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  let currentGain = 1;
  let lastSpeechAt = 0;

  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      sum += samples[index] * samples[index];
    }
    const rms = Math.sqrt(sum / samples.length);
    const now = performance.now();
    if (rms >= SPEECH_RMS) lastSpeechAt = now;

    const inSpeech = now - lastSpeechAt < HOLD_MS;
    const target = inSpeech
      ? clamp(TARGET_RMS / Math.max(rms, SPEECH_RMS), 1, MAX_GAIN)
      : 1;
    // 提上去要快（约 100ms），放下来慢（约 1s），声音不会忽大忽小。
    const factor = target > currentGain ? 0.5 : 0.08;
    currentGain += (target - currentGain) * factor;
    gain.gain.setTargetAtTime(currentGain, context.currentTime, 0.05);
  }, 80);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.clearInterval(timer);
    try {
      sourceNode.disconnect();
      highpass.disconnect();
      gain.disconnect();
      limiter.disconnect();
      analyser.disconnect();
    } catch {
      // 节点已经断开时 disconnect 会抛错，收尾不需要关心。
    }
    for (const track of destination.stream.getTracks()) track.stop();
    // AudioContext 留着复用：下一场采集不需要再走一次自动播放策略。
  };

  return {
    stream: new MediaStream(destination.stream.getAudioTracks()),
    dispose,
  };
}

/**
 * Asks the user to share their screen and keeps the system-audio track.
 *
 * Chrome/Edge on Windows can attach system audio (WASAPI loopback) when the
 * user picks the entire screen and ticks "share system audio"; a browser tab
 * yields that tab's audio instead.
 */
export async function captureSystemAudio(): Promise<CapturedSystemAudio> {
  if (window.desktop?.platform === "darwin") {
    throw new CaptureError("unsupported");
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new CaptureError("unsupported");
  }

  // 在用户手势里先把 AudioContext 建好并唤醒；等采集对话框回来再建，
  // 浏览器可能不让它运行，整条增益链会输出静音。
  const audioContext = ensureAudioContext();
  if (audioContext && audioContext.state !== "running") {
    // 等它真正跑起来；最多等 400ms，别把连接卡住。
    await Promise.race([
      audioContext.resume().catch(() => {}),
      new Promise<void>((resolve) => window.setTimeout(resolve, 400)),
    ]);
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // 保留视频轨只是为了撑住 Electron 的屏幕采集会话（视频轨一停，环回
      // 音轨过一会儿也会 ended）。这里把分辨率/帧率压到最低，历史构建
      // 按 1080p30 持续采集会抢 CPU，间接把音频线程拖慢。
      video: {
        width: { max: 320 },
        height: { max: 180 },
        frameRate: { max: 5 },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // Keep playing the captured audio locally so the candidate still
        // hears the interviewer.
        suppressLocalAudioPlayback: false,
      },
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
    } as DisplayMediaStreamOptions);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "AbortError") {
      throw new CaptureError("cancelled");
    }
    // Electron shells without a display-media handler land here.
    if (name === "NotSupportedError" || name === "TypeError") {
      throw new CaptureError("unsupported");
    }
    throw error;
  }

  // 有的实现会忽略采集参数；再约束一次，尽力把持续采集的开销压下来。
  for (const track of stream.getVideoTracks()) {
    void track
      .applyConstraints({
        width: { max: 320 },
        height: { max: 180 },
        frameRate: { max: 5 },
      })
      .catch(() => {});
  }

  // 不要在这里 stop() 视频轨：Electron 的系统环回音轨挂在同一次屏幕采集
  // 会话上，视频轨一停，音频轨过一会儿也会变成 ended（表现为服务端一直
  // "No audio frame received"）。视频轨不交给 transport（SystemAudioMediaManager
  // 只返回音频），等整场结束再和音频一起停。
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new CaptureError("no-audio");
  }

  // 桌面端环回音轨偶尔会「存在但已经结束」；继续连接只会得到永远静音的
  // 会话，看起来像「识别不到声音」。这里直接当成没有系统音频。
  const ended = audioTracks.find((track) => track.readyState === "ended");
  if (ended || audioTracks.every((track) => track.readyState !== "live")) {
    for (const track of stream.getTracks()) track.stop();
    throw new CaptureError("no-audio");
  }

  // muted 在刚拿到环回音轨时可能短暂为 true（还没有声音播放），不阻断，
  // 但写进控制台方便排查「音轨在、始终静音」的问题。
  if (audioTracks.every((track) => track.muted)) {
    console.warn("[capture] 系统音频轨当前为 muted，可能暂时收不到声音");
  }

  // 上下文没能运行就退回原始音频：宁可没有增益，也不能让整条链输出静音。
  const processed =
    audioContext && audioContext.state === "running"
      ? amplifyQuietAudio(stream, audioContext)
      : null;
  if (!processed) {
    console.warn("[capture] AudioContext 未运行，系统音频不做自动增益");
  }

  return {
    stream: processed?.stream ?? stream,
    source: stream,
    dispose: () => {
      processed?.dispose();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
