"use strict";

/**
 * 渲染进程唯一能拿到的桌面能力：窗口控制。
 * 界面靠 `window.desktop` 是否存在来判断自己是不是在桌面端里跑。
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,
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
