"use strict";

const path = require("node:path");
const { permissionStatus } = require("./platform");

function trustedSender(event, window, isAppOrigin) {
  return Boolean(window && !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isAppOrigin(event.senderFrame?.url));
}

function installDesktopServices({ ipcMain, dialog, systemPreferences, platform,
  getWindow, isAppOrigin }) {
  const handle = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    const window = getWindow();
    if (!trustedSender(event, window, isAppOrigin)) throw new Error("Untrusted desktop request");
    return handler(window, ...args);
  });
  let picking = false;
  handle("storage:pick-directory", async (window, initial) => {
    if (typeof initial !== "string" || initial.length > 4096 || initial.includes("\0")) {
      throw new Error("Invalid directory path");
    }
    if (picking) throw new Error("Directory picker already open");
    picking = true;
    try {
      const result = await dialog.showOpenDialog(window, {
        title: "选择文件夹",
        properties: ["openDirectory", "createDirectory"],
        ...(path.isAbsolute(initial) ? { defaultPath: initial } : {}),
      });
      return result.canceled ? "" : result.filePaths[0] || "";
    } finally { picking = false; }
  });
  handle("permissions:status", () => permissionStatus(platform, systemPreferences));
  handle("permissions:request-microphone", async () => {
    if (platform !== "darwin") return false;
    return systemPreferences.askForMediaAccess("microphone");
  });
}

module.exports = { installDesktopServices, trustedSender };
