#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'The ScreenCaptureKit probe requires macOS and Xcode command line tools.' >&2
  exit 1
fi
script_dir="$(cd "$(dirname "$0")" && pwd)"
probe_root="$script_dir/../native/macos-audio"
bundle="$probe_root/build/SystemAudioProbe.app"
mkdir -p "$bundle/Contents/MacOS"
cp "$probe_root/Info.plist" "$bundle/Contents/Info.plist"
xcrun swiftc -parse-as-library -swift-version 5 -O \
  -target arm64-apple-macos13.0 -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -framework Foundation -framework CoreGraphics -framework CoreMedia \
  -framework AudioToolbox -framework ScreenCaptureKit \
  "$probe_root/Probe.swift" -o "$bundle/Contents/MacOS/SystemAudioProbe"
codesign --force --sign - --identifier com.fuckinterview.system-audio-probe.dev "$bundle"
codesign --verify --strict "$bundle"
echo "Built local development probe: $bundle"
