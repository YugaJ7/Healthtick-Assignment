# RESEARCH

Phase 1 findings. Each claim is tagged **[verified]** (read in a cited source or confirmed by a command I ran) or **[unverified]** (from memory or a search snippet; check before relying on it).

Started: Sun 4 Oct 2026, ~00:20 IST.

> **Status:** a snapshot of Phase 1 (research), kept as it was written, so it still says "none run yet" and "not chosen" in places. What happened next is in `docs/notes/NOTES.md`: the probe ran on 4 Oct (binder loads once `linux-modules-extra` is installed; `/dev/kvm` is present), architecture 1 below was chosen, and clipboard (section 7), restriction (section 8) and recording (section 9) were all built in the end.

---

## 0. Host feasibility (done first because it decides the architecture)

### Two families of Android on a server

| Family | Examples | Needs from the host |
|---|---|---|
| VM-based | Official Android Emulator, Cuttlefish | `/dev/kvm`. On a cloud VM that means nested virtualization, or bare metal. |
| Container-based | redroid | Host kernel with binder (`binder_linux` / binderfs), memfd, IPv6, 4 KB pages, and a privileged container. No KVM. |

A VM without `/dev/kvm` rules out the emulator and Cuttlefish. redroid may still work, provided the VM kernel can load binder.

### What redroid needs [verified]

- Source: https://github.com/remote-android/redroid-doc/blob/master/deploy/README.md
  - Mandatory kernel features: `binderfs`, `ashmem` / `memfd`, IPv6, ION / DMA-BUF heaps, 4 KB page size.
  - Run with `docker run --privileged`, a `/data` volume and ADB on port 5555. Disable SELinux if present.
- Source: https://github.com/remote-android/redroid-doc/blob/master/deploy/ubuntu.md
  - Ubuntu 20.04 / 22.04: `apt install linux-modules-extra-$(uname -r)`, then `modprobe binder_linux devices="binder,hwbinder,vndbinder"`.
  - `ashmem_linux` is optional and was removed in kernel 5.18+.
  - The doc warns that cloud kernels may lack the required modules. This is the main risk to test.

### Provider KVM / nested virtualization

| Provider | Finding | Status |
|---|---|---|
| GCP Compute Engine | Supported on most machine types except E2, memory-optimized, Arm and AMD (N4D is the AMD exception). Only Linux KVM is supported as the L1 hypervisor. Google warns of a 10% or greater slowdown for nested VMs. https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview | verified |
| Azure | Search snippet lists Dv3/Ev3 (4+ vCPUs), Dv4/Dsv4, Dv5/Dsv5, Ev4/Ev5, Fsv2. Third-party blog, not Microsoft docs. | unverified |
| AWS | Search snippet says KVM only on bare metal. Source is an older third-party page, so this may be stale. | unverified |
| DigitalOcean, Hetzner, Vultr, Oracle, others | Not researched yet. | unverified |

**Update, ~00:40 IST (second pass, official docs where available):**

| Provider | Finding | Status |
|---|---|---|
| AWS EC2 | **The earlier row was wrong.** Nested virtualization works on ordinary (non-bare-metal) instances: M7i, M7i-flex, M8i, M8id, M8i-flex, C7i, C7i-flex, C8i, C8id, C8i-flex, R7i, R7iz, R8i, R8id, R8i-flex, X8i, I7i, I7ie. KVM and Hyper-V are supported as L1. Enabled at launch with `--cpu-options "NestedVirtualization=enabled"`. No extra cost. https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html | verified |
| Azure | Microsoft Learn size pages list "Nested Virtualization: Supported" for Dv5, Dsv5, Ddv5, Ddsv5, Dlsv5, Dadsv5; not supported on the Arm Dpsv5 / Dpdsv5. Read from search summaries of learn.microsoft.com pages, not the pages themselves. e.g. https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dsv5-series | partly verified |
| DigitalOcean | A community Q&A answer says Droplets support nested virtualization in all regions but performance is often very poor. https://digitalocean.com/community/questions/does-digitalocean-support-kvm-or-nested-virtulzation | unverified (forum answer) |
| Hetzner Cloud | A 2022 blog says cloud servers do not support nested KVM; dedicated servers do. Old, third-party. https://blog.wirelessmoves.com/2022/05/nested-virtualization.html | unverified |

**Binder on cloud kernels:** a search summary claims cloud-flavour Ubuntu kernels (linux-gcp / linux-aws / linux-azure) often lack `binder_linux`, with DKMS builds of the modules as a fallback (https://github.com/remote-android/redroid-modules). I could not find a primary source that states this per kernel flavour, so it stays **unverified** until the probe runs.

**Local tooling [verified by command]:** no `gcloud`, `aws`, `az`, `doctl`, `hcloud` or `docker` on this Windows machine; `ssh` and `wsl` are present. The probe VM has to be created from a provider's web console (or a CLI installed first).

### Still unknown

- Whether the stock GCP / Ubuntu cloud kernel ships `binder_linux`. Only running the probe answers this.
- RAM and CPU per instance for redroid and for the emulator. To be measured.

### How to settle it

Run `scripts/feasibility-check.sh` (read-only apart from a `modprobe binder_linux` attempt when run as root) on a cheap hourly VM at each candidate provider, then delete the VM. One paste reports:

- whether `/dev/kvm` exists,
- whether binder is built in or loadable, and whether the `modprobe` worked,
- kernel, OS, vCPU, RAM and page size.

Record results here.

| Provider / instance | Date | /dev/kvm | binder modprobe | Notes |
|---|---|---|---|---|
| _none run yet_ | | | | |

---

## 2. Getting the screen out of the device: scrcpy (first pass)

Source: https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md (licence: Apache-2.0, https://github.com/Genymobile/scrcpy/blob/master/LICENSE). All **[verified]** from that doc.

- **How it starts.** The server is a `.jar` pushed to the device and run with `app_process`, not an installed app:
  `adb shell CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server 4.0 [key=value ...]`
  The first argument is the version and must match the client exactly. The doc's examples use version 4.0.
- **Sockets.** Up to three, opened in this order: video, audio, control. Each can be switched off (`audio=false`, `control=false`).
- **Tunnel.** Default is `adb reverse` (device connects out to the host). `tunnel_forward=true` uses `adb forward tcp:PORT localabstract:scrcpy` instead, where the host connects in. In forward mode the device sends one dummy byte on the first socket.
- **Video wire format.** A `u32` codec ID first (`h264`, `h265`, `av1`, `vp8`, `vp9`). Then a 12-byte session packet (flags, width, height). Then each packet has a 12-byte frame header: flag bits for config packet and keyframe, a PTS, and a 32-bit packet size.
- **Raw mode.** `raw_stream=true` drops all of that metadata and sends a plain H.264 stream. Individual switches exist too: `send_frame_meta`, `send_device_meta`, `send_stream_meta`, `send_dummy_byte`.
- **Standalone use is documented.** The doc gives a working recipe for running the server without the scrcpy client and reading raw H.264 from a TCP port. That is exactly the piece a browser backend reuses.
- **Control protocol.** The doc says the only documentation is the unit tests for `ControlMessage` and `DeviceMessage` on both sides. So the input format must be read from scrcpy's source, pinned to one version.

What this means for us:
- The frame header's config and keyframe flags are what a browser decoder needs to know when it may start decoding (see PHASE0_GUIDE, C1 trap). Keeping frame metadata on is therefore more useful than `raw_stream=true`.
- The version must be pinned, since the control format is version-specific and undocumented.

Not yet researched: alternatives (emulator gRPC/WebRTC, `screenrecord`, screencap polling, VNC), and whether redroid's software video encoder is good enough.

## 3. Getting video into the browser (first pass)

- **WebCodecs `VideoDecoder`** [verified, https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder]: needs a secure context (HTTPS), works in dedicated workers, and MDN marks it as "not Baseline", meaning not available in every widely used browser. Exact per-browser versions were not extracted; **unverified**.
- **ws-scrcpy** (https://github.com/NetrisTV/ws-scrcpy) [verified from its README]: a browser client for scrcpy. Useful as a reference, with cautions:
  - It uses a **modified scrcpy v1.19** server with WebSocket support built in, from the author's fork. That is several major versions behind the 4.0 in scrcpy's current docs.
  - It offers four players: MSE, Broadway (WebAssembly), TinyH264 (WebAssembly) and WebCodecs.
  - Its README warns: no encryption between browser and server, and "no authorization on any level".
  - Licence was not stated in the README text I read; **unverified**.
  - Takeaway: study it for the decoder and input-mapping ideas; do not deploy it as-is, since B1 needs per-session auth.

Not yet researched: MSE vs WebRTC vs MJPEG latency comparison, B-frames and buffering.

---

# Second pass (Sun 4 Oct, ~00:30 to 01:00 IST)

Tags as before: **[verified]** means read in the cited source; **[memory]** means from my training knowledge and not checked in this session; **[to measure]** means only a spike can answer it.

## 1. Running Android on a server: options compared

| Option | Type | Host needs | Licence | Fit for 2–3 instances on one VM | Status |
|---|---|---|---|---|---|
| **redroid** | Container | binderfs, memfd, IPv6, DMA-BUF heaps, 4 KB pages, `--privileged`. No KVM. | Apache-2.0 (kernel modules GPL-2.0) | Designed for it; overlayfs option shares a base data image with private per-instance differences. | [verified] https://github.com/remote-android/redroid-doc |
| **Android Emulator (AVD)** | VM | KVM. Android docs: "You can't run a VM-accelerated emulator inside another VM… You must run a VM-accelerated emulator directly on your host computer." Without acceleration it "can be quite slow". | SDK licence terms [memory, not checked] | Heavy per instance [to measure]. | [verified] https://developer.android.com/studio/run/emulator-acceleration |
| **Cuttlefish** | VM | KVM (`grep -c -w "vmx\|svm" /proc/cpuinfo` must be nonzero). Host packages are built from source. Ships its own WebRTC viewer on port 8443. | Apache-2.0 [memory] | Supports multiple instances [memory]; setup is the longest of the three. | [verified] https://source.android.com/docs/devices/cuttlefish/get-started |
| Waydroid | Container | Needs a Wayland session [memory]. The docs page on headless use returned 404, so I could not confirm headless support. | GPL-3.0 [memory] | Poor fit for a headless server. | unverified |
| Genymotion | VM / SaaS | n/a | Commercial; the brief forbids paid emulator platforms. | Rejected on licence grounds without further research. | [memory] |
| Android-x86 | Full VM image | KVM + QEMU | open source [memory] | Project activity is low [memory]; not researched further. | unverified |

**Conflict to note.** Android's doc says a VM-accelerated emulator cannot run inside another VM. AWS's nested-virtualization doc lists "Android Studio emulators" as a use case, and GCP documents KVM as a supported L1 hypervisor. My reading: the Android doc predates or ignores cloud nested virtualization, and the emulator works wherever `/dev/kvm` works. That reading is **unverified** until the probe and a boot test.

**redroid specifics [verified, redroid-doc README]:**
- Images for Android 8.1 through 16, tag format `redroid/redroid:<version>-latest`, with `_64only` variants.
- Boot parameters: `androidboot.redroid_width` (default 720), `_height` (1280), `_dpi` (320), `_fps` (30 with GPU, **15 without**), `androidboot.redroid_gpu_mode` = `auto` / `host` / `guest` (guest is software rendering), `androidboot.use_memfd`, `androidboot.use_redroid_overlayfs`.
- ARM apps run on x86 through the preinstalled `libndk_translation`.
- **Risk:** on a cloud VM with no GPU, rendering is software and the default is 15 fps. Whether 30 fps is usable in software mode, and whether the software H.264 encoder keeps up, is **[to measure]** in Spike 3.

**Isolation strength (needed for the write-up).** redroid containers share the host kernel and run `--privileged`, so isolation between sessions is weaker than between VMs: a kernel or container escape in one session reaches the host. Emulator and Cuttlefish instances are separate VMs with their own kernels. This is the main trade-off of choosing redroid.

## 4. Sending input: scrcpy control protocol

Source: scrcpy `ControlMessage.java` and `ControlMessageReader.java` on master. **[verified]** by reading them; these are the definitive reference because scrcpy documents the protocol only through code and tests.
https://github.com/Genymobile/scrcpy/blob/master/server/src/main/java/com/genymobile/scrcpy/control/ControlMessageReader.java

All integers are big-endian. Each message starts with a 1-byte type.

| Type | Value | Payload |
|---|---|---|
| INJECT_KEYCODE | 0 | action (1) · keycode (4) · repeat (4) · metaState (4) |
| INJECT_TEXT | 1 | length (4) · UTF-8 bytes; max 300 characters |
| INJECT_TOUCH_EVENT | 2 | action (1) · pointerId (8) · position (12) · pressure (2, unsigned fixed point) · actionButton (4) · buttons (4) |
| INJECT_SCROLL_EVENT | 3 | position (12) · hScroll (2, signed fixed point) · vScroll (2) · buttons (4) |
| BACK_OR_SCREEN_ON | 4 | action (1) |
| EXPAND_NOTIFICATION_PANEL / EXPAND_SETTINGS_PANEL / COLLAPSE_PANELS | 5 / 6 / 7 | none |
| GET_CLIPBOARD | 8 | copyKey (1) |
| SET_CLIPBOARD | 9 | sequence (8) · paste (1) · length (4) · UTF-8 text |
| ROTATE_DEVICE | 11 | none |
| START_APP | 16 | text |

**Position** is x (4) · y (4) · screenWidth (2) · screenHeight (2). The client states the frame size it believes it is clicking on. [memory] scrcpy drops touch events whose stated size does not match the current video size, which guards against stale coordinates after rotation; I have not re-read that code path.

Consequences for the design:
- **Coordinate mapping** stays simple: the browser converts a click to video-frame pixels and sends those with the frame's width and height. scrcpy maps frame pixels to device pixels itself, so downscaled video is handled server-side (PHASE0_GUIDE, C2 trap 4).
- **Server-side filtering is possible.** The backend sits between browser and control socket, so it can allow only types 0–3 and drop the rest. Message types 5, 6, 16 (notification panel, settings panel, start app) are exactly what B4 would have to block, if it is added later.
- **Why not `adb shell input`:** each call starts a new process on the device [memory]; Spike 2 measures the real cost.
- **Text:** INJECT_TEXT handles ordinary text up to 300 characters; special keys use INJECT_KEYCODE.

## 5. Latency measurement

Options, none verified by running yet:

| Method | What it measures | Credibility | Cost |
|---|---|---|---|
| **A. In-browser, one clock.** Record `performance.now()` at pointerdown; watch decoded frames for a pixel change at the tap point; record the time when that frame is drawn. | Input → network → Android → encode → network → decode → draw. Leaves out display scan-out and the input device. | Good: one clock, automatable, 30+ trials easy. | Low |
| **B. High-speed phone camera** filming finger and screen. | True glass-to-glass. | Best, but manual frame counting and few trials. | Medium |
| **C. Server timestamps** on input received and frame sent. | Server-side share only. | Useful as a breakdown, not as the headline. | Low |

Recommendation: A as the headline with 30+ trials (median, p95, min, max), C for the breakdown, and a handful of B samples as a sanity check on A. A needs a target that changes reliably on touch; Android's "Show taps" / pointer-location developer option does that for any app [memory; setting name to verify on the device].

## 6. Per-user isolation and on-demand lifecycle (B1, B2)

Design sketch for the recommended architecture; nothing is built or tested.

- **One container per session**, created on request, named with the session ID, with its own `/data`. No reuse between users: destroy the container and delete its data on session end, which is what stops "installed state" leaking.
- **No published ADB port.** redroid's example publishes 5555; ADB on a public port would let anyone control any device. Bind it to localhost or use a private Docker network only.
- **Session token:** random and unguessable, required on the WebSocket. Session ID alone must not be enough.
- **Network isolation between instances:** needs a per-session Docker network or inter-container communication disabled [to verify with a test].
- **Lifecycle:** create on "start"; destroy on explicit end, WebSocket close plus a short grace period, missed heartbeats, and idle timeout.
- **Reaper:** on backend start and on a timer, list containers with our label and remove any with no live session. Labels make orphans findable after a crash.
- **Capacity:** fixed maximum of concurrent sessions, "busy" message beyond it.
- **Cold boot time** decides whether on-demand feels acceptable. **[to measure]** in Spike 1.

## 7. Clipboard (B3, not chosen)

- scrcpy: SET_CLIPBOARD (type 9) with a `paste` flag, GET_CLIPBOARD (type 8). [verified, same source as section 4]
- Browser Clipboard API [verified, https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API]: needs a secure context. Reading needs transient user activation. Chromium shows a `clipboard-read` permission prompt; Firefox and Safari show a small "Paste" popup instead. Writing needs `clipboard-write` permission in Chromium or transient activation in Firefox and Safari.
- Cheap to add later because the protocol support already exists.

## 8. Restricting to one app (B4, not chosen)

Not researched beyond section 4's note that server-side filtering of control message types is possible. Lock task mode and device-owner setup remain unverified.

## 9. Session recording (B5, stretch)

[memory, not verified] The backend already receives the H.264 stream, so it can copy the same bytes into `ffmpeg -c copy` writing fragmented MP4 per session ID, with no re-encode. Fragmented MP4 stays playable if the session dies abruptly. To verify in a spike before committing at the Phase 2 gate.

## 10. Hosting

- Provider capability: see section 0.
- [memory] Caddy gives automatic Let's Encrypt HTTPS and proxies WebSockets without extra configuration; needs a domain name pointing at the server. Not verified in this session.
- HTTPS is required anyway: WebCodecs and the Clipboard API both need a secure context [verified, MDN].
- Sizing for three instances: **[to measure]** in Spike 1.

## 3b. Browser decode options compared

| Option | Latency | Complexity | Browser support | Notes |
|---|---|---|---|---|
| **WebSocket + WebCodecs** | Lowest of the WebSocket options: no player buffer [memory] | Medium: we handle keyframes, timing, errors | Chrome and Edge 94+, Firefox 130+, Safari 26+ (partial from 16.4); caniuse reports 94.47% global support [verified, https://caniuse.com/webcodecs] | TCP head-of-line blocking on lossy networks |
| WebSocket + MSE (fMP4) | Higher; `<video>` buffers unless tuned [memory] | Medium: needs an fMP4 muxer | Very wide [memory] | Fallback candidate |
| WebRTC | Best on lossy networks [memory] | Highest: signalling, ICE, TURN, RTP packetising | Universal [memory] | Cuttlefish and the emulator ship their own WebRTC streaming |
| MJPEG / screenshots | Poor | Lowest | Universal | Spike 2 measures how slow |

## Ranked shortlist of architectures

### 1. redroid + scrcpy-server + WebSocket + WebCodecs (recommended)

- **Device:** one redroid container per session (Docker).
- **Capture:** stock scrcpy-server v4.1 (latest release, published 12 Jul 2026 [verified, GitHub releases API]) run with `app_process`, H.264, frame metadata on.
- **Transport:** backend relays video packets over a WebSocket; input comes back on the same socket.
- **Decode:** WebCodecs `VideoDecoder` to a canvas.
- **Input:** scrcpy control socket; backend allow-lists message types.
- **Hosting:** any VM whose kernel provides binder. No KVM needed, so the choice of instance type is wide.
- **Expected latency:** [to measure]. No buffering stage, so mostly network RTT plus encode and decode.
- **Why first:** lightest per instance, fastest to create and destroy (which B1 and B2 depend on), and the simplest moving parts.
- **Biggest risks:** (a) the cloud kernel lacks binder; (b) software rendering and software H.264 encoding are too slow without a GPU; (c) weaker isolation than VMs.

### 2. Android Emulator (headless) + scrcpy-server + WebSocket + WebCodecs

- Same capture, transport, decode and input as option 1; only the device differs. Everything above the device layer carries over unchanged if option 1 fails.
- **Hosting:** needs `/dev/kvm`, so a nested-virtualization instance type.
- **Why second:** stronger isolation (one VM per session) and the most standard Android, but heavier, slower to boot [to measure], and each session needs its own AVD data.
- **Biggest risk:** nested-virtualization performance, and boot time making on-demand sessions feel slow.

### 3. Cuttlefish with its built-in WebRTC

- **Why third:** it already streams to a browser over WebRTC, so the least streaming code. But the streaming would then be Cuttlefish's work, not ours, which weakens the write-up; the build and setup are the longest; and per-session auth, lifecycle and measurement would have to be bolted onto its web UI.
- **Biggest risk:** setup time inside a 72-hour budget.

### Fallback rule

Run the probe. If binder loads, go with option 1. If binder is absent but `/dev/kvm` exists, go with option 2. An Intel nested-virtualization VM keeps both open, which is why section 0 recommends probing on one.