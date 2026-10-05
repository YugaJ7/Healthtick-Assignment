# NOTES

Running list of measurements, commands that worked, gotchas and decisions. Raw material for the write-up. Times in IST.

## Time log

| When | What | Hours |
|---|---|---|
| Sat 3 Oct 13:00 | Assignment received | |
| Sat 3 Oct | Reading the assignment, Phase 0 in claude.ai chat, glossary and checklist | 8 (the author's figure) |
| Sun 4 Oct 00:10 to 03:20 | Research, cloud account, server check, three experiments | ~3 |
| Sun 4 Oct 12:10 to ~17:00 | Live video, input, deployment, one device per session, latency, clipboard, Clock-only mode, reviews | ~5 |
| Sun 4 Oct 17:20 to ~18:00 | Security fences, session recording, write-up | ~0.7 |
| Sun 4 Oct 18:45 to ~20:15 | Redesigned session page, phone layout | ~1.5 |
| Mon 5 Oct 01:45 to ~02:15 | Backend review, crash fix, feature folders | ~0.5 |
| Mon 5 Oct 09:35 to ~12:15 | Deploy and verification, page code split, video tuning, kiosk lock, DuckDNS name, move to the new server | ~2.7 |

These are spans taken from PROCESS_LOG.md, not a stopwatch. The total is the author's to state.

## Measurements

This table was the plan before the first server existed. The values are in the dated sections below; the current figures are collected under the heading Current figures at the end of this file.

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

See the commands listed in the dated sections below. Everything needed to set up a server is now in `infra/setup.sh`.

## Gotchas

- WSL is not usable on the laptop as a local test host: `wsl -l -v` fails with `REGDB_E_CLASSNOTREG`, and redroid on WSL2 needs a rebuilt kernel anyway (redroid-doc deploy/wsl.md).
- No cloud CLIs, Docker, adb or ffmpeg on the laptop. Node 26 and Python 3.14 are present.
- The brief is saved as `Assignment.md`; docs refer to `ASSIGNMENT.md`. Case matters on Linux.
- redroid's example publishes ADB on port 5555. Never publish that publicly; the spikes bind it to 127.0.0.1.
- redroid defaults to 15 fps without a GPU; the spikes ask for 30 and measure what is actually delivered.
- Search summaries were wrong about AWS nested virtualization (said bare metal only). Official docs say C7i / M7i / C8i / M8i and others support it.

## Manual steps done on servers (must end up in the setup script)

All of them ended up in `infra/setup.sh`: packages, the binder and firewall kernel modules, Node.js, the Android image, the app, the settings file, the firewall service, the backend service and Caddy. On 5 Oct the script was run on a brand-new server with nothing done by hand (see the last dated section).

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

- The binder module is not loaded at boot. After a reboot it must be loaded again (needs a `/etc/modules-load.d/` entry in the setup script; not done yet). Done later the same day in `infra/setup.sh`.
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
- After a stop/start of the instance: `modprobe binder_linux ...`, `docker start spike-redroid`, start the backend. Still manual. No longer true after the deployment step below: systemd starts everything.

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

## Security fences and recording, Sun 4 Oct ~17:30 to 17:50 IST

Baseline (old version), from inside a device with `nc`: port 5555 open on 127.0.0.1, own address and ::1; 169.254.169.254:80 open; server SSH (bridge address and private address) open; `pm install` of a copied system APK: Success. `adb shell id` is uid 2000 (shell), not root; `docker exec` is root.

| What | Result |
|---|---|
| `live-security-test.js` on the old version | 10 of 13 checks fail |
| `live-security-test.js` after the fences | 12 of 12 pass, also after a reboot |
| `live-session-test.js`, `live-restriction-test.js` after the fences | 16 of 16, 15 of 15 |
| Device ready, first / second while the first runs | 8.5 s / 11.6 s (1.5 CPU limit, fences) |
| Third session from one address, public link | closed, code 4430 |
| Recording of a 5 s session with two swipes | 760 KB, plays in Chrome, 720 x 1280 |
| Recordings of the live tests | 0.8 to 1.5 MB each |

Gotchas:
- `pm set-user-restriction` over adb fails (needs MANAGE_USERS); as root via `docker exec <name> /system/bin/pm ...` it works.
- Android's `iptables -w -I INPUT -p tcp --dport 5555 ! -i eth0 -j DROP` works inside the redroid container (same for ip6tables). Host modules `iptable_filter` and `ip6table_filter` are loaded by setup.sh.
- Host rules live in chains ANDROID-WEB-FWD (hooked into DOCKER-USER) and ANDROID-WEB-IN (hooked into INPUT), matched on the bridge name `awnet0`.
- The server's resolver is 172.31.0.2 (a private address), so with `DEVICE_INTERNET=on` DNS has to be allowed before the private ranges are dropped. That mode has not been run.
- `curl -s` without `-f` treats an error page as success; the reboot timing probe was fooled by it.

## Redesigned page and phone layout, Sun 4 Oct ~19:00 to 20:15 IST

| What | Result |
|---|---|
| Loading stages seen in the page, new session | 0, 5, 20, 35, 55, 75, 80, 95, 100 % over 10.2 s (85 % passes too fast to see) |
| Page reload during a session | same device back in about 1 s |
| Tap positions at 379 x 674 and 231 x 411 CSS px | all exact (video was 720 x 1280 then) |
| Latency check in Clock-only mode, three runs | median 153, 154, 150 ms |
| Device deleted during boot | error screen after 2.7 s (90 s before the backend checked that the container still runs) |
| Backend restarted during a session | "Reconnecting", then ended with "the session has expired" and the recording |
| Phone emulation 390 x 844 | device 374 x 664, no sideways scrolling |

What Android shows during a boot, sampled every 0.2 s on a throwaway device: zygote and surfaceflinger running at 1.1 s; `service.bootanim.exit=0` at 1.6 s; `sys.system_server.start_count=1` at 2.2 s; `sys.boot_completed=1` at 6.9 s.

Gotchas:
- This image never runs a boot animation (`debug.sf.nobootanimation=1`), so "boot animation running" cannot be a progress stage. `sys.system_server.start_count` is used instead.
- A Clock-only session accepts touch slot 0 only, so the latency probe must use slot 0.
- Sliding the finger off the Back button before lifting it cancels the press; the latency check no longer sends 40 Back presses.
- Touch positions sent to the server are in video pixels, not device pixels.
- Overriding and then deleting `window.innerHeight` in a test breaks the page's sizing until a reload; that was the test, not the page.
- The browser test tool cannot resize a maximised window.

## Backend crash, feature folders, page split, Mon 5 Oct ~01:45 and ~09:35 IST

- `new URL(target, base)` throws for request targets that are not addresses: `//`, `http://[`, `//x:99999/`. Inside the HTTP handler that killed the whole backend. On the live site `curl --path-as-is https://HOST//` returned 502. Fixed: such requests get 400.
- `node --test` with two quoted patterns (`"src/**/*.test.js" "../frontend/**/*.test.mjs"`) runs the tests of both trees; needs Node 22 or newer.
- After moving files, 114 tests ran, the same number as before: the quickest proof that none was lost.
- The page's module tree can be checked without a browser by fetching `/app.mjs` and following every `from './...'` over HTTP.
- `frontend/app.mjs` went from 531 to 295 lines; six feature modules took the rest.
- The laptop's public address changed overnight, so SSH (open to "My IP" only) timed out until the rule was updated in the console.

## Video tuning, Mon 5 Oct ~10:25 IST

Two runs of 40 taps per setting, Clock-only mode; frame rate and `docker stats` while Clock's stopwatch ran.

| Setting | Median | 95th percentile | Frames/s | Device CPU |
|---|---|---|---|---|
| 720 x 1280, 2 Mbit/s | 150 / 135 ms | 176 / 160 ms | 30 | 112 to 114 % |
| 540 x 960, 2 Mbit/s (kept, now the default) | 132 / 131 ms | 151 / 153 ms | 30 | 89 to 95 % |
| 540 x 960 + `priority=0,latency=1` | 133 / 129 ms | 162 / 145 ms | 30 | 92 to 97 % |
| 540 x 960, 1 Mbit/s | 130 / 132 ms | 148 / 150 ms | 30 | 88 to 91 % |

Gotchas:
- Run-to-run variation is about 15 ms, so only a difference seen in both runs counts.
- With the smaller video a touch lands on the nearest video pixel (1.33 device pixels): (719,1279) arrives as (718,1278).
- The Clock-only live test had positions written for 720 x 1280; with a smaller video they would have been rejected and the checks would have passed without testing anything. The test now scales them.
- scrcpy accepts `video_codec_options` silently; whether the software encoder uses them is unknown.

## Kiosk lock (LOCKED lock-task state), Mon 5 Oct ~10:50 IST

- `am task lock <id>` from the shell always gives PINNED, even when the app is on the allow-list.
- LOCKED needs the app on Android's lock-task allow-list and a start with `am start --lock-task -n <package>/<activity>`.
- The allow-list call as root: `service call activity_task 32 i32 0 i32 1 s16 com.android.deskclock` (user 0, an array of one string). 32 is `TRANSACTION_updateLockTaskPackages` in `IActivityTaskManager` on this Android 12 image; the same name in `IActivityManager` is 172.
- The numbers were read on the device: `/apex/com.android.art/bin/dexdump /system/framework/framework.jar` (dexdump is not on the path), then the class descriptor and the `value` line of the constant.
- In LOCKED: Home key, Recents key, starting Settings (error 101), the notification shade and five Back presses all leave Clock in front; `am task lock stop` does nothing; the navigation bar shows Back only; no unpin hint.
- The lock ends when the app's task ends (`am force-stop`), so the once-a-second check repairs by stopping and restarting the app with `--lock-task`.
- SELinux is disabled inside the redroid container (`getenforce`: Disabled).
- Results: restriction live test 16 of 16; latency check still works (median 127 ms in one run).

## DuckDNS name and the move to a new server, Mon 5 Oct ~11:30 to 12:15 IST

New server: m7i-flex.large, Mumbai, Ubuntu 24.04.4, kernel 6.17.0-1017-aws, Elastic IP 13.126.173.153, key `healthtick.pem`. Public name `yuga-android.duckdns.org`.

| What | Result |
|---|---|
| `infra/setup.sh` on the brand-new server | exit 0 after 82 s, first run |
| Live tests straight after | 16, 16 and 12 pass |
| Device ready, first / second while the first runs | 9.3 s / 11.8 s |
| Certificate for the DuckDNS name | issued within seconds of Caddy starting with that name |
| Session through the public name | all stages, video after 10.5 s |
| Reboot | public link answered 33 s after the reboot command |

Gotchas:
- Caddy takes several names in one site block (`name1, name2 {`), so the setup script's host setting can hold a comma-separated list.
- Point the DNS name at a server only after that server serves the name; in between, the public link has no valid certificate.
- Ubuntu's automatic updates can hold the package lock when the setup script runs (exit code 100 at the Caddy step once). Every `apt-get` in the script now waits for the lock (`-o DPkg::Lock::Timeout=300`).
- A live test started while the backend is restarting aborts with "device not ready in time"; wait a few seconds after a deploy.
- Recordings and the browser's list of them belong to the name the page was opened on, and to the server: they do not move.

## Current figures (as of Mon 5 Oct, 12:15 IST)

| What | Value | Where measured |
|---|---|---|
| Touch to visible reaction | median 132 / 131 ms, 95th percentile 151 / 153 ms | two runs of 40 taps, video 540 x 960, earlier server |
| Frame rate | 30 per second while the screen changes, 0 when it is still | page counter |
| CPU of one device with a moving screen | 89 to 95 % of one CPU | `docker stats` |
| Memory per device, idle | about 600 MB | earlier server |
| Opening the link to live video | about 10 s | page and script client |
| Server reboot to public link answering | 33 s | current server |
| Setup script on a new server | 82 s | current server |
| Unit tests | 114 pass | laptop |
| Live tests | session 16, restriction 16, security 12 | current server |
