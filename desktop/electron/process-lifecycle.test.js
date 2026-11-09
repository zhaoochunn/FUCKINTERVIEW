"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { createStopper, parseProcessGroup } = require("./process-lifecycle");

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
  }, uid: 1, readGroup: async () => [{ uid: 2, state: "S" }] })(), /permission denied/);
});

test("Darwin EPERM with only zombies is confirmed using ps and child exit state", async () => {
  let reads = 0;
  await createStopper({ pid: 99, exitCode: 0, signalCode: null }, {
    grouped: true, uid: 1, kill(pid, signal) {
      assert.equal(signal, 0);
      throw Object.assign(new Error("probe denied"), { code: "EPERM" });
    }, readGroup: async () => { reads++; return [{ uid: 1, state: "Z+" }]; },
  })();
  assert.ok(reads > 0);
});

test("EPERM with a live owned descendant still terminates the group", async () => {
  const signals = [];
  let live = true;
  await createStopper({ pid: 99, exitCode: 0, signalCode: null }, {
    grouped: true, uid: 1, graceMs: 2, forceMs: 20, pollMs: 1,
    kill(pid, signal) {
      if (signal === 0) throw Object.assign(new Error(), { code: "EPERM" });
      signals.push(signal);
      if (signal === "SIGKILL") live = false;
    }, readGroup: async () => [{ uid: 1, state: live ? "S" : "Z" }],
  })();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("unreadable group state is an error, not successful termination", async () => {
  await assert.rejects(createStopper({ pid: 99 }, { grouped: true,
    kill() { throw Object.assign(new Error(), { code: "EPERM" }); },
    readGroup: async () => { throw new Error("ps failed"); },
  })(), /Cannot determine process group state/);
});

test("EPERM while sending TERM is never ignored", async () => {
  await assert.rejects(createStopper({ pid: 99 }, { grouped: true,
    kill(pid, signal) {
      if (signal) throw Object.assign(new Error("signal denied"), { code: "EPERM" });
    },
  })(), /signal denied/);
});

test("EPERM while sending KILL after the grace period remains a failure", async () => {
  await assert.rejects(createStopper({ pid: 99, exitCode: 0, signalCode: null }, {
    grouped: true, graceMs: 2, pollMs: 1,
    kill(pid, signal) {
      if (signal === "SIGKILL") throw Object.assign(new Error("KILL denied"), { code: "EPERM" });
    },
  })(), /KILL denied/);
});

test("group disappearance waits for the ChildProcess exit notification", async () => {
  const child = { pid: 99, exitCode: null, signalCode: null };
  const timer = setTimeout(() => { child.signalCode = "SIGTERM"; }, 10);
  try {
    await createStopper(child, { grouped: true, forceMs: 100, pollMs: 1,
      kill() { throw Object.assign(new Error(), { code: "ESRCH" }); },
    })();
    assert.equal(child.signalCode, "SIGTERM");
  } finally { clearTimeout(timer); }
});

test("ps parser preserves group members and rejects malformed/empty output", () => {
  assert.deepEqual(parseProcessGroup(" 1 1 0 Ss\n 10 10 501 S\n 11 10 501 Z+\n", 10), [
    { pid: 10, pgid: 10, uid: 501, state: "S" },
    { pid: 11, pgid: 10, uid: 501, state: "Z+" },
  ]);
  assert.throws(() => parseProcessGroup("", 10), /invalid ps output/);
  assert.throws(() => parseProcessGroup("ps: error", 10), /invalid ps output/);
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

test("POSIX shutdown reaches a real descendant and waits for its parent to reap it", {
  skip: process.platform === "win32" ? "POSIX process groups only" : false,
}, async () => {
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    process.on('SIGTERM', () => {});
    descendant.on('exit', () => process.exit(0));
    descendant.once('spawn', () => console.log(descendant.pid));
    setInterval(()=>{},1000);
  `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const stop = createStopper(child, { grouped: true });
  try {
    const pid = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (chunk) => resolve(Number(chunk.toString().trim())));
    });
    assert.ok(pid > 0);
    await stop();
    assert.equal(child.exitCode, 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await stop(); }
});
