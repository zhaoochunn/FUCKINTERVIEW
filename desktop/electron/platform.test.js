"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { menuTemplate, windowOptions, permissionStatus } = require("./platform");

test("macOS has native window controls and Command+Q calls the managed quit path", () => {
  assert.equal(windowOptions("darwin").frame, true);
  let quits = 0;
  const menu = menuTemplate("darwin", "Test", () => quits++);
  const quit = menu[0].submenu.find((item) => item.accelerator === "Command+Q");
  quit.click();
  assert.equal(quits, 1);
  assert.ok(menu[0].submenu.some((item) => item.role === "hide"));
  assert.ok(menu.some((item) => item.role === "windowMenu"));
  assert.equal(menu[1].submenu[0].role, "close");
});

test("Windows retains frameless window and Ctrl+Q", () => {
  assert.equal(windowOptions("win32").frame, false);
  const menu = menuTemplate("win32", "Test", () => {});
  assert.equal(menu[0].label, "文件");
  assert.equal(menu[0].submenu[0].accelerator, "Ctrl+Q");
  assert.equal(menu.some((item) => item.role === "windowMenu"), false);
});

test("permission snapshots report TCC only and never request access", () => {
  const requested = [];
  const preferences = { getMediaAccessStatus(kind) {
    requested.push(kind);
    if (kind === "camera") throw new Error("not available");
    return kind === "microphone" ? "denied" : "granted";
  } };
  assert.deepEqual(permissionStatus("darwin", preferences), {
    microphone: "denied", camera: "unknown", screen: "granted", systemAudio: "not-implemented",
  });
  assert.deepEqual(requested, ["microphone", "camera", "screen"]);
  requested.length = 0;
  assert.equal(permissionStatus("win32", preferences).microphone, "unavailable");
  assert.deepEqual(requested, []);
});
