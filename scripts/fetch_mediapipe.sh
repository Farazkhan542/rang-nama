#!/usr/bin/env bash
# Fetch the MediaPipe runtime and face model into extension/vendor/.
#
# Bundled locally rather than loaded from Google's CDN: a CDN load is blocked
# by some host pages' CSP and would quietly make face detection a network
# dependency, which is the property the rest of the extension avoids.
#
#   bash scripts/fetch_mediapipe.sh
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p extension/vendor/wasm extension/vendor/models

if [ ! -d extension/node_modules/@mediapipe/tasks-vision ]; then
  ( cd extension && npm install --no-fund --no-audit @mediapipe/tasks-vision )
fi

# SIMD build only. Every Chrome that supports MV3 supports WASM SIMD, and the
# nosimd fallback is another 10 MB for nothing.
cp extension/node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js  extension/vendor/wasm/
cp extension/node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm extension/vendor/wasm/

curl -sSL \
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" \
  -o extension/vendor/models/face_landmarker.task

du -sh extension/vendor
