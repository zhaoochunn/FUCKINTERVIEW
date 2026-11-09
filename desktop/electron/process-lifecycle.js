"use strict";

const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

// Darwin can return EPERM for a group containing only zombies. A failed
// permission probe is not evidence that the group is dead (or still live).
async function readProcessGroup(pgid) {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,pgid=,uid=,stat="],
    { timeout: 2000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
  return parseProcessGroup(stdout, pgid);
}

function parseProcessGroup(stdout, pgid) {
  const rows = stdout.trim().split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) throw new Error("Cannot determine process group state: invalid ps output");
    return { pid: Number(match[1]), pgid: Number(match[2]), uid: Number(match[3]), state: match[4] };
  });
  return rows.filter((row) => row.pgid === pgid);
}

/** Only signal a process group created by our own detached spawn. */
function createStopper(child, { platform = process.platform, grouped = false,
  kill = process.kill.bind(process), spawnTask = spawn, graceMs = 3000,
  forceMs = 1000, pollMs = 50, readGroup = readProcessGroup,
  uid = process.getuid?.() } = {}) {
  let stopping;
  return () => stopping ||= (async () => {
    if (!child?.pid) return;
    const leaderAlive = () => child.exitCode === null && child.signalCode === null;
    const alive = async () => {
      if (!grouped) return leaderAlive();
      try { kill(-child.pid, 0); return true; }
      catch (error) {
        if (error.code === "ESRCH") return false;
        if (error.code !== "EPERM") throw error;
        let members;
        try { members = await readGroup(child.pid); }
        catch (cause) { throw new Error("Cannot determine process group state after EPERM", { cause }); }
        if (members.some((row) => row.uid !== uid)) throw error;
        return members.some((row) => !row.state.startsWith("Z"));
      }
    };
    const signal = (name) => {
      try {
        if (grouped) kill(-child.pid, name);
        else child.kill(name);
      } catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const waitUntilGone = async (timeout) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (!await alive() && !leaderAlive()) return true;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return !await alive() && !leaderAlive();
    };
    if (!await alive()) {
      if (!await waitUntilGone(forceMs)) throw new Error("Backend exit event not received");
      return;
    }
    if (platform === "win32") {
      // Keep Windows process-tree termination, including workers.
      await new Promise((resolve, reject) => {
        const task = spawnTask("taskkill", ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" });
        const timer = setTimeout(() => { task.kill(); reject(new Error("taskkill timed out")); }, graceMs);
        task.once("error", (error) => { clearTimeout(timer); reject(error); });
        task.once("exit", (code) => {
          clearTimeout(timer);
          if (code && leaderAlive()) reject(new Error(`taskkill failed (${code})`));
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

module.exports = { createStopper, parseProcessGroup };
