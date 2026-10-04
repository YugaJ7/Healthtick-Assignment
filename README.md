# Android in the browser

A real Android device, running on a server, that you watch and control from a web page. Each visitor gets their own device, created when they arrive and deleted when they leave.

**Live: https://43-205-158-181.sslip.io**

No sign-in and nothing to install. Use a current Chrome or Edge on a computer (see [Browsers](#browsers)).

## What you can do

| Feature | How to try it |
|---|---|
| Live screen | Open the link. The status goes from "Starting your Android device" to "Live" in about 9 seconds. |
| Tap, long-press, swipe | Use the mouse or a finger on the screen image. Drags keep working if the pointer leaves the image. |
| Scroll | Mouse wheel over the screen image. |
| Type | Click the screen image, then type. Enter, Backspace, Delete, Tab and the arrow keys work. |
| Back, Home, Recents | Buttons under the screen. Right-click and Esc also send Back. |
| Any window size, rotation | Resize the window or rotate an app; touches keep landing where you point. |
| Clipboard, computer to device | Tap a text field on the device, then press **Paste into device**, or click the screen and press Ctrl+V. |
| Clipboard, device to computer | Select text on the device and copy it (or press Ctrl+C with the screen focused). It appears under "Copied on the device"; press **Copy** if the browser did not copy it by itself. |
| Your own device | Open the link in a second browser window: it gets a different device. Files, settings and apps are not shared. |
| One app only | Press **Switch to Clock only** (or open the link with `?mode=restricted`). You get a new device locked to the Clock app; see [Clock-only mode](#clock-only-mode). |
| End a session | **End session** deletes the device at once. Closing the tab deletes it after 30 seconds. Five minutes without input also ends it. |
| Session recording | Every session is recorded. After **End session** the recording plays under the message, with a download link. **Recordings of your sessions** lists this browser's sessions of the last 24 hours, each with Watch and Download. |
| Latency test | Open **Latency test** and press **Run 40 taps** with the device on its home screen. |

## Hosting and limits

| | |
|---|---|
| Provider | Amazon Web Services, EC2 (a plain virtual machine; no device-streaming service is used) |
| Region | Mumbai (ap-south-1) |
| Machine | m7i-flex.large: 2 vCPU, 8 GB memory, 30 GB disk, Ubuntu 24.04 |
| Address | Elastic IP 43.205.158.181; the host name comes from sslip.io, a free service that maps `43-205-158-181.sslip.io` to that address |
| HTTPS | Caddy, with an automatic Let's Encrypt certificate |
| Sessions at once | 3. A fourth visitor sees "All devices are in use" and the page retries by itself. |
| Idle timeout | 5 minutes without input |
| After the tab closes | The device is kept for 30 seconds (so a reload or a network drop keeps your device), then deleted |
| Sessions per network address | 2. A third from the same address is told so and the page retries. People behind one office address share this limit. |
| Device | Android 12 (redroid), 720 x 1280, 30 frames per second, software rendering, 2 GB memory and 1.5 CPU limit |
| Device network | None. Devices cannot reach the internet, the server or anything else, so the browser app on a device loads no pages. `DEVICE_INTERNET=on` in the settings file is meant to allow the public internet only; that setting has not been run. |
| Recordings | Kept 24 hours, at most 200 MB each and 2 GB in total (oldest deleted first) |
| Speed | Starting a device uses most of both CPUs for a few seconds, so three people starting at once will wait longer (two devices started together took about 16 s each). |

The site is open to everyone on purpose. An optional access code exists (`ACCESS_CODE` in `/etc/android-web.env`) and is switched off.

## How it works

```
browser page  <-- HTTPS / WebSocket -->  Caddy  -->  Node backend  -- adb -->  one redroid container per session
   canvas + WebCodecs                                 (relay, checks)            (Android 12 + scrcpy-server)
```

- **Screen to browser:** [scrcpy-server](https://github.com/Genymobile/scrcpy) runs inside the device and encodes the screen as H.264. The backend reads that stream and forwards each video packet over a WebSocket. The page decodes it with the browser's WebCodecs API and draws it on a canvas.
- **Input to device:** the page sends small JSON messages ("touch down at x, y", "key Back", "paste this text"). The backend checks every field and builds the scrcpy control message itself, so the browser cannot send arbitrary commands to the device.
- **One device per user:** each session is its own [redroid](https://github.com/remote-android/redroid-doc) container on a Docker network where containers cannot reach each other.

Everything in the device and streaming path is open source: redroid (Apache-2.0), scrcpy-server (Apache-2.0), Docker, Node.js, the `ws` library (MIT), Caddy (Apache-2.0).

## Session recording

Each session's video is saved on the server as one MP4 file, automatically, from the first frame to the end of the session. It is the device's own H.264 stream written into the file with its timestamps (`backend/src/mp4.js`, `backend/src/recorder.js`); nothing is re-encoded. A page reload or reconnect continues the same file.

- **Tied to its session:** the file is named after the session's id, and `GET /recording?session=<token>` hands it out only for that session's secret token. The token stops controlling anything when the session ends; after that it only opens the recording.
- **Play back or download:** on the page after **End session**, or later from **Recordings of your sessions** (kept in this browser's local storage). A session that ended because the tab was closed is in that list too.
- **Kept for** 24 hours. A recording stops at 200 MB, and the oldest are deleted when the folder passes 2 GB.
- **Tested:** unit tests for the file writer and recorder; on the live server a recorded session played in Chrome with the right size (720 x 1280), seeking worked, and an unknown token got "not found".
- **Limits:** video only. If the screen is rotated during a session, the file header still states the first size (not tested in a player). A recording cannot be opened from another browser or computer, because only this browser knows the token.

## Clock-only mode

A session can be started in a restricted mode in which the device runs the Clock app and nothing else. The mode is chosen when the session is created and is stored on the server; reconnecting cannot change it.

**Why Clock:** it comes with the Android image, works without an account or network, has real things to do (alarms, timers, a stopwatch, a text field for alarm labels), and has only one link out to another app.

**Actions allowed:** one-finger touch, scroll, typing, paste and copy, and the keys Back, Enter, Backspace, Delete, Tab, Escape, arrows, Home/End of line. Nothing else is passed to the device.

**How it is enforced** (none of it in the browser):

1. **On the device:** every other app that can be opened is disabled, and the Clock task is pinned with Android's lock task mode.
2. **On the server, per message:** a restricted session's input is checked against the list above and anything else is dropped.
3. **On the server, every second:** a check that the device is still pinned on Clock. If not, the pin is applied again.

| Way out | What stops it | Tested result |
|---|---|---|
| Home or Recents key sent to the server | Not on the allowed key list; dropped by the server | Stayed on Clock |
| Other key names, made-up message types, raw scrcpy bytes sent over the WebSocket | The server only builds device commands from its own fixed list; binary frames are refused | Stayed on Clock |
| Tapping Home or Recents on the device screen | Lock task mode disables them | Stayed on Clock |
| Swiping down for notifications or quick settings | Lock task mode disables the shade | Stayed on Clock |
| The unpin gesture (Back and Recents held together) | Needs two fingers; the server passes one finger only | Stayed on Clock |
| Pressing Back until the app closes | No other app exists to go to; the watchdog reopens Clock | Stayed on Clock |
| Clock's own "Change date & time" link into Settings | Settings is disabled, so the link fails; Clock crashes and is reopened by the watchdog | Back on Clock's main screen after about a second |
| Starting another app on the device | Other apps are disabled; lock task mode refuses new tasks | Refused |
| Reconnecting and asking for an unrestricted session with the same token | The mode belongs to the session on the server | Still restricted |
| The pin being removed by some route not listed here | The server's check re-applies it | Re-pinned within 3 s |
| Power menu, share sheets, keyboard shortcuts | There is no power key or modifier-key input in the allowed list; Clock has no share action | Not tested individually |

All but the "Change date & time" row are checked by `scripts/live-restriction-test.js` (15 checks); that row was tried by hand through the page.

**Weak points:** the pin is Android's "screen pinning", not the stronger device-owner lock, so the single-finger rule and the server's check are what stop the unpin gesture. The "Change date & time" link is closed by letting Clock crash, which is ugly. A new escape inside Clock that keeps Clock in front (there is none known) would not be seen by the check.

## Set up your own server

Tested on AWS with Ubuntu Server 24.04 (x86-64). The kernel must be able to load the `binder_linux` module; `scripts/feasibility-check.sh` reports whether a server can.

1. Create a virtual machine: 2 or more vCPUs, 8 GB memory, 30 GB disk, Ubuntu 24.04 x86-64.
2. Open ports 80 and 443 to everyone and port 22 to yourself.
3. Give it a fixed public address and a host name that points to it. Without a domain, use `A-B-C-D.sslip.io` for the address `A.B.C.D`.
4. On the server:

   ```bash
   git clone https://github.com/YugaJ7/Healthtick-Assignment.git
   cd Healthtick-Assignment
   sudo SITE_HOST=A-B-C-D.sslip.io bash infra/setup.sh
   ```

5. Open `https://A-B-C-D.sslip.io/`.

The script installs Docker, adb and the kernel module package, loads binder now and at every boot, installs Node.js 22, pulls the Android image, copies the app to `/opt/android-web`, installs a systemd service that restarts on failure and at boot, and configures Caddy for HTTPS. It can be run again safely.

Settings live in `/etc/android-web.env` (`MAX_SESSIONS`, `MAX_SESSIONS_PER_ADDRESS`, `DEVICE_CPUS`, `DEVICE_INTERNET`, `SESSION_IDLE_MS`, `SESSION_GRACE_MS`, `ACCESS_CODE`, `DEVICE_FPS`, `VIDEO_BIT_RATE`, ...); restart with `sudo systemctl restart android-web`. Logs: `sudo journalctl -u android-web -f`. Health: `curl -s http://127.0.0.1:8080/healthz`.

**Not yet proven:** the script has run several times on one server that already had Docker, Node.js and the Android image from earlier manual work. It has not been run on a brand-new server.

## Tests

```bash
cd backend && npm install && npm test
```

95 unit tests: the scrcpy video and device-message parsers, the control-message encoder (checked against scrcpy's own test vectors), position mapping at several window sizes, session rules (limit, limit per address, grace time, idle timeout, fixed mode), the restricted-mode input list, the response headers, the MP4 writer and recorder, and the latency statistics. They need no device.

On the server, live tests open real sessions. Run them when nobody else is using the site:

```bash
# isolation between users and cleanup of devices (16 checks)
sudo /opt/node/bin/node /opt/android-web/scripts/live-session-test.js
# attempts to leave the Clock app in a restricted session (15 checks)
sudo /opt/node/bin/node /opt/android-web/scripts/live-restriction-test.js
# what a hostile app on a device could reach: debugging port, server, metadata address, app install
sudo /opt/node/bin/node /opt/android-web/scripts/live-security-test.js
```

## Security fences

A security review of the finished system found a path from an anonymous visitor towards the server: install an app on a full device, connect from it to the device's own debugging port (no authentication), and work from that shell inside a privileged container. Running the test below against the old version confirmed each step was open: the port answered from inside the device, an app install succeeded, and the device could reach the AWS metadata address and the server's SSH port. These fences were added:

| Fence | Where |
|---|---|
| The device's debugging port accepts connections from the server only, not from the device itself | `backend/src/hardening.js` |
| Visitors cannot install apps on a device | `backend/src/hardening.js` |
| Devices cannot reach the server, the private network, the cloud metadata address or the internet | `infra/device-firewall.sh` |
| One network address can hold at most 2 of the 3 devices (`MAX_SESSIONS_PER_ADDRESS`) | `backend/src/sessionManager.js` |
| Each device is limited to 1.5 CPUs (`DEVICE_CPUS`) | `backend/src/deviceManager.js` |
| The page loads scripts and styles from this site only (content security policy) | `backend/src/access.js` |

**Status:** all of these were tested on the live server on 4 Oct. `scripts/live-security-test.js` passes 12 of 12 checks (against the version before the fences, 10 of its 13 checks failed), the per-address limit refused a third session through the public address, and the fences were still in place after a reboot. One thing found on the way: the debugging shell runs as Android's `shell` user, not as root, so the original path was less direct than the review assumed.

## Measured

- **Latency:** median 165 ms, 95th percentile 191 ms from touch to visible reaction, 40 taps. Method, conditions and all samples are in [docs/LATENCY.md](docs/LATENCY.md).
- **Device start:** 8.5 s from request to ready with the CPU limit and fences in place (one measurement); before them it was 6.5 s for a new device and about 7 s from "Start a new session" to live video.
- **Memory:** about 600 MB per device.
- **Reboot:** the site answered again 25 s after a server reboot, with no one logging in.

Raw numbers and the commands behind them are in [docs/notes/NOTES.md](docs/notes/NOTES.md).

## Browsers

The page needs WebCodecs, which browsers only provide on HTTPS (or localhost).

- **Tested:** Chrome 154 on Windows 11.
- **Not tested:** Firefox, Safari, Edge, and any phone browser. They may work.
- **Known gap:** on a phone or tablet you can touch the device, but you cannot type, because the page does not open the on-screen keyboard.

## Known limits

- Input from a real touch screen and multi-touch gestures have not been tested.
- Three sessions at once have been started but not used actively at the same time.
- The mouse wheel lands one pixel off the pointer position.
- After a backend crash, sessions are not restored: you get a new device.
- The device containers run in Docker's privileged mode, which redroid requires. That is a weaker boundary than a virtual machine per user.
- The backend's Linux user can control Docker, which is equivalent to administrator access on the server.

## Repository layout

| Path | Contents |
|---|---|
| `backend/` | Node.js server: sessions, device containers, scrcpy relay, input checks, tests |
| `frontend/` | The page: video decoding, input, clipboard, latency test (plain JavaScript, no build step) |
| `infra/` | `setup.sh`, the device firewall and the systemd services |
| `scripts/` | Server feasibility check, scrcpy-server download, live tests |
| `spikes/` | Throwaway experiments from before the build; the app does not use them |
| `docs/DEMO_SCRIPT.md` | Script for the demo video |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the screen, input, isolation and restriction work; alternatives rejected |
| [`docs/WRITEUP.md`](docs/WRITEUP.md) | What went wrong, what I would do with more time, my decisions and where the AI was wrong |
| [`docs/LATENCY.md`](docs/LATENCY.md) | Latency method and results |
| `docs/notes/` | `RESEARCH.md` (research before the build) and `NOTES.md` (raw measurements, commands, gotchas) |
| `docs/brief/` | The assignment text, the requirements checklist, and the planning guide and prompt used to start the work |
| `PROCESS_LOG.md` | Running record of every prompt given to the AI coding agent and what it did |

## AI use

This project was built with AI help. `PROCESS_LOG.md` records each prompt and what the agent did, including mistakes and dead ends, and is never rewritten. The planning conversation before any code was written is here: https://claude.ai/share/988c2267-6180-4f64-8189-6066981632d5

## Time spent

Assignment received Sat 3 Oct 2026, 13:00 IST. Times below come from the process log.

| When (IST) | Work |
|---|---|
| Sat 3 Oct | Reading the assignment, planning conversation, glossary and checklist: 8 hours |
| Sun 4 Oct, 00:10 to 03:20 | Research, cloud account, server check, three experiments |
| Sun 4 Oct, 12:10 to about 17:00 | Live video, input, deployment, one device per session, latency, clipboard, Clock-only mode, reviews |
| Sun 4 Oct, 17:20 to about 18:00 | Security fences, session recording, write-up |

Total so far: to be filled in by the author before submission.
