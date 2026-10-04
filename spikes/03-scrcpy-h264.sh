#!/usr/bin/env bash
# SPIKE 3 (throwaway): can scrcpy-server encode H.264 on redroid with software rendering,
# and can the stream be wrapped into MP4 without re-encoding (the recording path for B5)?
# Follows the "standalone server" recipe in scrcpy doc/develop.md.
# Run on the VM after spike 1:  bash 03-scrcpy-h264.sh 2>&1 | tee spike3.txt
# Status: written but NOT yet run anywhere.
set -uo pipefail

SCRCPY_VERSION="4.1"
SERVER_URL="https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}"
ADB_ADDR="${ADB_ADDR:-127.0.0.1:5555}"
PORT=1234
CAPTURE_S=10
OUT="${HOME}/spike-out"
JAR_ON_DEVICE="/data/local/tmp/scrcpy-server-spike.jar"

step() { printf '\n--- %s ---\n' "$1"; }
die()  { echo "SPIKE3 FAILED: $1"; exit 1; }

mkdir -p "$OUT"
command -v ffprobe >/dev/null || sudo apt-get install -y -qq ffmpeg
command -v nc >/dev/null || sudo apt-get install -y -qq netcat-openbsd

step "Fetch and push scrcpy-server v${SCRCPY_VERSION}"
[ -s "$OUT/scrcpy-server" ] || curl -fsSL -o "$OUT/scrcpy-server" "$SERVER_URL" || die "download failed"
adb -s "$ADB_ADDR" push "$OUT/scrcpy-server" "$JAR_ON_DEVICE" || die "adb push failed"
adb -s "$ADB_ADDR" forward "tcp:${PORT}" localabstract:scrcpy || die "adb forward failed"

step "Start server (raw H.264, video only)"
adb -s "$ADB_ADDR" shell "CLASSPATH=${JAR_ON_DEVICE}" app_process / com.genymobile.scrcpy.Server "$SCRCPY_VERSION" \
  tunnel_forward=true audio=false control=false cleanup=false raw_stream=true max_size=1280 \
  > "$OUT/scrcpy-server.log" 2>&1 &
SERVER_PID=$!
sleep 2

step "Generate motion so the encoder has something to send"
( for _ in $(seq 1 "$CAPTURE_S"); do
    adb -s "$ADB_ADDR" shell input swipe 360 900 360 300 200
    adb -s "$ADB_ADDR" shell input swipe 360 300 360 900 200
  done ) >/dev/null 2>&1 &
MOTION_PID=$!

step "Capture ${CAPTURE_S}s of stream"
timeout "$CAPTURE_S" nc 127.0.0.1 "$PORT" > "$OUT/spike3.h264"
kill "$MOTION_PID" "$SERVER_PID" 2>/dev/null
adb -s "$ADB_ADDR" forward --remove "tcp:${PORT}" 2>/dev/null

echo "server log:"; cat "$OUT/scrcpy-server.log"
BYTES=$(stat -c %s "$OUT/spike3.h264" 2>/dev/null || echo 0)
echo "RESULT h264_bytes=${BYTES}"
[ "$BYTES" -gt 0 ] || die "no video bytes received (encoder or socket problem; read the server log above)"

step "Inspect the stream"
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=codec_name,profile,width,height,nb_read_frames,has_b_frames \
  -of default=noprint_wrappers=1 "$OUT/spike3.h264" || die "ffprobe could not parse the stream"

step "Wrap into MP4 without re-encoding (recording path)"
ffmpeg -v error -y -f h264 -i "$OUT/spike3.h264" -c copy -movflags +frag_keyframe+empty_moov "$OUT/spike3.mp4" \
  && ls -l "$OUT/spike3.mp4" || echo "WARN: MP4 mux failed"

echo
echo "SPIKE3 OK. Frames / ${CAPTURE_S}s gives the real encode FPS under software rendering."
echo "Copy $OUT/spike3.mp4 to your laptop and play it to judge quality."
