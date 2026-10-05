# Architecture

```
 Browser page                    Server (one AWS virtual machine)
 ┌──────────────────┐   HTTPS    ┌───────┐    ┌───────────────┐  adb   ┌──────────────────────────┐
 │ canvas           │◄──────────►│ Caddy │◄──►│ Node backend  │◄──────►│ redroid container, one   │
 │ WebCodecs decoder│  WebSocket └───────┘    │ sessions,     │        │ per session: Android 12  │
 │ input handlers   │                         │ relay, checks │        │ + scrcpy-server          │
 └──────────────────┘                         └───────────────┘        └──────────────────────────┘
```

Three parts: a page with no build step, one Node.js process, and one Android container per visitor. Everything in the device and streaming path is open source (table at the end).

## How the code is organised

Both sides are split by feature, not by kind of file. Each feature folder holds its code and its tests; one small file per side does the wiring.

| Feature | Backend (`backend/src/features/`) | Page (`frontend/features/`) |
|---|---|---|
| Video stream | `streaming/`: scrcpy session, stream parser, start-up stages | `stream/`: the player (decoding and drawing), H.264 helpers |
| Input and clipboard | `input/`: validating and encoding control messages, reading device messages | `input/`: pointer, keys, phone keyboard, position mapping, clipboard |
| Sessions | `sessions/`: who has which device, limits, timers | `session/`: the state machine, the connection to the server, the loading screen |
| Devices | `devices/`: containers, adb, the fences around a device | |
| Clock-only mode | `restriction/`: the lock, the input filter, the check | |
| Recording | `recording/`: MP4 writer, recorder, serving and clean-up | `recordings/`: the list of this browser's recordings, and the recording shown when a session ends |
| Latency | (a ping reply in the server) | `latency/`: the probe, the check that runs it, the results panel |
| Access | `access/`: origin check, optional access code, response headers | |

`backend/src/server.js` and `frontend/app.mjs` wire the features together; `backend/src/shared/` holds settings and logging.

## How the screen reaches the browser

1. **Android runs in a container.** [redroid](https://github.com/remote-android/redroid-doc) is Android built to run as a Docker container on the server's own Linux kernel. It needs the kernel's `binder` module and no hardware virtualization. The server has no graphics card, so Android draws in software.
2. **scrcpy-server captures and encodes.** The backend copies [scrcpy](https://github.com/Genymobile/scrcpy)'s server program (v4.1, unmodified) into the device and starts it over adb. It encodes the screen as H.264 with Android's own encoder and writes packets to a local socket, which adb forwards to the backend.
3. **The backend relays.** It parses scrcpy's stream into packets (`backend/src/features/streaming/videoParser.js`) and sends each one to the browser as a binary WebSocket message with a 9-byte header: flags (configuration, key frame) and a timestamp. It does not decode or re-encode video. A viewer that falls more than 4 MB behind is disconnected, and the page reconnects on a fresh key frame, so delay cannot pile up.
4. **The browser decodes.** The page gives each packet to the WebCodecs `VideoDecoder` and draws each decoded frame on a canvas at once. There is no player and no buffer.

Measured from touch to visible reaction: median 165 ms, 95th percentile 191 ms ([LATENCY.md](LATENCY.md)).

## How input reaches the device

The page turns pointer, wheel and key events into small JSON messages, for example `{"t":"touch","a":"down","id":0,"x":360,"y":640}`. Positions are in video pixels: the page converts from the canvas's size on screen to the video's size, so the window size does not matter (`frontend/features/input/pointerMap.mjs`; checked at several sizes and in landscape: exact when the video is the size of the screen, and within 2 device pixels now that the video is sent at 540 x 960).

The backend never passes browser bytes to the device. It validates every field, then builds the binary scrcpy control message itself (`backend/src/features/input/controlMessages.js`) and writes it to scrcpy's control socket. Only touch, scroll, 14 named keys, text, and clipboard get and set can be produced; scrcpy's other commands (start an app, open the notification panel, power) cannot be reached from the browser at all. Input is limited to 1000 messages a second per viewer.

Clipboard uses the same path: paste sends scrcpy's "set clipboard and paste" message; text copied on the device arrives from scrcpy as a device message and is forwarded to the page.

## How isolation is enforced

- **One container per session**, created when the session starts and deleted with all its data when it ends. Nothing is reused between visitors.
- **Session token:** 128 random bits, held by the page. Only that token attaches to that device; an unknown token gets a new device. Logs and container names use a hash of the token, never the token.
- **Network:** all devices sit on a Docker network with traffic between containers switched off. Each device's adb port is published on `127.0.0.1` of the server only.
- **Lifecycle:** a session ends on "End session", 30 seconds after its viewer disappears (a ping every 15 seconds detects dead connections), after 5 minutes without input, or when the backend stops. At start-up the backend deletes any device left by a crash. At most 3 sessions exist; a fourth visitor is told to wait.
- **Tested by** `scripts/live-session-test.js` (16 checks: files, settings and app state do not cross, devices cannot ping each other, cleanup leaves nothing).

**How strong it is:** containers share the server's kernel and redroid needs Docker's privileged mode. That separates visitors from each other in normal use, but it is weaker than one virtual machine per visitor: a kernel or container escape reaches the server. This is the main cost of choosing redroid.

## How restriction is enforced

A session started in Clock-only mode is fenced in three places, none of them in the browser:

1. **On the device:** every other app that can be opened is disabled, and Clock's task is pinned (Android lock task mode), which turns off Home, Recents and the notification shade.
2. **In the backend, per message:** a restricted session may send one-finger touch, scroll, text, clipboard and 12 keys. Home, Recents, a second finger (needed for the unpin gesture) and everything else are dropped.
3. **In the backend, every second:** a check that the device is still pinned on Clock; if not, the pin is applied again.

The mode is stored with the session on the server, so reconnecting cannot change it. The README lists each escape route and its tested result (`scripts/live-restriction-test.js`, 15 checks).

## Recording

The backend already holds every video packet on its way to the browser, so it also writes them into one MP4 file per session, with their timestamps and without re-encoding. The file is fragmented MP4, one small piece per frame, so it plays even if the session is cut off. It is fetched with the session's secret token only.

## Fences around a device

A device is treated as hostile. It cannot open connections to anything: the internet, the server, the private network or the cloud metadata address (host firewall on the device network). Its debugging port accepts the server only, not the device itself. Apps cannot be installed. It has a memory and a CPU limit. One network address can hold two of the three devices. `scripts/live-security-test.js` checks these from inside a device.

## Alternatives considered

| Choice | Alternative | Why rejected |
|---|---|---|
| Device: redroid | Android Emulator in a VM | Needs nested virtualization, heavier and slower to start per session. Kept as the fallback had the server's kernel lacked binder; the first server check showed both were available. |
| | Cuttlefish | Ships its own WebRTC viewer, so the streaming would not be this project's work; longest setup. |
| | Waydroid, Android-x86 | Waydroid expects a desktop session; Android-x86 looked inactive. Neither was tried. |
| | Genymotion, hosted device farms | Paid products; not allowed by the brief. |
| Capture: scrcpy-server | `adb screencap` in a loop | Measured 214 ms per screenshot, about 5 frames a second. |
| Transport: WebSocket | WebRTC | Better on lossy networks, but needs signalling, ICE, TURN and RTP packaging. Too much for the time; latency over WebSocket was acceptable. |
| Decode: WebCodecs | Media Source Extensions with a `<video>` element | Needs an MP4 muxer, and the player buffers, which adds delay. |
| | JPEG frames | Not tried. Every frame is a whole picture, so far more data for the same frame rate. |
| Input: scrcpy control socket | `adb shell input` | 23 ms per call and a new process each time; no multi-touch or clipboard. |
| Restriction: screen pinning plus server checks | Device-owner lock task (kiosk) | Stronger, but needs a device-owner app built and installed; not attempted in the time. |
| Recording: own MP4 writer | ffmpeg as a helper process | Would add a dependency and a process per session. The writer is about 150 lines and uses the stream's own timestamps. |
| One container per session | One shared device, or user profiles on one device | Would not isolate files, settings and apps. |

## Licences

| Component | Role | Licence |
|---|---|---|
| redroid | Android in a container | Apache-2.0 |
| scrcpy-server | Screen capture, encoding, input injection | Apache-2.0 |
| Docker Engine | Containers | Apache-2.0 |
| Node.js, `ws` | Backend, WebSocket library | MIT |
| Caddy | HTTPS | Apache-2.0 |
| Android platform tools (adb) | Talking to the device | Apache-2.0 |

AWS provides only the virtual machine and its address.
