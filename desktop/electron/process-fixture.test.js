"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { waitForTreeReady } = require("../test-support/process-tree-fixture");

function fixture() {
  return Object.assign(new EventEmitter(), { pid: 100, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough() });
}

test("PID handshake ignores banners, blank lines and split stdout chunks", async () => {
  const child = fixture();
  let resolved = false;
  const ready = waitForTreeReady(child).then((pid) => { resolved = true; return pid; });
  for (const text of ["startup banner\n", "\n", "12", "345\n"]) child.stdout.write(text);
  await new Promise(setImmediate);
  assert.equal(resolved, false);
  child.emit("message", { type: "process-tree-ready/v1", pid: 100, descendantPid: 12345 });
  assert.equal(await ready, 12345);
  assert.equal(child.listenerCount("message"), 0);
});

test("invalid or unrelated IPC PID is rejected with captured diagnostics", async () => {
  for (const message of [
    { type: "process-tree-ready/v1", pid: 101, descendantPid: 200 },
    { type: "process-tree-ready/v1", pid: 100, descendantPid: "200" },
    { type: "process-tree-ready/v1", pid: 100, descendantPid: 100 },
    { type: "process-tree-ready/v1", pid: 100, descendantPid: 0 },
  ]) {
    const child = fixture(); const ready = waitForTreeReady(child);
    child.stdout.write("unexpected output"); child.stderr.write("diagnostic");
    child.emit("message", message);
    await assert.rejects(ready, /Invalid fixture readiness.*stdout=.*unexpected output.*stderr=.*diagnostic/);
  }
});

test("early exit and spawn error are reported instead of waiting forever", async () => {
  for (const event of ["exit", "error", "disconnect"]) {
    const child = fixture(); const ready = waitForTreeReady(child);
    if (event === "error") child.emit(event, Object.assign(new Error("missing executable"), { code: "ENOENT" }));
    else child.emit(event, 1, null);
    await assert.rejects(ready, /Fixture (exited|spawn failed|IPC disconnected)/);
    assert.equal(child.listenerCount("message"), 0);
  }
});

test("readiness timeout includes bounded stdout/stderr and removes listeners", async () => {
  const child = fixture(); const ready = waitForTreeReady(child, { timeoutMs: 10 });
  child.stdout.write("x".repeat(8000)); child.stderr.write("y".repeat(8000));
  await assert.rejects(ready, (error) => {
    assert.match(error.message, /timed out.*fixturePid=100/);
    assert.ok(error.message.length < 4500);
    return true;
  });
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
});
