# NOTES

Running list of measurements, commands that worked, gotchas and decisions. Raw material for the write-up. Times in IST.

## Time log

| When | What | Hours |
|---|---|---|
| Sat 3 Oct 13:00 | Assignment received | |
| Sat 3 Oct (evening) to Sun 4 Oct ~00:10 | Phase 0 in claude.ai chat | _fill in_ |
| Sun 4 Oct ~00:10 to ~01:10 | Phase 1 research, spike scripts prepared | ~1 |

## Measurements

None yet. To fill from the spikes:

| What | Value | Conditions |
|---|---|---|
| `/dev/kvm` on VM | | |
| binder loads on VM kernel | | |
| redroid cold boot (s) | | |
| Idle RAM / CPU per instance | | |
| `screencap` time per frame (ms) | | |
| `adb shell input tap` time (ms) | | |
| scrcpy H.264 frames in 10 s (software rendering) | | |

## Commands that worked

None on a server yet.

## Gotchas

- WSL is not usable on the laptop as a local test host: `wsl -l -v` fails with `REGDB_E_CLASSNOTREG`, and redroid on WSL2 needs a rebuilt kernel anyway (redroid-doc deploy/wsl.md).
- No cloud CLIs, Docker, adb or ffmpeg on the laptop. Node 26 and Python 3.14 are present.
- The brief is saved as `Assignment.md`; docs refer to `ASSIGNMENT.md`. Case matters on Linux.
- redroid's example publishes ADB on port 5555. Never publish that publicly; the spikes bind it to 127.0.0.1.
- redroid defaults to 15 fps without a GPU; the spikes ask for 30 and measure what is actually delivered.
- Search summaries were wrong about AWS nested virtualization (said bare metal only). Official docs say C7i / M7i / C8i / M8i and others support it.

## Manual steps done on servers (must end up in the setup script)

None yet.

## Decisions

See PROCESS_LOG.md for who decided what and when.

## Server results, Sun 4 Oct ~03:10 IST (first real measurements)

Server: AWS m7i-flex.large (2 vCPU, 7.6 GiB), region ap-southeast-2 (Sydney, not Mumbai as planned), Ubuntu 24.04.4, kernel 6.17.0-1017-aws, IP 13.55.1.9. Raw output in `spikes/out/`.

| What | Value | Conditions |
|---|---|---|
| `/dev/kvm` on VM | present, `kvm_intel nested=Y` | nested virtualization enabled at launch |
| binder loads on VM kernel | yes, after installing `linux-modules-extra-6.17.0-1017-aws` | not on disk before that (probe run 1 said FAILED) |
| redroid cold boot | 29 s | includes pulling the image; Android 12, 720x1280, 320 dpi |
| Idle RAM / CPU per instance | ~600 MiB, 0.4 to 2 % CPU | 173 % CPU in the first seconds after boot |
| `screencap` time per frame | 214 ms | one sample, adb on the same host |
| `adb shell input tap` time | 23 ms | one sample |
| scrcpy H.264 frames in 10 s | 187 (about 19 fps) | software rendering, encoder `c2.android.avc.encoder`, Constrained Baseline, 720x1280, 3.2 MB; swipes on the home screen, so little was changing |
| H.264 to MP4 without re-encode | works, 3.2 MB | `ffmpeg -c copy`, fragmented MP4 |
| Tap lands | yes | `input tap 277 800` on the Gallery icon opened `com.android.gallery3d` |

### Commands that worked on the server

- `sudo apt-get install -y docker.io adb linux-modules-extra-$(uname -r)`
- `sudo modprobe binder_linux devices="binder,hwbinder,vndbinder"`
- `docker run -d --privileged --name spike-redroid -p 127.0.0.1:5555:5555 redroid/redroid:12.0.0_64only-latest androidboot.redroid_gpu_mode=guest androidboot.redroid_width=720 androidboot.redroid_height=1280 androidboot.redroid_fps=30`
- scrcpy-server v4.1 standalone, as in `spikes/03-scrcpy-h264.sh`

### Gotchas found

- The binder module is not loaded at boot. After a reboot it must be loaded again (needs a `/etc/modules-load.d/` entry in the setup script; not done yet).
- Windows line endings: scripts copied from the laptop needed `sed -i 's/\r$//'` on the server.
- The EC2 console's Ubuntu list has no plain 22.04 image; 24.04 was used.
- Spike 2's Node page was not run on the server (Node is not installed there); the same two operations were timed directly with adb.

## New server and M1 result, Sun 4 Oct ~12:15 IST

The user moved to a second AWS account. New server: m7i.large (2 vCPU, 7.6 GiB; not the "flex" type asked for), region ap-south-1 (Mumbai), Ubuntu 24.04.4, kernel 6.17.0-1017-aws, IP 65.0.108.50, key `healthtick-2.pem`.

| What | Value | Conditions |
|---|---|---|
| `/dev/kvm`, binder | same as the first server: KVM present; binder loads after `linux-modules-extra` | |
| redroid cold boot | 28 s | includes image pull |
| Idle per instance | ~590 MiB, under 1 % CPU | |
| WebSocket connect to first video message | 256 to 274 ms | client on the server itself |
| Frames drawn in the browser | 27 per second during swipes; 0 when the screen is still | Chrome on the laptop through an SSH tunnel, 720x1280 |
| Page recovers after backend restart | yes, viewer back about 2 s after the backend was up | backend killed for 6 s |

### Commands that worked

- Node 22 on the server from the official tarball, checked against nodejs.org `SHASUMS256.txt`, unpacked to `/opt/node`.
- View from the laptop: `ssh -i ~/.ssh/healthtick-2.pem -N -L 8080:127.0.0.1:8080 ubuntu@65.0.108.50`, then open http://localhost:8080.

### Gotchas found

- `pkill -f "node src/server.js"` run over SSH kills the SSH command itself, because the pattern appears in its own command line (two silent exit-255 failures). Use `pkill -x node` from a script file.
- A backend killed with SIGKILL leaves `adb forward` entries behind. Fixed by `adb forward --remove-all` at startup. After SIGTERM one forward can still remain (the process exits before the removal finishes); the startup cleanup covers it.
- `adb devices` on the server lists the container twice (`127.0.0.1:5555` and `emulator-5554`). Harmless so far; the backend always passes `-s 127.0.0.1:5555`.
- Manual steps so far that the setup script must do: install docker.io, adb, linux-modules-extra; modprobe binder_linux; run the redroid container; install Node; copy the app; `npm install --omit=dev`; fetch scrcpy-server; start the backend. None of this survives a reboot yet.

## M2 input results, Sun 4 Oct ~13:00 IST

Server restarted as m7i-flex.large, IP 65.0.108.161 (Mumbai). `/dev/kvm` still present after the type change. Warm start of the existing redroid container: 7 s to `boot_completed`.

Landing test method: events were sent through the page's own handlers (scripted pointer events on the canvas, Chrome on the laptop, devicePixelRatio 1.25), and the device side was read with `adb shell dumpsys input` (section `RecentQueue`, which lists the coordinates Android received).

| Layout of the screen image in the page | Targets (device pixels) | Landed |
|---|---|---|
| 310 x 551 CSS px (default, window 1038 x 650) | (0,0) (719,0) (0,1279) (719,1279) (360,640) | all exact |
| 135 x 240 CSS px | same five | all exact |
| 150 x 267 CSS px, fractional left offset 37.3 | same five | all exact |
| Landscape after rotation, video 1280 x 720 shown at 980 x 551 | (0,0) (1279,719) (640,360) | all exact |

Other checks:

| What | Result |
|---|---|
| Typing `Hello World 123 !@#` then `x` and Backspace into the search box | Field showed `Hello World 123 !@#` (screenshot `spikes/out/m2-typing.png`) |
| Swipe up from (360,1000) to (360,300) | App drawer opened; MOVE events at the sent coordinates (`spikes/out/m2-swipe.png`) |
| Mouse wheel | Three SCROLL events arrived, source mouse, at (359,639) for a request at (360,640): one pixel off, cause not investigated |
| Home button on the page | Returned to the launcher |
| Rotation | Page followed the new video size without a reload (`spikes/out/m2-landscape.png`) |
| Rejected input messages in the backend log | 0 |

### Gotchas found

- `settings put system pointer_location 1` shows an overlay but does not write coordinates to logcat on this image; `dumpsys input` RecentQueue does (last 10 events only).
- A tap on the exact bottom-left corner also produces a BACK key event from the navigation bar. That is the device's behaviour, not a mapping error.
- `user_rotation 1` has no effect while the launcher is in front (it is portrait only); it works with Settings in front.
- After a stop/start of the instance: `modprobe binder_linux ...`, `docker start spike-redroid`, start the backend. Still manual.

## Deployment results, Sun 4 Oct ~14:00 IST

Server: m7i-flex.large, Mumbai, Elastic IP 43.205.158.181, host name `43-205-158-181.sslip.io` (free address-based DNS; the user has no domain).

| What | Result |
|---|---|
| `infra/setup.sh` first run on the existing server | exit 0, no warnings; `linux-modules-extra-aws` installed |
| HTTPS | certificate issued by Caddy for the sslip.io name (TLS-ALPN challenge); `curl` verifies it; HTTP redirects to HTTPS (308) |
| Public page without a code | shows "Access code needed" and the form |
| Wrong code | refused, form stays |
| Right code | "Live" |
| Reboot (`systemctl reboot`), no login afterwards | public `/healthz` answered again after 25 s; the open page went back to "Live" by itself; docker, caddy, android-web active; binder loaded; the backend service started once (no restart loop) |
| Memory after boot with one device | 1.2 GiB used of 7.6 |

Not yet tested: setup.sh on a truly fresh server (this one already had Docker, Node and the image); a second network or a phone; three viewers.

Commands: `sudo SITE_HOST=43-205-158-181.sslip.io bash infra/setup.sh`; access code: `sudo grep ACCESS_CODE /etc/android-web.env`.

## B1 / B2 results (one device per session, on demand), Sun 4 Oct ~14:15 IST

Measured on the m7i-flex.large (2 vCPU, 7.6 GiB), image already pulled:

| What | Value |
|---|---|
| Fresh device container, alone: `docker run` to `boot_completed` | 6.5 s |
| Two fresh devices started at the same time | 15.4 s and 17.0 s |
| Connect to "ready" through the backend (first session / second while the first runs) | 6.3 s / 12.7 s |
| Page: "Start a new session" to "Live" | 7.1 s |
| Memory per device, idle | 600 to 650 MiB (limit set: 2 GiB each) |
| Host memory with 4 devices running | 3.0 GiB used of 7.6 |
| Load average while two devices boot | 7 on 2 vCPU (the server is saturated during boots) |
| Removing 3 devices (`docker rm -f`) | 0.8 s |
| Reconnect with the session token (same device) | 3 ms to "ready" |

`scripts/live-session-test.js` on the server: 16 of 16 checks pass (own device per session; file, setting and app change in A invisible in B; B's device cannot ping A's; unknown token gets a separate device; fourth user gets "busy"; End removes the device; token resumes the same device; device removed 30 s after the viewer vanishes; nothing left at the end).

Crash test: `systemctl kill -s KILL android-web` during a session. The device stayed running as an orphan; systemd restarted the backend, which logged "removed 1 leftover device(s)", and the open page got a new device.

Design facts: container name `android-web-<id>`, label `android-web=session`, Docker network `android-web-net` with inter-container traffic off, ADB on a random 127.0.0.1 port, session token 128-bit random (kept in the tab's sessionStorage; never logged; the id in logs is a hash prefix). Grace 30 s, idle 5 min, max 3, heartbeat ping every 15 s.

Gotchas:
- The backend's user is in the `docker` group, which is equivalent to root on the server.
- Devices run `--privileged` (redroid needs it): weaker isolation than a VM.
- After a backend crash the user's device is gone (new device on reconnect).

## Latency, clipboard and idle timeout, Sun 4 Oct ~14:20 to 15:10 IST

Latency (full report in LATENCY.md): 40 taps, public link, Chrome 154 on the laptop, one session.

| Run | Median | p95 | Min | Max | Round trip | Browser part |
|---|---|---|---|---|---|---|
| 30 fps (deployed) | 165 ms | 191 ms | 141 | 196 | 28 ms | 11 ms |
| 60 fps (not kept) | 150 ms | 181 ms | 124 | 225 | 27 ms | 8 ms |

- 60 fps cost: one device with a moving screen used 189 % CPU (of 200 %). Still screen: under 1 %.
- Idle timeout on the real server: a client that connected and sent nothing was closed with code 4410 "idle" after 5 minutes (log: "session e9ae0cb0 ended: idle"), and no device was left.
- Clipboard: text with Hindi characters pasted from the page arrived in the device's search field (device log: "Device clipboard set", "Search pasted from your clipboard"). A word selected on the device ("ONLY") and copied with Ctrl+C from the page appeared in the page's "Copied on the device" box.
- Live session test re-run on the open site: 16 of 16 pass.

Gotchas:
- `show_touches` draws nothing on redroid with software rendering, so it cannot be used as a visible reaction.
- Browsers slow `requestAnimationFrame` to about one call per second in a window that is not in front. Anything drawn or measured there is misleading. The page now draws each frame when it is decoded.
- `input keycombination 113 29` (Ctrl+A) typed an "a" on this image instead of selecting all.
- On a brand-new device `/sdcard/Download` may not exist yet.
- At backend shutdown the log shows "adb: error: cannot connect to daemon / failed to start daemon" (adb is asked to disconnect while the service is stopping). Harmless so far; not investigated.
- One unexplained disconnect of the AI's test browser (viewer side) during the clipboard test; it did not happen again.

## B4 single-app restriction (Clock), Sun 4 Oct ~15:15 to 15:35 IST

Findings on a throwaway device:

- Clock is `com.android.deskclock/.DeskClock`. Launchable apps on the image: calendar, contacts, deskclock, gallery3d, settings, documentsui, quicksearchbox, webview_shell. Home apps: launcher3, and Settings' FallbackHome.
- `am task lock <taskId>` from the shell starts lock task mode in state PINNED (screen pinning, not the device-owner LOCKED state). In it: Home and Recents keys do nothing, `cmd statusbar expand-notifications` does nothing, `am start` of Settings fails with error 101 (lock task violation).
- `am task lock` prints "Activity manager is not in lockTaskMode" even when it worked; read the state from `dumpsys activity activities | grep mLockTaskModeState`.
- With the other apps disabled (`pm disable-user --user 0 ...`), Clock is the only launchable app; even with the pin removed, Home stays on Clock.
- State check costs about 50 ms; re-applying the pin about 170 ms.
- Clock's "Change date & time" starts `android.settings.DATE_SETTINGS`; with Settings disabled this throws ActivityNotFoundException and Clock crashes. The watchdog reopens it.
- First watchdog version used the focused window and raised a false alarm every second while a Clock menu was open (the menu is its own window). Now uses the resumed activity.

Results: `scripts/live-restriction-test.js` 15 of 15 pass; restricted session ready in about 5 s; switching mode from the page gives a new device in about 5.6 s; `scripts/live-session-test.js` still 16 of 16.

Left in the log at session end: `adb ... forward --remove ... device not found` (the forward is removed after the device is already gone). Harmless, not fixed.
