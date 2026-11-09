"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// Run the real main entry against an Electron double. This validates wiring,
// not native AppKit/TCC behavior, which still needs the M5 acceptance checklist.
async function launch(platform, { slow = false, recoverySlow = false } = {}) {
  const windows = [], handles = new Map(), state = { starts: 0, stops: 0, captures: 0, errors: [], children: [], retiredStops: 0 };
  const paths = { appData: "/user/appData", userData: "/user/data" };
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, getPath: (name) => paths[name],
    setPath: (name, value) => { paths[name] = value; },
    setAppUserModelId: () => { state.modelId = true; },
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    quit() { const e = { preventDefault() { this.prevented = true; } };
      app.emit("before-quit", e); if (!e.prevented) state.exited = true; },
  });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "" }, setWindowOpenHandler() {}, send() {}, openDevTools() {},
      });
      windows.push(this);
    }
    isDestroyed() { return Boolean(this.destroyed); }
    setContentProtection(value) { this.protected = value; }
    setTitle() {} show() { this.shown = true; } hide() { this.hidden = true; }
    isMinimized() { return false; } focus() {} isMaximized() { return false; }
    async loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; }
    close() {
      const e = { preventDefault() { this.prevented = true; } };
      this.emit("close", e);
      if (!e.prevented) { this.destroyed = true; this.emit("closed"); app.emit("window-all-closed"); }
    }
  }
  const image = { isEmpty: () => false, resize() { return this; },
    setTemplateImage(value) { state.template = value; } };
  class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} }
  const session = { setDisplayMediaRequestHandler(handler) { state.display = handler; },
    setPermissionRequestHandler(handler) { state.permission = handler; },
    setPermissionCheckHandler() {}, setDevicePermissionHandler() {} };
  const electron = {
    app, BrowserWindow: Window, Tray,
    Menu: { buildFromTemplate: (value) => value, setApplicationMenu: (menu) => { state.menu = menu; } },
    dialog: { showErrorBox: (...args) => state.errors.push(args), showOpenDialog: async () => ({ canceled: true }) },
    desktopCapturer: { getSources: async () => { state.captures++; return [{ id: "screen:0" }]; } },
    ipcMain: { on() {}, handle: (name, handler) => handles.set(name, handler) },
    nativeImage: { createFromPath: () => image }, session: { defaultSession: session },
    shell: {}, systemPreferences: { getMediaAccessStatus: () => "denied" },
  };
  const backend = {
    ROOT: "/repo", stopAll: async () => { state.stops++; },
    startBackend: async (opts) => {
      state.starts++; state.backendOptions = opts;
      if (slow) await new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      if (recoverySlow && state.starts > 1) await new Promise((resolve, reject) => {
        state.finishRecovery = resolve;
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
      state.children.push(child);
      return { url: `http://127.0.0.1:${7869 + state.starts}/client/`, child,
        stop: async () => { state.retiredStops++; } };
    },
  };
  const fakeFs = { existsSync: () => true, mkdirSync() {}, readFileSync: () => '{"contentProtection":true}',
    createWriteStream: () => ({ write() {}, end() {} }) };
  const context = vm.createContext({
    require(name) {
      if (name === "electron") return electron;
      if (name === "node:fs") return fakeFs;
      if (name === "./backend") return backend;
      return name.startsWith(".") ? require(path.join(__dirname, name)) : require(name);
    }, __dirname, console: { log() {}, error() {} }, AbortController,
    process: { platform, argv: [], execPath: "/runtime/electron", env: {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "main.js"), "utf8"), context);
  const flush = () => new Promise(setImmediate);
  await flush();
  return { app, state, windows, handles, flush };
}

test("macOS closes/reopens a native window without spawning a second backend, then Cmd+Q stops it", async () => {
  const { app, state, windows, handles, flush } = await launch("darwin");
  assert.equal(windows[0].options.frame, true);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  assert.equal(state.template, true);
  assert.equal(state.backendOptions.env.INTERVIEW_DATA_DIR, path.join("/user/appData", "interview-desktop-dev", "data"));
  assert.equal(windows[0].protected, undefined);
  const w = windows[0];
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  assert.equal(handles.get("privacy:get-content-protection")(event), false);
  let capture;
  await state.display({ securityOrigin: "http://127.0.0.1:7870" }, (value) => { capture = value; });
  assert.equal(Object.keys(capture).length, 0);
  assert.equal(state.captures, 0);
  w.close();
  assert.equal(w.destroyed, true);
  assert.equal(state.stops, 0);
  app.emit("activate");
  await flush();
  assert.equal(windows.length, 2);
  assert.equal(state.starts, 1);
  assert.equal(windows[1].url, "http://127.0.0.1:7870/client/");
  state.menu[0].submenu.find((item) => item.accelerator === "Command+Q").click();
  await flush();
  assert.equal(state.stops, 1);
  assert.equal(state.exited, true);
  assert.equal(state.errors.length, 0);
});

test("Windows retains close-to-tray, loopback and content protection", async () => {
  const { state, windows, flush } = await launch("win32");
  assert.equal(windows[0].options.frame, false);
  assert.equal(windows[0].protected, true);
  assert.equal(state.modelId, true);
  assert.equal(state.backendOptions.env.INTERVIEW_DATA_DIR, undefined);
  let capture;
  await state.display({ securityOrigin: "http://127.0.0.1:7870" }, (value) => { capture = value; });
  assert.equal(capture.audio, "loopback");
  windows[0].close();
  assert.equal(windows[0].hidden, true);
  assert.equal(windows[0].destroyed, undefined);
  state.menu[0].submenu[0].click();
  await flush();
  assert.equal(state.exited, true);
});

test("quitting during startup aborts without an error dialog or second launch", async () => {
  const { state, app, flush } = await launch("darwin", { slow: true });
  app.emit("activate");
  assert.equal(state.starts, 1);
  app.quit();
  await flush();
  assert.equal(state.backendOptions.signal.aborted, true);
  assert.equal(state.exited, true);
  assert.equal(state.errors.length, 0);
});

for (const closed of [false, true]) {
  test(`backend crash recovers once with window ${closed ? "closed" : "open"}`, async () => {
    const { state, app, windows, flush } = await launch("darwin", { recoverySlow: true });
    const old = state.children[0];
    if (closed) windows[0].close();
    old.exitCode = 1;
    old.emit("exit", 1, null);
    old.emit("close", 1, null);
    await flush();
    assert.equal(state.errors.length, 1);
    assert.ok(state.retiredStops >= 1);
    app.emit("activate"); app.emit("activate"); app.emit("second-instance");
    await flush();
    assert.equal(state.starts, 2);
    state.finishRecovery();
    await flush();
    assert.equal(windows.at(-1).url, "http://127.0.0.1:7871/client/");
    assert.equal(windows.filter((window) => !window.isDestroyed()).length, 1);
    old.emit("exit", 1, null);
    assert.equal(state.errors.length, 1);
    app.quit(); await flush();
    assert.equal(state.exited, true);
    assert.equal(state.starts, 2);
  });
}

test("quit while recovering does not relaunch or show a second failure dialog", async () => {
  const { state, app, flush } = await launch("darwin", { recoverySlow: true });
  state.children[0].exitCode = 1;
  state.children[0].emit("exit", 1, null);
  app.emit("activate"); await flush();
  assert.equal(state.starts, 2);
  app.quit(); await flush();
  assert.equal(state.exited, true);
  assert.equal(state.errors.length, 1);
  app.emit("activate"); await flush();
  assert.equal(state.starts, 2);
});
