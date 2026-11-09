export {};

declare global {
  interface Window {
    /** 由 desktop/electron/preload.js 注入；浏览器里不存在。 */
    desktop?: {
      isDesktop: true;
      platform: string;
      nativeAudio?: {
        start: (token: string) => Promise<string>;
        stop: (token: string) => Promise<void>;
        ack: (token: string, sequence: number) => void;
        onPacket: (listener: (packet: import("../lib/native-audio").NativeAudioPacket) => void) => () => void;
      };
      storage: { pickDirectory: (initial: string) => Promise<string> };
      permissions: {
        status: () => Promise<{
          microphone: string; camera: string; screen: string; systemAudio: string;
        }>;
        requestMicrophone: () => Promise<boolean>;
      };
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      isMaximized: () => Promise<boolean>;
      onMaximizeChange: (listener: (maximized: boolean) => void) => () => void;
      /** 防截屏 / 防录屏（桌面端由主进程的窗口保护实现）。 */
      privacy?: {
        supported: boolean;
        getContentProtection: () => Promise<boolean>;
        setContentProtection: (enabled: boolean) => Promise<boolean>;
      };
    };
  }
}
