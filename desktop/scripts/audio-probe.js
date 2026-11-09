"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { PacketReader, PCMVerifier } = require("./audio-probe-protocol");

function options(args) {
  const result = { duration: 10, cycles: 2, minRms: 0.001, requireSignal: false, request: false, permissionsOnly: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--request-permission": result.request = true; break;
      case "--permissions": result.permissionsOnly = true; break;
      case "--require-signal": result.requireSignal = true; break;
      case "--duration": case "--cycles": case "--min-rms": {
        const key = args[i++]; const value = Number(args[i]);
        if (!Number.isFinite(value)) throw new Error(`Invalid ${key}`);
        result[key === "--duration" ? "duration" : key === "--cycles" ? "cycles" : "minRms"] = value;
        break;
      }
      default: throw new Error("Unknown probe option");
    }
  }
  if (result.duration < 1 || result.duration > 60 || !Number.isInteger(result.cycles) || result.cycles < 1 || result.cycles > 20) throw new Error("duration must be 1..60 and cycles 1..20");
  return result;
}

async function run(args) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Native audio probe requires an ARM64 macOS host");
  const opts = options(args);
  const executable = path.resolve(__dirname, "../native/macos-audio/build/SystemAudioProbe.app/Contents/MacOS/SystemAudioProbe");
  if (!fs.existsSync(executable)) throw new Error("Build first: bash desktop/scripts/build-audio-probe.sh");
  const nativeArgs = ["--pcm", "--duration", String(opts.duration), "--cycles", String(opts.cycles)];
  if (opts.request) nativeArgs.push("--request-permission");
  if (opts.permissionsOnly) nativeArgs.push("--permissions");
  const verifier = new PCMVerifier({ minRms: opts.minRms });
  const reader = new PacketReader((header, pcm) => verifier.consume(header, pcm));
  const child = spawn(executable, nativeArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let error, stderr = "", cancelled = false, forceTimer;
  const stop = () => {
    if (forceTimer) return;
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 4000);
  };
  const cancel = () => { cancelled = true; stop(); };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const timer = setTimeout(() => { error ||= new Error("Native audio probe timed out"); stop(); }, (opts.duration * opts.cycles + 30) * 1000);
  child.stdout.on("data", (chunk) => {
    if (error) return;
    try { reader.write(chunk); }
    catch (failure) { error = failure; stop(); }
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-2048); });
  child.once("error", (failure) => { error = failure; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timer); clearTimeout(forceTimer);
  process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
  if (cancelled) { console.log(JSON.stringify({ cancelled: true })); process.exitCode = 130; return; }
  if (error || code !== 0) throw new Error(`${error?.message || `Native probe exited ${code}`}${stderr ? `; diagnostic=${stderr}` : ""}`);
  reader.end();
  console.log(JSON.stringify(verifier.finish({ cycles: opts.cycles, requireSignal: opts.requireSignal, permissionsOnly: opts.permissionsOnly }), null, 2));
}

if (require.main === module) run(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { options };
