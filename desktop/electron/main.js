"use strict";

/**
 * 桌面端入口：Electron 外壳托管本地 Python 服务，
 * 窗口里加载的就是浏览器版同一套前端（http://127.0.0.1:<port>/client/）。
 *
 * 和浏览器版的区别：
 *  - 无边框窗口，标题栏由前端自己画（见 web/client 的 DesktopTitleBar）；
 *  - 点右上角关闭是收进托盘，托盘菜单里才是真的退出；
 *  - 系统音频不再弹共享选择器，主进程直接给屏幕 + 环回音频（Windows）；
 *  - 麦克风等权限由主进程统一放行，不再弹浏览器授权框。
 */

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  desktopCapturer,
  ipcMain,
  nativeImage,
  session,
  shell,
  systemPreferences,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { startBackend, stopAll, ROOT } = require("./backend");
const { createUrlPolicy, normalizeOrigin, safeExternalUrl } = require("./url-policy");

const { windowOptions, menuTemplate } = require("./platform");
const { installDesktopServices, trustedSender } = require("./desktop-services");
const { NativeAudio, installNativeAudio } = require("./native-audio");
const nativeAudio = new NativeAudio({ executable: path.join(__dirname, "../native/macos-audio/build/SystemAudioProbe.app/Contents/MacOS/SystemAudioProbe") });
const stopNativeAudio = () => nativeAudio.stop().catch((error) => console.error("[native-audio]", error.message));
const IS_MAC = process.platform === "darwin";

const IS_DEV = process.argv.includes("--dev");
const BUILD_DIR = path.join(__dirname, "..", "build");
// 打包后 build/ 不会进 asar，图标由 extraResources 放到 resources 根目录。
const ASSET_DIR = app.isPackaged ? process.resourcesPath : BUILD_DIR;
const ICON_PATH = path.join(ASSET_DIR, "icon.png");
const TRAY_ICON_PATH = path.join(ASSET_DIR, "tray.png");
const PRELOAD_PATH = path.join(__dirname, "preload.js");

// 开发端和安装版彻底分开：不同的 userData（日志、单实例锁）和默认端口。
// 否则开着安装版时 `npm start` 会把窗口交给安装版实例。
//
// desktop/dist/win-unpacked 里的是「构建产物」，不是安装版：它也是 packaged，
// 但绝不能和安装版共用 userData，否则历史构建一运行就会读写安装版的数据、
// 抢单实例锁。按路径识别后单独放 interview-desktop-build。
const BUILD_TREE_RUN = path
  .normalize(process.execPath)
  .toLowerCase()
  .includes(`${path.sep}dist${path.sep}win-unpacked${path.sep}`);
if (!app.isPackaged || BUILD_TREE_RUN) {
  const userDataDir = path.join(
    app.getPath("appData"),
    BUILD_TREE_RUN ? "interview-desktop-build" : "interview-desktop-dev"
  );
  app.setPath("userData", userDataDir);
  // Chromium 的 localStorage / IndexedDB 走 sessionData，不跟着 userData 自动换；
  // 不显式隔开的话，历史构建会读到安装版记住的页面和麦克风。
  app.setPath("sessionData", path.join(userDataDir, "session"));
}
const DEV_CHANNEL = !app.isPackaged || BUILD_TREE_RUN;
const APP_TITLE = DEV_CHANNEL ? "FUCKINTERVIEW（开发版）" : "FUCKINTERVIEW";
const DEV_PORT = 7870;
const BUILD_PORT = 7871;

/**
 * 安装版从旧名字“面试语音助手”改名为 FUCKINTERVIEW 后，userData 会从
 * %APPDATA%\面试语音助手 变成 %APPDATA%\FUCKINTERVIEW。首次启动时把旧目录里
 * 的业务数据、本地偏好和防截屏设置复制过来，旧目录原样保留。
 * 开发版和构建产物有自己的 userData，不参与这段迁移。
 */
function migrateLegacyUserData() {
  if (!app.isPackaged || BUILD_TREE_RUN) return;
  try {
    const oldRoot = path.join(app.getPath("appData"), "面试语音助手");
    const newRoot = app.getPath("userData");
    if (
      !fs.existsSync(oldRoot) ||
      path.resolve(oldRoot) === path.resolve(newRoot)
    ) {
      return;
    }

    const copyDir = (name) => {
      const source = path.join(oldRoot, name);
      const target = path.join(newRoot, name);
      if (!fs.existsSync(source) || fs.existsSync(target)) return false;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
      return true;
    };
    const copyFile = (name) => {
      const source = path.join(oldRoot, name);
      const target = path.join(newRoot, name);
      if (!fs.existsSync(source) || fs.existsSync(target)) return false;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      return true;
    };

    const copiedData = copyDir("data");
    const copiedPrefs = copyDir("Local Storage");
    const copiedPrivacy = copyFile("privacy.json");
    if (copiedData || copiedPrefs || copiedPrivacy) {
      console.log(`[app] migrated legacy userData: ${oldRoot} -> ${newRoot}`);
    }
  } catch (error) {
    console.error("[app] 迁移旧版 userData 失败", error);
  }
}


/** 主进程允许网页申请的权限：只放行本地界面真正会用到的。 */
const ALLOWED_PERMISSIONS = new Set([
  "media", // 麦克风 / 摄像头
  "audioCapture",
  "videoCapture",
  "display-capture", // getDisplayMedia
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
]);

const LOADING_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #0a0a0a; color: #e5e5e5;
    font: 14px/1.6 system-ui, "Microsoft YaHei", sans-serif;
    -webkit-app-region: drag;
  }
  .wrap { display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .ring {
    width: 26px; height: 26px; border-radius: 50%;
    border: 2px solid #2a2a2a; border-top-color: #4ade80;
    animation: spin .9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { margin: 0; opacity: .75; }
</style></head>
<body><div class="wrap"><div class="ring"></div><p>正在启动本地服务…</p></div></body></html>`)}`;

let mainWindow = null;
let tray = null;
let backend = null;
let retiredBackend = null;
let quitting = false; // 用户真的要退出（托盘菜单 / Ctrl+Q）
let bootPromise = null;
const startupAbort = new AbortController();
let cleanedUp = false; // 后端已经收干净，可以放行退出
// 本地服务的精确 Origin（端口是动态的），后端就绪后设置。
const urlPolicy = createUrlPolicy(LOADING_PAGE);

function isAppUrl(url) {
  return urlPolicy.isAppUrl(url);
}

function isAppOrigin(origin) {
  return urlPolicy.isAppOrigin(origin);
}

/** 站外链接只交给系统浏览器打开 http/https，其他协议一律忽略。 */
function openExternalSafely(raw) {
  const target = safeExternalUrl(raw);
  if (target) void shell.openExternal(target);
}

function createWindow(initialUrl = LOADING_PAGE) {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: APP_TITLE,
    icon: ICON_PATH,
    backgroundColor: "#0a0a0a",
    show: false,
    ...windowOptions(process.platform),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => window.show());
  applyContentProtection(window);
  window.on("page-title-updated", (event) => {
    // 页面里的 <title> 会把窗口标题覆盖成正式名称；开发版/构建版要保留标记。
    event.preventDefault();
    window.setTitle(APP_TITLE);
  });
  window.webContents.on("render-process-gone", () => { void stopNativeAudio(); });
  window.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) void stopNativeAudio();
  });
  window.on("closed", () => {
    void stopNativeAudio();
    if (mainWindow === window) mainWindow = null;
  });

  // Windows closes to tray; macOS closes the window and keeps the backend.
  window.on("close", (event) => {
    if (quitting || IS_MAC) return;
    event.preventDefault();
    window.hide();
  });

  const sendMaximized = (value) => {
    if (!window.isDestroyed()) window.webContents.send("window:maximized", value);
  };
  window.on("maximize", () => sendMaximized(true));
  window.on("unmaximize", () => sendMaximized(false));

  // 站外链接交给系统浏览器，别把桌面窗口导航走。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: "allow" };
    openExternalSafely(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });

  void window.loadURL(initialUrl).catch((error) => {
    if (!window.isDestroyed()) console.error("[window] 加载失败", error);
  });
  return window;
}

function showMainWindow() {
  if (quitting) return;
  if (!backend && !bootPromise) {
    bootPromise = boot().catch((error) => {
      if (!quitting) dialog.showErrorBox("桌面启动失败", String(error.message || error));
    }).finally(() => { bootPromise = null; });
  } else if (backend && !mainWindow) {
    mainWindow = createWindow(backend.url);
  }
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function backendExited(started, code, signal) {
  if (quitting || backend !== started) return;
  void stopNativeAudio();
  backend = null;
  retiredBackend = started;
  urlPolicy.setAppOrigin(null);
  if (mainWindow && !mainWindow.isDestroyed()) {
    void mainWindow.loadURL(LOADING_PAGE).catch((error) => console.error("[window]", error));
  }
  // Clean up descendants before any recovery can start a new process group.
  void started.stop().catch((error) => console.error("[backend] 异常退出清理失败", error));
  dialog.showErrorBox("本地服务已退出",
    `Python 后端异常退出（code=${code}, signal=${signal}）。请点击 Dock 或托盘的显示主窗口重试。`);
}

function quitApp() {
  quitting = true;
  app.quit();
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  // 兜底：托盘图标缺失时退回应用图标，避免托盘里出现一个空白占位。
  const trayImage = icon.isEmpty() ? nativeImage.createFromPath(ICON_PATH) : icon;
  const image = IS_MAC ? trayImage.resize({ width: 18, height: 18 }) : trayImage;
  if (IS_MAC) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(APP_TITLE);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主窗口", click: () => showMainWindow() },
      { type: "separator" },
      { label: "退出", click: () => quitApp() },
    ])
  );
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
}

function installWindowIpc() {
  const windowOf = (event) =>
    trustedSender(event, mainWindow, isAppOrigin) ? mainWindow : null;

  ipcMain.on("window:minimize", (event) => windowOf(event)?.minimize());
  ipcMain.on("window:toggle-maximize", (event) => {
    const window = windowOf(event);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on("window:close", (event) => windowOf(event)?.close());
  ipcMain.handle(
    "window:is-maximized",
    (event) => windowOf(event)?.isMaximized() ?? false
  );
  ipcMain.handle("privacy:get-content-protection", (event) =>
    Boolean(!IS_MAC && windowOf(event) && contentProtection));
  ipcMain.handle("privacy:set-content-protection", (event, enabled) => {
    // 只接受主窗口自己的请求；页面导航已被 URL 策略锁在本应用内。
    if (IS_MAC || !windowOf(event)) {
      return false;
    }
    contentProtection = Boolean(enabled);
    savePrivacySettings();
    applyContentProtection(mainWindow);
    return contentProtection;
  });
}

/**
 * 系统音频：浏览器版要用户手动选「整个屏幕 + 共享系统音频」，
 * 桌面端直接给第一块屏幕并附上环回音轨（Windows 上由 Electron 提供）。
 */
function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      // Phase 1 has no macOS system-audio implementation.
      if (IS_MAC) { callback({}); return; }
      // 只有本应用页面可以拿屏幕 + 系统环回音频，站外页面一律拒绝。
      if (!isAppOrigin(request.securityOrigin)) {
        callback({});
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (!sources.length) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: "loopback" });
      } catch (error) {
        console.error("[display-media] 取屏幕源失败", error);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

function installPermissionHandlers() {
  // 权限只给本应用 Origin；请求页的 securityOrigin / requestingUrl 是
  // Electron 解析后的真实来源，不能再靠 webContents 当前 URL 猜。
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const securityOrigin = details?.securityOrigin;
      const requestingUrl = details?.requestingUrl;
      const origin =
        securityOrigin ||
        (requestingUrl ? normalizeOrigin(requestingUrl) : null) ||
        normalizeOrigin(webContents?.getURL() || "");
      callback(isAppOrigin(origin) && ALLOWED_PERMISSIONS.has(permission));
    }
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) => {
      const origin =
        requestingOrigin || normalizeOrigin(details?.requestingUrl || "") ||
        normalizeOrigin(webContents?.getURL() || "");
      return isAppOrigin(origin) && ALLOWED_PERMISSIONS.has(permission);
    }
  );
  // 本项目不用 HID / 串口 / USB；一律拒绝（麦克风和摄像头不走这个处理器）。
  session.defaultSession.setDevicePermissionHandler(() => false);
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(
    menuTemplate(process.platform, APP_TITLE, quitApp)
  ));
}

function backendLogPath() {
  try {
    const dir = app.getPath("userData");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "backend.log");
  } catch {
    return null;
  }
}

/**
 * 防截屏/防录屏：Windows 上用 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
 * 把窗口从系统级画面采集里排除。macOS Phase 1 不启用此功能；
 * NSWindowSharingNone 不能可靠阻止 ScreenCaptureKit 采集。
 * 设置按开发版/构建版/安装版各自的 userData 分别保存。
 */
let contentProtection = false;

function privacyPath() {
  return path.join(app.getPath("userData"), "privacy.json");
}

function loadPrivacySettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(privacyPath(), "utf8"));
    contentProtection = Boolean(parsed?.contentProtection);
  } catch {
    contentProtection = false;
  }
}

function savePrivacySettings() {
  try {
    const file = privacyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ contentProtection }, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("[privacy] 保存防截屏设置失败", error);
  }
}

function applyContentProtection(window) {
  if (IS_MAC || !window || window.isDestroyed()) return;
  try {
    window.setContentProtection(contentProtection);
    console.log(`[privacy] contentProtection=${contentProtection}`);
  } catch (error) {
    console.error("[privacy] 应用防截屏设置失败", error);
  }
}

function openLog() {
  const logPath = backendLogPath();
  if (!logPath) return null;
  try {
    return fs.createWriteStream(logPath, { flags: "w" });
  } catch {
    return null;
  }
}

/** 安装包里的后端与数据目录；开发模式下返回空对象，走项目本身的 .venv 和 config/。 */
function packagedBackendOptions() {
  if (!app.isPackaged) return {};
  const base = path.join(process.resourcesPath, "backend");
  // 开发环境用仓库里的 config/；安装版必须写 userData，安装目录是只读的。
  // 两者用独立目录，互不覆盖。
  const dataDir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    python: path.join(
      base,
      "python",
      process.platform === "win32" ? "python.exe" : "python3"
    ),
    script: path.join(base, "server.py"),
    // 配置、档案、问答库、历史、模型缓存都放 userData（Python 通过这个变量定位）。
    cwd: dataDir,
    env: { INTERVIEW_DATA_DIR: dataDir },
  };
}

/** 前端没构建过就别拉后端了，直接给一句人话。 */
function missingFrontend() {
  const dist = app.isPackaged
    ? path.join(process.resourcesPath, "backend", "web", "client", "dist", "index.html")
    : path.join(ROOT, "web", "client", "dist", "index.html");
  if (fs.existsSync(dist)) return false;
  dialog.showErrorBox(
    "前端还没构建",
    "找不到 web/client/dist/index.html。\n\n先在项目根目录执行：\nnpm --prefix web/client run build\n然后再启动桌面端。"
  );
  return true;
}

async function boot() {
  if (quitting) return;
  if (missingFrontend()) {
    app.quit();
    return;
  }

  const log = openLog();
  const onLog = (line) => {
    console.log(line);
    log?.write(`${new Date().toISOString()} ${line}\n`);
  };

  if (!mainWindow) mainWindow = createWindow();

  try {
    if (retiredBackend) {
      await retiredBackend.stop();
      retiredBackend = null;
    }
    if (quitting) return;
    const packaged = packagedBackendOptions();
    backend = await startBackend({
      onLog,
      signal: startupAbort.signal,
      // 开发端 7870、构建产物 7871，安装版仍从 7860 起找空闲端口。
      port: !app.isPackaged ? DEV_PORT : BUILD_TREE_RUN ? BUILD_PORT : undefined,
      ...packaged,
      env: {
        ...(packaged.env || {}),
        // Keep source-run macOS data outside the checkout; respect an explicit test directory.
        ...(!app.isPackaged && IS_MAC ? {
          INTERVIEW_DATA_DIR: process.env.INTERVIEW_DATA_DIR ||
            path.join(app.getPath("userData"), "data"),
        } : {}),
        INTERVIEW_CHANNEL: DEV_CHANNEL ? "dev" : "production",
      },
    });
  } catch (error) {
    log?.end();
    if (quitting) return;
    const logPath = backendLogPath();
    dialog.showErrorBox(
      "本地服务没能启动",
      [
        String(error?.message ?? error),
        logPath ? `\n完整日志：${logPath}` : "",
        `\n项目目录：${ROOT}`,
        "确认 .venv 里的 Python 依赖齐全（pip install -r requirements.txt）。",
      ].join("\n")
    );
    quitting = true;
    app.quit();
    return;
  }

  const started = backend;
  started.child.once("exit", (code, signal) => backendExited(started, code, signal));
  started.child.once("close", () => log?.end());
  if (started.child.exitCode != null || started.child.signalCode != null) {
    backendExited(started, started.child.exitCode, started.child.signalCode);
    return;
  }
  if (quitting) return;
  console.log(`[electron] 后端已就绪：${backend.url}`);
  urlPolicy.setAppOrigin(backend.url);
  if (mainWindow && !mainWindow.isDestroyed()) {
    const window = mainWindow;
    await window.loadURL(started.url);
    if (IS_DEV && !window.isDestroyed()) window.webContents.openDevTools({ mode: "detach" });
  }

}

if (process.platform === "win32") app.setAppUserModelId(
  DEV_CHANNEL ? "com.fuckinterview.desktop.dev" : "com.fuckinterview.desktop"
);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  app.whenReady().then(() => {
    migrateLegacyUserData();
    loadPrivacySettings();
    installPermissionHandlers();
    installDisplayMediaHandler();
    installWindowIpc();
    installNativeAudio({ ipcMain, getWindow: () => mainWindow, isAppOrigin, capture: nativeAudio, enabled: IS_MAC && !app.isPackaged });
    installDesktopServices({ ipcMain, dialog, systemPreferences,
      platform: process.platform, getWindow: () => mainWindow, isAppOrigin });
    installMenu();
    createTray();
    showMainWindow();

    app.on("activate", () => showMainWindow());
  });

  app.on("window-all-closed", () => {
    // Keep the app/backend alive after a Mac window closes or Windows hides to tray.
    if (quitting) app.quit();
  });

  app.on("before-quit", (event) => {
    quitting = true;
    if (cleanedUp) return;
    event.preventDefault();
    // 就算后端还没走到「就绪」，也要把已经拉起的进程收掉。
    startupAbort.abort();
    Promise.resolve(bootPromise).then(async () => {
      await nativeAudio.stop();
      await retiredBackend?.stop();
      retiredBackend = null;
      await stopAll();
    }).then(() => {
      cleanedUp = true;
      backend = null;
      app.quit();
    }).catch((error) => {
      console.error("[app] 后端退出失败", error);
      dialog.showErrorBox("后端退出失败", "请检查 backend.log 并确认 Python 进程已停止后退出。");
      quitting = false;
    });
  });
}
