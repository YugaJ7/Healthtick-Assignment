#!/usr/bin/env bash
# Host firewall for the network the Android devices live on (bridge awnet0, made by the
# backend). Run as root after Docker has started; android-web-firewall.service does that
# at every boot. Safe to run again.
#
# By default a device can reach nothing at all: not the internet, not this server, not
# the private network, not the cloud metadata address 169.254.169.254 (which hands out
# the server's credentials). With DEVICE_INTERNET=on in /etc/android-web.env a device
# may reach the public internet and DNS servers, and still none of the rest.
# The server still reaches each device: replies to connections it opened are allowed.
set -euo pipefail

BRIDGE="awnet0"
DEVICE_INTERNET="${DEVICE_INTERNET:-off}"
FORWARD_CHAIN="ANDROID-WEB-FWD"
INPUT_CHAIN="ANDROID-WEB-IN"
BLOCKED_RANGES="169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10"

ipt() { iptables -w "$@"; }
reset_chain() { ipt -N "$1" 2>/dev/null || ipt -F "$1"; }
jump_once() { ipt -C "$1" -i "$BRIDGE" -j "$2" 2>/dev/null || ipt -I "$1" -i "$BRIDGE" -j "$2"; }

# Traffic from a device to anywhere else passes Docker's DOCKER-USER chain.
ipt -N DOCKER-USER 2>/dev/null || true
reset_chain "$FORWARD_CHAIN"
if [ "$DEVICE_INTERNET" != "on" ]; then
  ipt -A "$FORWARD_CHAIN" -j DROP
else
  # Docker's name lookups for a container leave from the container's side, and the
  # server's own resolver sits in a private range, so DNS is let through first.
  ipt -A "$FORWARD_CHAIN" -p udp --dport 53 -j RETURN
  ipt -A "$FORWARD_CHAIN" -p tcp --dport 53 -j RETURN
  for range in $BLOCKED_RANGES; do ipt -A "$FORWARD_CHAIN" -d "$range" -j DROP; done
fi
jump_once DOCKER-USER "$FORWARD_CHAIN"

# Traffic from a device to this server itself.
reset_chain "$INPUT_CHAIN"
ipt -A "$INPUT_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
ipt -A "$INPUT_CHAIN" -j DROP
jump_once INPUT "$INPUT_CHAIN"

echo "device firewall applied (bridge ${BRIDGE}, device internet ${DEVICE_INTERNET})"
