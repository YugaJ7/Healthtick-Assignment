#!/usr/bin/env bash
# Sets up a fresh Ubuntu 24.04 x86-64 server to run the whole project, and makes it
# come back by itself after a reboot. Safe to run again: every step checks first.
#
# Usage (from the repo root on the server):
#   sudo SITE_HOST=device.example.com bash infra/setup.sh
#
# SITE_HOST   public host name that points at this server (needed for HTTPS). Several
#             names can be given, separated by commas; the first is the main one.
#             Leave it out to skip the web server and keep the app on 127.0.0.1:8080.
# ACCESS_CODE optional; when set, visitors must enter it. Left out, the site is open to everyone.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="/opt/android-web"
APP_USER="androidweb"
ENV_FILE="/etc/android-web.env"
NODE_MAJOR="22"
REDROID_IMAGE="redroid/redroid:12.0.0_64only-latest"
SITE_HOST="${SITE_HOST:-}"

step() { printf '\n=== %s ===\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# Ubuntu installs security updates by itself and holds the package lock while it does;
# each package step waits for that lock for up to five minutes.
step "Packages"
apt-get -o DPkg::Lock::Timeout=300 update -qq
apt-get -o DPkg::Lock::Timeout=300 install -y -qq docker.io adb curl xz-utils openssl "linux-modules-extra-$(uname -r)"
# The meta package pulls the extra modules for future kernels too, so a kernel
# upgrade followed by a reboot does not lose binder. Not fatal if it is missing.
apt-get -o DPkg::Lock::Timeout=300 install -y -qq linux-modules-extra-aws || echo "WARN: linux-modules-extra-aws not installed; binder may be missing after a kernel upgrade"

step "Binder kernel module, now and at every boot"
# iptable_filter and ip6table_filter: the firewall rule the backend sets inside each device
# uses Android's own iptables, which needs these (Ubuntu's Docker does not load them).
printf 'binder_linux\niptable_filter\nip6table_filter\n' > /etc/modules-load.d/android-web.conf
echo 'options binder_linux devices=binder,hwbinder,vndbinder' > /etc/modprobe.d/android-web.conf
modprobe binder_linux
modprobe iptable_filter
modprobe ip6table_filter
grep -q binder /proc/filesystems || { echo "binder is not available on this kernel"; exit 1; }

step "Node.js ${NODE_MAJOR} (official build, checksum verified)"
if ! /opt/node/bin/node --version 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums="$(curl -fsSL "${base}/SHASUMS256.txt")"
  tarball="$(echo "$sums" | awk '/linux-x64.tar.xz$/ {print $2}')"
  curl -fsSL -o "/tmp/${tarball}" "${base}/${tarball}"
  (cd /tmp && echo "$sums" | grep " ${tarball}\$" | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "/tmp/${tarball}" -C /opt/node --strip-components=1
  rm -f "/tmp/${tarball}"
fi
/opt/node/bin/node --version

step "Android image (devices are created per session by the backend)"
systemctl enable --now docker
docker pull -q "$REDROID_IMAGE"
# Earlier versions of this script ran one fixed device; it is no longer used.
docker rm -f android-0 >/dev/null 2>&1 || true

step "Application files"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
# The backend creates and removes the device containers, so it needs Docker access.
# Note: membership of the docker group is equivalent to root on this server.
usermod -aG docker "$APP_USER"
mkdir -p "$APP_DIR"
cp -r "$REPO_DIR/backend" "$REPO_DIR/frontend" "$REPO_DIR/scripts" "$REPO_DIR/infra" "$APP_DIR/"
find "$APP_DIR" -name '*.sh' -exec sed -i 's/\r$//' {} +
bash "$APP_DIR/scripts/fetch-scrcpy-server.sh"
(cd "$APP_DIR/backend" && PATH="/opt/node/bin:$PATH" npm ci --omit=dev --no-audit --no-fund)
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

step "Settings file ${ENV_FILE}"
if [ ! -f "$ENV_FILE" ]; then
  # The site is open to everyone by default. Setting ACCESS_CODE (8+ characters) makes
  # visitors enter that code before they get a device.
  printf 'HOST=127.0.0.1\nPORT=8080\nMAX_SESSIONS=3\nACCESS_CODE=%s\n' "${ACCESS_CODE:-}" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

step "Firewall for the device network, then the backend service (both start at boot)"
cp "$REPO_DIR/infra/android-web.service" "$REPO_DIR/infra/android-web-firewall.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable android-web-firewall android-web
systemctl restart android-web-firewall
systemctl restart android-web

if [ -n "$SITE_HOST" ]; then
  step "Caddy web server: HTTPS for ${SITE_HOST}, forwarding to the backend"
  apt-get -o DPkg::Lock::Timeout=300 install -y -qq caddy
  printf '%s {\n\treverse_proxy 127.0.0.1:8080\n}\n' "$SITE_HOST" > /etc/caddy/Caddyfile
  systemctl enable caddy
  systemctl restart caddy
fi

step "Done"
sleep 5
systemctl --no-pager --lines=5 status android-web || true
echo
[ -n "$SITE_HOST" ] && echo "Open: https://${SITE_HOST%%,*}/"
echo "Settings (session limit, optional access code): ${ENV_FILE}"
echo "Health: curl -s http://127.0.0.1:8080/healthz"
