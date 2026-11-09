"use strict";

const { spawn } = require("node:child_process");

// Test-only helper, outside electron/**/* so it is not shipped in the app.
function waitForTreeReady(child, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const collectOut = (chunk) => { stdout = (stdout + chunk.toString()).slice(-2048); };
    const collectErr = (chunk) => { stderr = (stderr + chunk.toString()).slice(-2048); };
    const fail = (reason) => finish(new Error(
      `${reason}; fixturePid=${child.pid}, exitCode=${child.exitCode}, signal=${child.signalCode}` +
      `; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`));
    const onError = (error) => fail(`Fixture spawn failed: ${error.code || error.message}`);
    const onExit = (code, signal) => fail(`Fixture exited before readiness (${code}, ${signal})`);
    const onDisconnect = () => fail("Fixture IPC disconnected before readiness");
    const onMessage = (message) => {
      if (message?.type === "fixture-error") return fail(`Fixture error: ${message.error}`);
      if (message?.type !== "process-tree-ready/v1" || message.pid !== child.pid ||
          !Number.isSafeInteger(message.descendantPid) || message.descendantPid <= 0 ||
          message.descendantPid === child.pid) return fail("Invalid fixture readiness message");
      finish(null, message.descendantPid);
    };
    const timer = setTimeout(() => fail("Fixture readiness timed out"), timeoutMs);
    function finish(error, pid) {
      clearTimeout(timer);
      child.off("error", onError); child.off("exit", onExit);
      child.off("disconnect", onDisconnect); child.off("message", onMessage);
      child.stdout?.off("data", collectOut); child.stderr?.off("data", collectErr);
      if (error) reject(error); else resolve(pid);
    }
    child.stdout?.on("data", collectOut); child.stderr?.on("data", collectErr);
    child.once("error", onError); child.once("exit", onExit);
    child.once("disconnect", onDisconnect); child.on("message", onMessage);
    if (child.exitCode != null || child.signalCode != null) onExit(child.exitCode, child.signalCode);
  });
}

function runTree() {
  const descendant = spawn(process.execPath, [__filename, "leaf"],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let ready = false;
  let errors = "";
  descendant.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-2048); });
  const timer = setTimeout(() => report("Descendant readiness timed out"), 8000);
  function report(error) {
    clearTimeout(timer);
    process.send?.({ type: "fixture-error", error: `${error}; descendantStderr=${errors}` });
    descendant.kill("SIGTERM");
  }
  // The parent survives the group TERM until it has reaped its descendant.
  process.on("SIGTERM", () => {});
  descendant.once("error", (error) => report(`Descendant spawn failed: ${error.code}`));
  descendant.once("exit", (code, signal) => {
    clearTimeout(timer);
    if (!ready) report(`Descendant exited before readiness (${code}, ${signal})`);
    process.exit(ready ? 0 : 1);
  });
  descendant.on("message", (message) => {
    if (ready) return;
    if (message?.type !== "leaf-ready" || message.pid !== descendant.pid) {
      report("Invalid descendant readiness"); return;
    }
    ready = true;
    clearTimeout(timer);
    process.send?.({ type: "process-tree-ready/v1", pid: process.pid, descendantPid: descendant.pid });
  });
}

if (require.main === module) {
  if (process.argv[2] === "leaf") {
    setInterval(() => {}, 1000);
    process.send?.({ type: "leaf-ready", pid: process.pid });
  } else {
    runTree();
  }
}

module.exports = { waitForTreeReady };
