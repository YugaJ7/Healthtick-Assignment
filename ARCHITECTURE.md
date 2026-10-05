# Architecture

```
 Browser page                    Server (one AWS virtual machine)
 ┌──────────────────┐   HTTPS    ┌───────┐    ┌───────────────┐  adb   ┌──────────────────────────┐
 │ canvas           │◄──────────►│ Caddy │◄──►│ Node backend  │◄──────►│ redroid container, one   │
 │ WebCodecs decoder│  WebSocket └───────┘    │ sessions,     │        │ per session: Android 12  │
 │ input handlers   │                         │ relay, checks │        │ + scrcpy-server          │
 └──────────────────┘                         └───────────────┘        └──────────────────────────┘
```

Three parts: a page with no build step, one Node.js process, and one Android container per visitor. Both sides are split by feature (`backend/src/features/`, `frontend/features/`); `backend/src/server.js` and `frontend/app.mjs` only wire the features together.

## How the screen reaches the browser

1. **Android runs in a container.** [redroid](https://github.com/remote-android/redroid-doc) is Android built to run as a Docker container on the server's own Linux kernel. It needs the kernel's `binder` module and no hardware virtualization. The server has no graphics card, so Android draws in software.
2. **scrcpy-server captures and encodes.** The backend copies [scrcpy](https://github.com/Genymobile/scrcpy)'s server program (v4.1, unmodified) into the device and starts it over adb. It encodes the screen as H.264 with Android's own encoder: 540 x 960 (three quarters of the 720 x 1280 screen), 30 frames per second, 2 Mbit/s.
3. **The backend relays.** It parses scrcpy's stream into packets (`backend/src/features/streaming/videoParser.js`) and sends each one as a binary WebSocket message with a 9-byte header: flags (configuration, key frame) and a timestamp. It never decodes or re-encodes. A viewer that falls more than 4 MB behind is disconnected and reconnects on a fresh key frame, so delay cannot pile up.
4. **The browser decodes.** The WebCodecs `VideoDecoder` decodes each packet and the frame is drawn on a canvas at once. There is no player and no buffer.

Touch to visible reaction on the deployed server: a median of 132 and 153 ms in two runs of 40 taps ([LATENCY.md](LATENCY.md)).

## How input reaches the device

The page turns pointer, wheel and key events into small JSON messages, for example `{"t":"touch","a":"down","id":0,"x":270,"y":480}`. Positions are in video pixels, computed from the canvas's size on screen (`frontend/features/input/pointerMap.mjs`), so the window size does not matter. Checked at several sizes and in landscape: exact while the video was full size, within 2 device pixels at 540 x 960.

The backend never passes browser bytes to the device. It validates every field, then builds the binary scrcpy control message itself (`backend/src/features/input/controlMessages.js`). Only touch, scroll, 14 named keys, text, and clipboard get and set can be produced; scrcpy's other commands (start an app, open the notification panel, power) cannot be reached from the browser at all. Input is limited to 1000 messages a second per viewer. The clipboard uses the same path: paste is scrcpy's "set clipboard and paste" message, and text copied on the device comes back as a device message.

## How isolation is enforced

- **One container per session**, created when the session starts and deleted with all its data when it ends. Nothing is reused between visitors.
- **Session token:** 128 random bits, held by the page. Only that token attaches to that device. Logs and container names use a hash of the token, never the token.
- **Network:** devices sit on a Docker network with traffic between containers switched off, and each device's adb port is published on the server's 127.0.0.1 only. A host firewall keeps devices from reaching the server, the private network, the cloud metadata address and the internet.
- **Inside each device:** its debugging port answers the server only, apps cannot be installed, and it has a memory and a CPU limit.
- **Lifecycle:** a session ends on "End session", 30 seconds after its viewer disappears (a ping every 15 seconds detects dead connections), after 5 minutes without input, or when the backend stops. At start-up the backend deletes any device left by a crash. At most 3 sessions exist, 2 per network address.
- **Tested by** `scripts/live-session-test.js` (16 checks: files, settings and app state do not cross, devices cannot reach each other, cleanup leaves nothing) and `scripts/live-security-test.js` (12 checks from inside a device).

**How strong it is:** containers share the server's kernel, and redroid needs Docker's privileged mode. That separates visitors from each other in normal use, but it is weaker than one virtual machine per visitor: a kernel or container escape reaches the server. This is the main cost of choosing redroid.

## How restriction is enforced

A Clock-only session is fenced in three places, none of them in the browser:

1. **On the device:** every other app that can be opened is disabled, and Clock runs in Android's lock task mode in its LOCKED state (the kiosk state), which turns off Home, Recents and the notification shade and has no gesture that ends it. The server puts Clock on Android's lock-task allow-list itself, as root, so no device-owner app is needed.
2. **In the backend, per message:** one-finger touch, scroll, text, clipboard and 12 keys. Home, Recents, a second finger and everything else are dropped.
3. **In the backend, every second:** a check that the device is still locked on Clock; if not, Clock is restarted locked.

The mode is stored with the session on the server, so reconnecting cannot change it. The README lists each escape route and its tested result (`scripts/live-restriction-test.js`, 16 checks).

## Recording

The backend already holds every video packet on its way to the browser, so it also writes them into one fragmented MP4 file per session, with their timestamps and without re-encoding. One small piece per frame means a recording that is cut off still plays. It is fetched with the session's secret token only.

## Alternatives considered

| Choice | Alternative | Why rejected |
|---|---|---|
| Device: redroid | Android Emulator in a VM | Needs nested virtualization; heavier and slower to start per session. Kept as the fallback in case the kernel lacked binder; it did not. |
| | Cuttlefish | Ships its own WebRTC viewer, so the streaming would not be this project's work; longest setup. |
| | Waydroid, Android-x86 | Waydroid expects a desktop session; Android-x86 looked inactive. Neither was tried. |
| | Genymotion, device farms | Paid products; not allowed by the brief. |
| Capture: scrcpy-server | `adb screencap` in a loop | Measured 214 ms per screenshot, about 5 frames a second. |
| Transport: WebSocket | WebRTC | Better on lossy networks, but needs signalling, ICE, TURN and RTP packaging; latency over WebSocket was acceptable. |
| Decode: WebCodecs | Media Source Extensions with a `<video>` element | Needs an MP4 muxer, and the player buffers, which adds delay. |
| | JPEG frames | Not tried. Every frame is a whole picture: far more data for the same frame rate. |
| Input: scrcpy control socket | `adb shell input` | 23 ms and a new process per call; no multi-touch or clipboard. |
| Restriction: LOCKED lock-task state, set up by the server as root | Screen pinning | Used first. It has an unpin gesture, which only the server's one-finger rule stopped. |
| | A device-owner app that requests the lock | The standard way, but an app to build, sign and install on every device; the same state was reached without one. |
| Recording: own MP4 writer | ffmpeg as a helper process | Another dependency and a process per session; the writer is about 150 lines. |
| One container per session | One shared device, or user profiles on one device | Would not isolate files, settings and apps. |

## Licences

Everything in the device and streaming path is open source: redroid, scrcpy-server, Docker Engine, Caddy and the Android platform tools (adb) under Apache-2.0; Node.js and the `ws` library under MIT. AWS provides only the virtual machine and its address.
