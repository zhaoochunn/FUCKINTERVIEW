"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { createStopper } = require("./process-lifecycle");

test("POSIX sends TERM then KILL to its own group, even if leader has exited", async () => {
  const signals = [];
  let alive = true;
  const child = { pid: 123, exitCode: 0, signalCode: null };
  const stop = createStopper(child, { platform: "darwin", grouped: true,
    graceMs: 5, forceMs: 5, pollMs: 1, kill(pid, signal) {
      assert.equal(pid, -123);
      if (!alive) throw Object.assign(new Error(), { code: "ESRCH" });
      if (signal) signals.push(signal);
      if (signal === "SIGKILL") alive = false;
    } });
  await Promise.all([stop(), stop()]);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("graceful exit does not force kill and missing groups are harmless", async () => {
  let alive = true;
  const signals = [];
  const stop = createStopper({ pid: 12 }, { platform: "darwin", grouped: true,
    kill(pid, signal) {
      if (!alive) throw Object.assign(new Error(), { code: "ESRCH" });
      if (signal) { signals.push(signal); alive = false; }
    } });
  await stop();
  assert.deepEqual(signals, ["SIGTERM"]);
  await createStopper({ pid: 13 }, { grouped: true, kill() {
    throw Object.assign(new Error(), { code: "ESRCH" });
  } })();
});

test("Windows retains taskkill tree termination and reports spawn failure", async () => {
  const child = { pid: 45, exitCode: null, signalCode: null };
  await createStopper(child, { platform: "win32", spawnTask(command, args, opts) {
    assert.equal(command, "taskkill");
    assert.deepEqual(args, ["/pid", "45", "/T", "/F"]);
    assert.equal(opts.windowsHide, true);
    const task = new EventEmitter();
    queueMicrotask(() => { child.exitCode = 0; task.emit("exit", 0); });
    return task;
  } })();
  child.exitCode = null;
  await assert.rejects(createStopper(child, { platform: "win32", spawnTask() {
    const task = new EventEmitter();
    queueMicrotask(() => task.emit("error", new Error("no taskkill")));
    return task;
  } })(), /no taskkill/);
});

test("termination failures remain visible", async () => {
  await assert.rejects(createStopper({ pid: 99 }, { grouped: true, kill() {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  } })(), /permission denied/);
});

test("POSIX really terminates a child that ignores SIGTERM", {
  skip: process.platform === "win32" ? "POSIX process groups only" : false,
}, async () => {
  const child = spawn(process.execPath, ["-e",
    "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
  { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", resolve);
    });
    await createStopper(child, { grouped: true, graceMs: 20, forceMs: 1000, pollMs: 10 })();
    assert.equal(child.signalCode, "SIGKILL");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});
