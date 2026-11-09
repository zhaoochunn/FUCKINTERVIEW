"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { installDesktopServices } = require("./desktop-services");

function setup(platform = "darwin") {
  const handlers = new Map();
  const mainFrame = { url: "http://127.0.0.1:7870/client/" };
  const window = { isDestroyed: () => false, webContents: { mainFrame } };
  const event = { sender: window.webContents, senderFrame: mainFrame };
  const calls = [];
  const dialog = { showOpenDialog: async (...args) => {
    calls.push(args); return { canceled: false, filePaths: [path.resolve("测试 空格")] };
  } };
  const requests = [];
  installDesktopServices({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog,
    systemPreferences: { getMediaAccessStatus: () => "denied",
      askForMediaAccess: async (kind) => { requests.push(kind); return false; } },
    platform, getWindow: () => window,
    isAppOrigin: (url) => new URL(url).origin === "http://127.0.0.1:7870",
  });
  return { handlers, event, calls, dialog, requests, window };
}

test("native directory picker preserves paths and cancellation", async () => {
  const { handlers, event, calls, dialog } = setup();
  const pick = handlers.get("storage:pick-directory");
  const initial = path.resolve("目录 空格");
  assert.equal(await pick(event, initial), path.resolve("测试 空格"));
  assert.equal(calls[0][1].defaultPath, initial);
  assert.ok(calls[0][1].properties.includes("openDirectory"));
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.equal(await pick(event, ""), "");
});

test("IPC rejects remote, subframe, foreign and malformed directory requests", () => {
  const { handlers, event } = setup();
  for (const name of handlers.keys()) {
    const handler = handlers.get(name);
    assert.throws(() => handler({ ...event, sender: {} }, ""), /Untrusted/);
    assert.throws(() => handler({ ...event, senderFrame: { url: event.senderFrame.url } }, ""), /Untrusted/);
    const original = event.senderFrame.url;
    event.senderFrame.url = "https://example.com";
    assert.throws(() => handler(event, ""), /Untrusted/);
    event.senderFrame.url = original;
  }
});

test("invalid paths, overlapping dialogs and dialog errors cannot bypass validation", async () => {
  const { handlers, event, dialog } = setup();
  const pick = handlers.get("storage:pick-directory");
  await assert.rejects(pick(event, { path: "/tmp" }), /Invalid/);
  await assert.rejects(pick(event, "a\0b"), /Invalid/);
  let finish;
  dialog.showOpenDialog = () => new Promise((resolve) => { finish = resolve; });
  const pending = pick(event, "relative");
  await assert.rejects(pick(event, ""), /already open/);
  finish({ canceled: true, filePaths: [] });
  await pending;
  dialog.showOpenDialog = async () => { throw new Error("dialog failed"); };
  await assert.rejects(pick(event, ""), /dialog failed/);
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  assert.equal(await pick(event, ""), "");
});

test("only explicit microphone request invokes TCC; Windows does not invoke macOS API", async () => {
  for (const platform of ["darwin", "win32"]) {
    const { handlers, event, requests } = setup(platform);
    handlers.get("permissions:status")(event);
    assert.deepEqual(requests, []);
    assert.equal(await handlers.get("permissions:request-microphone")(event), false);
    assert.deepEqual(requests, platform === "darwin" ? ["microphone"] : []);
  }
});
