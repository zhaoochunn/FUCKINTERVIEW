"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { startBackend, stopAll, ROOT } = require("./backend");

const venvPython = path.join(ROOT, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.INTERVIEW_PYTHON || (fs.existsSync(venvPython) ? venvPython : process.platform === "win32" ? "python" : "python3");

test("backend starts in a Unicode/spaced directory, serves readiness and stops", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interview 测试 "));
  const script = path.join(dir, "test server.py");
  fs.writeFileSync(script, `import sys\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200)\n  self.end_headers()\n  self.wfile.write(b'{"status":"ready"}')\nHTTPServer(('127.0.0.1', int(sys.argv[sys.argv.index('--port')+1])), Handler).serve_forever()\n`);
  let backend;
  try {
    backend = await startBackend({ python, script, cwd: dir, port: 18970 });
    assert.equal((await fetch(backend.url.replace("/client/", "/status"))).status, 200);
    await backend.stop();
    await backend.stop();
    assert.ok(backend.child.exitCode !== null || backend.child.signalCode !== null);
  } finally {
    await stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing Python becomes an actionable startup error", async () => {
  await assert.rejects(startBackend({ python: path.join(os.tmpdir(), "missing-interview-python"), port: 18990 }), /无法启动 Python/);
});

test("quit while backend is starting aborts and cleans the process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interview-abort-"));
  const script = path.join(dir, "slow.py");
  fs.writeFileSync(script, "import time\ntime.sleep(120)\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(startBackend({ python, script, cwd: dir, port: 19010,
      signal: controller.signal }), { name: "AbortError" });
    await stopAll();
  } finally {
    clearTimeout(timer);
    await stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
