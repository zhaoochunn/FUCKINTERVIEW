"use strict";

/**
 * 本地 Python 服务的生命周期：拉起 server.py、等它准备好、退出时收干净。
 *
 * 端口默认 7860（和浏览器版一致），被占用时自动找一个空闲端口，
 * 前端拿到的是同一个 origin，所以 /api、/start 这些相对路径都不用改。
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { createStopper } = require("./process-lifecycle");

const HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 300;

/** 项目根目录：desktop/electron/ 往上两层。 */
const ROOT = path.resolve(__dirname, "..", "..");

function isWindows() {
  return process.platform === "win32";
}

/** 优先用项目自己的虚拟环境，找不到再退回 PATH 里的 python；可用 INTERVIEW_PYTHON 覆盖。 */
function resolvePython() {
  if (process.env.INTERVIEW_PYTHON) return process.env.INTERVIEW_PYTHON;
  const venv = path.join(
    ROOT,
    ".venv",
    isWindows() ? "Scripts" : "bin",
    isWindows() ? "python.exe" : "python"
  );
  return fs.existsSync(venv) ? venv : isWindows() ? "python" : "python3";
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, HOST);
  });
}

async function pickPort(preferred) {
  const start = Number(preferred) || 7860;
  for (let port = start; port < start + 20; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`端口 ${start}–${start + 19} 都被占用了`);
}

async function isReady(port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === "ready";
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 最近一次拉起的后端进程，退出时兜底收掉（包括启动到一半就退出的情况）。 */
let currentChild = null;
const stoppers = new WeakMap();

/**
 * 启动后端。
 *
 * @param {object} options
 * @param {number} [options.port] 期望端口
 * @param {(line: string) => void} [options.onLog] 每行输出
 * @param {string} [options.python] 指定解释器（安装包用 resources 里的便携 Python）
 * @param {string} [options.script] 指定 server.py 路径
 * @param {string} [options.cwd] 工作目录（数据目录；配置和数据库都写在这里）
 * @param {Record<string, string>} [options.env] 追加给 Python 进程的环境变量
 * @returns {Promise<{port: number, url: string, child: import("node:child_process").ChildProcess, stop: () => Promise<void>}>}
 */
async function startBackend({ port, onLog, python, script, cwd, env, signal } = {}) {
  signal?.throwIfAborted();
  const preferred = port ?? process.env.INTERVIEW_PORT ?? 7860;
  const chosen = await pickPort(preferred);
  signal?.throwIfAborted();
  const interpreter = python || resolvePython();
  const serverScript = script || path.join(ROOT, "server.py");
  const workdir = cwd || ROOT;
  fs.mkdirSync(workdir, { recursive: true });

  const child = spawn(
    interpreter,
    [
      "-u",
      serverScript,
      "--host",
      HOST,
      "--port",
      String(chosen),
      // 只启用 SmallWebRTC，少注册一堆用不到的传输路由，启动更快。
      "--transport",
      "webrtc",
    ],
    {
      cwd: workdir,
      env: {
        ...process.env,
        ...(env || {}),
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
      },
      windowsHide: true,
      // Own an isolated POSIX group so shutdown also reaches descendants.
      detached: !isWindows(),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  currentChild = child;
  stoppers.set(child, createStopper(child, { grouped: !isWindows() }));

  const tail = [];
  const push = (chunk, stream) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > 40) tail.shift();
      onLog?.(`[${stream}] ${line}`);
    }
  };
  child.stdout.on("data", (chunk) => push(chunk, "py"));
  child.stderr.on("data", (chunk) => push(chunk, "py!"));

  let exited = null;
  let spawnError = null;
  child.once("error", (error) => { spawnError = error; });
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      await stopBackend(child);
      signal.throwIfAborted();
    }
    if (spawnError) {
      if (currentChild === child) currentChild = null;
      throw new Error(`无法启动 Python (${interpreter}): ${spawnError.message}`);
    }
    if (exited) {
      await stopBackend(child);
      throw new Error(
        `后端进程退出了（code=${exited.code}）\n${tail.slice(-12).join("\n")}`
      );
    }
    if (await isReady(chosen)) {
      if (signal?.aborted) {
        await stopBackend(child);
        signal.throwIfAborted();
      }
      return {
        port: chosen,
        url: `http://${HOST}:${chosen}/client/`,
        child,
        stop: () => stopBackend(child),
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  await stopBackend(child);
  throw new Error(
    `等了 ${READY_TIMEOUT_MS / 1000}s 后端还没就绪\n${tail.slice(-12).join("\n")}`
  );
}

/** 结束 Python 及其子进程（Windows 上单独 kill 会留下 worker）。 */
async function stopBackend(child) {
  if (!child) return;
  await stoppers.get(child)?.();
  if (currentChild === child) currentChild = null;
}

/** 退出时兜底：不管后端有没有走到「就绪」，把它收掉。 */
function stopAll() {
  return currentChild ? stopBackend(currentChild) : Promise.resolve();
}

module.exports = { startBackend, stopBackend, stopAll, ROOT, HOST };
