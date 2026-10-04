#!/usr/bin/env bash
# Downloads the scrcpy-server binary that the backend pushes to the Android device.
# The version must match SCRCPY_VERSION in backend/src/config.js exactly: scrcpy's
# protocol is internal and changes between versions (scrcpy doc/develop.md).
# Usage: bash scripts/fetch-scrcpy-server.sh
set -euo pipefail

SCRCPY_VERSION="4.1"
URL="https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}"
DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/backend/vendor"
DEST="${DEST_DIR}/scrcpy-server-v${SCRCPY_VERSION}"

mkdir -p "$DEST_DIR"
if [ -s "$DEST" ]; then
  echo "already present: $DEST"
else
  curl -fsSL -o "$DEST" "$URL"
  echo "downloaded: $DEST"
fi
sha256sum "$DEST"
