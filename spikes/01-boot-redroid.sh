#!/usr/bin/env bash
# SPIKE 1 (throwaway): does Android boot on this server as a redroid container?
# Run on a fresh Ubuntu 22.04 VM:  sudo bash 01-boot-redroid.sh 2>&1 | tee spike1.txt
# Status: written but NOT yet run anywhere. Expect to fix things on first run.
set -uo pipefail

IMAGE="redroid/redroid:12.0.0_64only-latest"   # tag taken from redroid-doc deploy README
NAME="spike-redroid"
ADB_ADDR="127.0.0.1:5555"                       # localhost only: ADB must never be public
OUT="${HOME}/spike-out"
BOOT_TIMEOUT_S=180

step() { printf '\n--- %s ---\n' "$1"; }
die()  { echo "SPIKE1 FAILED: $1"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
mkdir -p "$OUT"

step "Install docker, adb, kernel extra modules"
apt-get update -qq
apt-get install -y -qq docker.io adb "linux-modules-extra-$(uname -r)" \
  || echo "WARN: package install had errors (linux-modules-extra may not exist for this kernel flavour)"

step "Load binder"
modprobe binder_linux devices="binder,hwbinder,vndbinder" \
  || echo "WARN: modprobe binder_linux failed (binder may be built in; redroid will tell us)"
grep binder /proc/filesystems || echo "WARN: binder not listed in /proc/filesystems"

step "Start redroid (software rendering)"
docker rm -f "$NAME" >/dev/null 2>&1
START=$(date +%s)
docker run -d --privileged --name "$NAME" \
  -p "${ADB_ADDR}:5555" \
  "$IMAGE" \
  androidboot.redroid_gpu_mode=guest \
  androidboot.redroid_width=720 androidboot.redroid_height=1280 androidboot.redroid_fps=30 \
  || die "docker run failed"

step "Wait for Android to finish booting"
booted=""
while [ $(( $(date +%s) - START )) -lt "$BOOT_TIMEOUT_S" ]; do
  adb connect "$ADB_ADDR" >/dev/null 2>&1
  booted=$(adb -s "$ADB_ADDR" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
  [ "$booted" = "1" ] && break
  sleep 2
done
if [ "$booted" != "1" ]; then
  echo "Container state and last logs:"
  docker ps -a --filter "name=$NAME"
  docker logs --tail 40 "$NAME" 2>&1
  die "Android did not report boot_completed within ${BOOT_TIMEOUT_S}s"
fi
echo "RESULT boot_seconds=$(( $(date +%s) - START ))"

step "Device facts"
adb -s "$ADB_ADDR" shell getprop ro.build.version.release | sed 's/^/android_version=/'
adb -s "$ADB_ADDR" shell wm size
adb -s "$ADB_ADDR" shell wm density

step "Screenshot as proof"
adb -s "$ADB_ADDR" exec-out screencap -p > "$OUT/spike1.png"
ls -l "$OUT/spike1.png"

step "Resource use of one idle instance (sizing for 3)"
docker stats --no-stream --format 'cpu={{.CPUPerc}} mem={{.MemUsage}}' "$NAME"
free -h | sed -n '1,2p'

echo
echo "SPIKE1 OK. Container '$NAME' left running for spikes 2 and 3."
echo "Remove it afterwards with: docker rm -f $NAME"
