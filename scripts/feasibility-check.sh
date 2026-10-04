#!/usr/bin/env bash
# Host feasibility probe: can this VM run Android (emulator/Cuttlefish via KVM, or redroid via binder)?
# Read-only except for an optional, clearly-labelled modprobe attempt (needs root). Safe to re-run.
# Usage: bash feasibility-check.sh | tee feasibility-$(hostname).txt
set -u

section() { printf '\n=== %s ===\n' "$1"; }

section "Host"
date -u '+%Y-%m-%dT%H:%M:%SZ'
uname -a
. /etc/os-release 2>/dev/null && echo "OS: ${PRETTY_NAME:-unknown}"
echo "vCPUs: $(nproc)"
free -h | sed -n '1,2p'
df -h / | sed -n '1,2p'
echo "Page size: $(getconf PAGESIZE) (redroid needs 4096)"
lscpu | grep -E 'Model name|Hypervisor vendor|Virtualization' || true

section "KVM (needed for Android Emulator / Cuttlefish; NOT for redroid)"
if [ -e /dev/kvm ]; then
  ls -l /dev/kvm
  echo "RESULT kvm=PRESENT"
else
  echo "RESULT kvm=ABSENT"
fi
grep -cE '(vmx|svm)' /proc/cpuinfo | sed 's/^/cpu cores exposing vmx|svm flag: /'
[ -r /sys/module/kvm_intel/parameters/nested ] && echo "kvm_intel nested=$(cat /sys/module/kvm_intel/parameters/nested)"
[ -r /sys/module/kvm_amd/parameters/nested ] && echo "kvm_amd nested=$(cat /sys/module/kvm_amd/parameters/nested)"

section "Binder / ashmem / memfd (needed for redroid)"
CFG=""
for f in "/boot/config-$(uname -r)" /proc/config.gz; do
  [ -r "$f" ] && CFG="$f" && break
done
if [ -n "$CFG" ]; then
  echo "kernel config: $CFG"
  reader=cat; [ "${CFG##*.}" = gz ] && reader="zcat"
  $reader "$CFG" | grep -E '^(CONFIG_ANDROID_BINDER_IPC|CONFIG_ANDROID_BINDERFS|CONFIG_ANDROID_BINDER_DEVICES|CONFIG_MEMFD_CREATE|CONFIG_ASHMEM|CONFIG_IPV6|CONFIG_DMABUF_HEAPS|CONFIG_ION)[= ]' || echo "(none of the binder/ashmem options found in config)"
else
  echo "no readable kernel config"
fi
echo "binder module on disk: $(find /lib/modules/"$(uname -r)" -name 'binder_linux*' 2>/dev/null | head -1 || true)"
echo "binderfs in /proc/filesystems: $(grep -c binder /proc/filesystems)"

section "Try loading binder (needs root; skipped otherwise)"
if [ "$(id -u)" -eq 0 ]; then
  modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>&1 && echo "RESULT binder_modprobe=OK" || echo "RESULT binder_modprobe=FAILED"
  lsmod | grep -E 'binder|ashmem' || true
  ls /dev/binder* /dev/binderfs 2>/dev/null || true
  echo "binderfs in /proc/filesystems after: $(grep -c binder /proc/filesystems)"
else
  echo "not root: re-run with sudo to test modprobe"
fi

section "Docker"
command -v docker >/dev/null && docker --version || echo "docker not installed"

echo
echo "Summary: paste everything above into RESEARCH.md under the provider name."
