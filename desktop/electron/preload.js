"use strict";

/**
 * 仅暴露具体桌面操作；原生音频使用固定通道、会话 token 和受信主帧校验。
 * 界面靠 `window.desktop` 是否存在来判断自己是不是在桌面端里跑。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,
  nativeAudio: {
    start: (token) => ipcRenderer.invoke("native-audio:start", token),
    stop: (token) => ipcRenderer.invoke("native-audio:stop", token),
    ack: (token, sequence) => ipcRenderer.send("native-audio:ack", token, sequence),
    onPacket: (listener) => {
      const handler = (_event, packet) => listener(packet);
      ipcRenderer.on("native-audio:packet", handler);
      return () => ipcRenderer.removeListener("native-audio:packet", handler);
    },
  },
  storage: {
    pickDirectory: (initial) => ipcRenderer.invoke("storage:pick-directory", initial),
  },
  permissions: {
    status: () => ipcRenderer.invoke("permissions:status"),
    requestMicrophone: () => ipcRenderer.invoke("permissions:request-microphone"),
  },
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onMaximizeChange: (listener) => {
    const handler = (_event, value) => listener(Boolean(value));
    ipcRenderer.on("window:maximized", handler);
    return () => ipcRenderer.removeListener("window:maximized", handler);
  },
  privacy: {
    supported: process.platform === "win32",
    getContentProtection: () =>
      ipcRenderer.invoke("privacy:get-content-protection"),
    setContentProtection: (enabled) =>
      ipcRenderer.invoke("privacy:set-content-protection", Boolean(enabled)),
  },
});
