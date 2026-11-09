"use strict";

const { spawn } = require("node:child_process");

/** Only signal a process group created by our own detached spawn. */
function createStopper(child, { platform = process.platform, grouped = false,
  kill = process.kill.bind(process), spawnTask = spawn, graceMs = 3000,
  forceMs = 1000, pollMs = 50 } = {}) {
  let stopping;
  return () => stopping ||= (async () => {
    if (!child?.pid) return;
    const alive = () => {
      if (!grouped) return child.exitCode === null && child.signalCode === null;
      try { kill(-child.pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    };
    const signal = (name) => {
      try {
        if (grouped) kill(-child.pid, name);
        else child.kill(name);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const waitUntilGone = async (timeout) => {
      const deadline = Date.now() + timeout;
      while (alive() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return !alive();
    };
    if (!alive()) return;
    if (platform === "win32") {
      // Keep Windows process-tree termination, including workers.
      await new Promise((resolve, reject) => {
        const task = spawnTask("taskkill", ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" });
        const timer = setTimeout(() => { task.kill(); reject(new Error("taskkill timed out")); }, graceMs);
        task.once("error", (error) => { clearTimeout(timer); reject(error); });
        task.once("exit", (code) => {
          clearTimeout(timer);
          if (code && alive()) reject(new Error(`taskkill failed (${code})`));
          else resolve();
        });
      });
    } else {
      signal("SIGTERM");
      if (await waitUntilGone(graceMs)) return;
      signal("SIGKILL");
    }
    if (!await waitUntilGone(forceMs)) throw new Error("Backend process did not exit");
  })().catch((error) => { stopping = null; throw error; });
}

module.exports = { createStopper };
