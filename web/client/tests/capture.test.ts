import test from "node:test";
import assert from "node:assert/strict";
import { captureSystemAudio, CaptureError } from "../src/lib/capture.ts";

async function withMedia(platform: string | undefined, run: (state: {
  calls: number; stopped: number; source: object;
}) => Promise<void>) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const state = { calls: 0, stopped: 0, source: {} };
  const track = { readyState: "live", muted: false, stop() { state.stopped++; } };
  state.source = { getAudioTracks: () => [track], getVideoTracks: () => [], getTracks: () => [track] };
  Object.defineProperty(globalThis, "window", { configurable: true,
    value: platform ? { desktop: { platform } } : {} });
  Object.defineProperty(globalThis, "navigator", { configurable: true,
    value: { mediaDevices: { async getDisplayMedia() { state.calls++; return state.source; } } } });
  try { await run(state); }
  finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
}

test("macOS Phase 1 refuses system capture before asking for media", async () => {
  await withMedia("darwin", async (state) => {
    await assert.rejects(captureSystemAudio(), (error: unknown) =>
      error instanceof CaptureError && error.code === "unsupported");
    assert.equal(state.calls, 0);
  });
});

test("Windows and browser capture still use the existing media entry and dispose tracks", async () => {
  for (const platform of ["win32", undefined]) {
    await withMedia(platform, async (state) => {
      const capture = await captureSystemAudio();
      assert.equal(state.calls, 1);
      assert.equal(capture.stream, state.source);
      capture.dispose();
      assert.equal(state.stopped, 1);
    });
  }
});
