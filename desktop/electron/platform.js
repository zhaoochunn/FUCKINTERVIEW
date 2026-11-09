"use strict";

function windowOptions(platform) {
  return platform === "darwin"
    ? { frame: true, autoHideMenuBar: false }
    : { frame: false, autoHideMenuBar: true };
}

function menuTemplate(platform, title, quit) {
  const mac = platform === "darwin";
  return [
    ...(mac ? [{ label: title, submenu: [
      { role: "about" }, { type: "separator" }, { role: "services" },
      { type: "separator" }, { role: "hide" }, { role: "hideOthers" },
      { role: "unhide" }, { type: "separator" },
      { label: "退出", accelerator: "Command+Q", click: quit },
    ] }] : []),
    { label: "文件", submenu: mac ? [{ role: "close" }] : [
      { label: "退出", accelerator: "Ctrl+Q", click: quit },
    ] },
    { label: "编辑", submenu: [
      { role: "undo", label: "撤销" }, { role: "redo", label: "重做" },
      { type: "separator" }, { role: "cut", label: "剪切" },
      { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" },
      { role: "selectAll", label: "全选" },
    ] },
    { label: "视图", submenu: [
      { role: "reload", label: "刷新" }, { role: "toggleDevTools", label: "开发者工具" },
      { type: "separator" }, { role: "resetZoom", label: "实际大小" },
      { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" },
      { type: "separator" }, { role: "togglefullscreen", label: "全屏" },
    ] },
    ...(mac ? [{ role: "windowMenu" }] : []),
  ];
}

// Chromium permission handlers do not grant macOS TCC permissions.
function permissionStatus(platform, systemPreferences) {
  const read = (kind) => {
    if (platform !== "darwin") return "unavailable";
    try { return systemPreferences.getMediaAccessStatus(kind); }
    catch { return "unknown"; }
  };
  return {
    microphone: read("microphone"), camera: read("camera"), screen: read("screen"),
    systemAudio: platform === "darwin" ? "not-implemented" : "unverified",
  };
}

module.exports = { windowOptions, menuTemplate, permissionStatus };
