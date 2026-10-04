# Phase 0: Assignment walkthrough and glossary

Source: `ASSIGNMENT.md` (Real-Time Android Device in the Browser). This was written before any research or code. Anything marked *(verify)* is a claim to check against official docs in Phase 1.

Each part of the brief is broken down into four headings. **Asks** is what it literally says. **Testing** is what the evaluator is probably checking. **Good / Bad** describes what each looks like. **Traps** covers ambiguities and easy mistakes. Sentences that make the same point are grouped.

---

## The short version

You are building a small "cloud phone". Android runs on a server, its screen is encoded as video and pushed to a browser, and the browser's mouse and keyboard events travel back and are injected into Android.

The rubric, translated:

| Area | Weight | What it really rewards |
|---|---|---|
| Core | 30% | Works **on the deployed link**, accurately, without falling over while they test |
| Bonuses | 25% | One or two bonuses that survive someone trying to break them |
| Problem solving + AI use | 25% | Your record: what you tried, what failed, what you decided, what you checked |
| Engineering quality | 10% | Structure, error handling, **cleaning up instances** |
| Communication | 10% | Clear write-up and demo, and honest trade-offs (latency vs quality, isolation strength) |

The process (25%) is worth as much as all the bonuses combined. A core that is reliable, measured and honestly documented, plus one solid pair of bonuses, beats a sprawling system that half works.

---

## 1. Header table

**Deadline: 72 hours from receipt**
- **Testing:** planning under pressure, and whether you kill the biggest risk first.
- **Good:**
  - Hosting is settled in the first few hours, including whether Android boots on that server.
  - The core works by roughly the halfway mark.
  - The last ~12 hours go to deployment hardening, the video and the write-up.
- **Trap:** there are nine deliverables. Leaving the docs and the video for the final night is the classic failure.

**What you build / What you submit**
- **Asks:** a live device with touch and keyboard. You submit a repo, a link, a video, a write-up and an AI record.
- **Trap:** the video must show the *deployed* version. The server has to be stable before you record, not just at submission.

**Constraints: the core must be free/open source; hosting can be anything**
- **Testing:** whether you can tell generic infrastructure apart from someone else's product doing the job.
- **Good:** every component is named with its licence in the write-up.
- **Bad:** a commercial device cloud, a paid emulator or a streaming SDK, even "just for the demo".
- **Trap:** some Android tools are free for personal use but paid for commercial or cloud use. Check licences in Phase 1 rather than assuming. *(verify)*

**Questions: email Rohit**
- **Testing:** whether you ask when something is genuinely ambiguous. A short, specific question sent early reads well. See "Ambiguities worth asking about" at the end.

---

## 2. Overview

**"Build a web application that shows a live, interactive Android device… operates it with mouse and keyboard as if it were a physical phone."**
- **Asks:** the full loop: screen out, input in.
- **Testing:** end-to-end systems thinking across OS virtualization, video encoding, network transport, browser decoding and input mapping.
- **Good:** it feels like a phone. Scrolling is smooth, typing works and Back works.
- **Bad:** a slideshow of screenshots, or taps that land off-target.

**"This is an open-ended problem… research, try things, hit walls, break your setup… keep notes on what you tried and what failed."**
- **Testing:** they literally want your failures. These feed the "What went wrong" section and the AI record, which are part of the 25%.
- **Good:** dated notes with the real error text and what fixed it.
- **Bad:** a log with only successes. It reads as hidden or invented.
- **Trap:** you forget details within hours. Write them down as they happen, in `NOTES.md`.

**"You choose the tools… must be free or open-source… no paid product that provides the core functionality… Justify your choices."**
- **Testing:** research quality.
- **Good:** "chose X over Y because of measured Z", with sources. The alternatives should be ones you actually looked at, ideally ones you tried.
- **Bad:** "X is the industry standard."

**"Hosting is separate… paid plans fine… you do not need to keep hosting costs at zero."**
- **Testing:** this is a hint. Android needs real CPU and RAM, and possibly hardware virtualization. They expect you might pay for a bigger VM.
- **Trap:** the cheapest VMs often lack what Android needs. Verify on an hourly-billed VM before committing to anything long-running.

---

## 3. Core requirements

### C1: "displays the live screen… updating continuously without a manual refresh"
- **Testing:** a real stream. Screenshots on a timer technically "update", but they are slow and heavy.
- **Good:** continuous video that reconnects by itself after a network blip, without a page reload.
- **Bad:** a black screen after reconnecting, or a reload needed after any hiccup.
- **Traps:**
  - A video decoder cannot start mid-stream. It needs the codec configuration and then a keyframe. Until one arrives, reconnects and late joins show black or garbage.
  - When the Android screen is static, the encoder may send very few frames. Don't treat "no frames" as "frozen".

### C2: "tap, swipe, scroll, and type… input must land at the correct position regardless of browser window size"
- **Testing:** coordinate mapping. This is the most common bug in this kind of project.
- **Good:**
  - Clicks are mapped from the rectangle where the *picture* is drawn, not the element's box, to device pixels.
  - Mapping stays correct after a resize, on a phone browser, with letterboxing and after rotation.
  - Swipes send many move events along a smooth path, not a jump from start to end.
  - The scroll wheel scrolls.
  - Typing handles characters (capitals, symbols, digits) and special keys (Enter, Backspace, arrows, Back).
- **Bad:** it only works at the window size you developed at, it is off by the width of the black bars, or it drops characters.
- **Traps:**
  1. **Letterboxing.** A tall phone screen inside a wide box leaves black bars, so the element is bigger than the picture. Ignore clicks on the bars instead of stretching them onto the screen.
  2. **Two kinds of pixel.** A canvas has an internal size (`canvas.width`) and an on-page size (`getBoundingClientRect()`). Mixing them gives errors that scale with `devicePixelRatio`. Pick one coordinate space and convert once.
  3. **Rotation** changes the frame size. Stale dimensions mean wrong mapping.
  4. **Downscaled video.** If you stream at a lower resolution to cut latency, map to *device* coordinates, not video coordinates. Alternatively, let the server do the scaling.
  5. **Mobile browsers** scroll or zoom the page on touch unless you stop them.

### C3: "feels responsive. Measure the delay… describe how you measured it, and report the numbers."
- **Testing:** rigour. The method matters as much as the number.
- **Good:**
  - A defined start and end point, for example from "pointer down in the browser" to "first frame showing the change painted on screen".
  - At least 30 trials, reporting median, p95, min and max.
  - Stated conditions: server region, your network, resolution and bitrate.
  - Before and after numbers for any tuning.
- **Bad:** "it feels fast", a single number, or measuring one piece (such as browser-to-server ping) and calling it latency.
- **Traps:**
  - Two machines' clocks are never perfectly in sync. Measure on one clock, the browser's, wherever possible.
  - Server location dominates. A long distance between you and the server can add 100+ ms of round trip before Android does anything. State your network distance, and say that evaluators' numbers will differ.

### C4: "runs on a single machine from documented setup steps that another person can follow"
- **Testing:** reproducibility. Someone may actually follow your README.
- **Good:**
  - One setup script for a fresh server.
  - Prerequisites listed: OS version, kernel features, and a check for whether the host supports them.
  - You re-ran the script on a clean VM.
- **Bad:** "works on my server", with manual steps nobody wrote down.
- **Trap:** things you did by hand while debugging silently become requirements. Examples are loading a kernel module, changing a setting or adding a user to a group. Record them in `NOTES.md` the moment you do them.

### C5: "deployed and reachable through a public link"
- **Testing:** whether you can operate a service.
- **Good:** HTTPS on a domain that works from any network, survives a reboot and shows a clear "busy" message at capacity.
- **Bad:** `http://IP:port`, which breaks the clipboard and other browser features that need HTTPS. Or a link that is down when they test.
- **Trap:** office and campus networks often block unusual ports. Serve everything over port 443, including WebSockets.

---

## 4. Bonus requirements

**"Each bonus is judged on depth and correctness, not on whether it merely exists."**
- **Testing:** they will try to break whatever you build. A shallow bonus scores close to nothing and signals poor scoping.

### B1: Dedicated isolated instance per user
- **Asks:** two simultaneous users each get their own device. Actions, files, settings and installed state must not leak between them.
- **Testing:** real isolation (separate Android data) vs cosmetic isolation (two tabs watching one device).
- **Good:**
  - One Android instance per session, with its own storage.
  - A test where user A installs or changes something and user B cannot see it.
  - Unguessable session tokens, so B cannot attach to A's stream.
- **Bad:** one device with many viewers, shared data volumes, or session IDs like 1, 2, 3.
- **Traps:**
  - Reusing an instance for the next user without wiping it leaks "installed state", which the brief names explicitly.
  - Check whether instance A can reach instance B, or the host's internal ports, over the network.

### B2: Instance on demand
- **Asks:** an instance is created when a session is requested and released at the end or when idle. Nothing is reserved per user in advance, and abandoned sessions must not leak resources.
- **Testing:** lifecycle management. This is the operational heart of the project.
- **Good:**
  - Create the instance on "start".
  - Destroy it on explicit end, tab close, missed heartbeats and idle timeout.
  - A reaper removes leftovers from a crash when the server starts: containers, processes, ports and temp files.
  - A capacity limit with a friendly message.
- **Bad:** relying on the browser's "page closing" event, which often doesn't fire (crashes, mobile, lost network). Or leftovers after a server restart.
- **Traps:**
  - "Abandoned" includes a laptop lid closed with the tab still open.
  - A cold boot can take a long time *(measure in Phase 2)*. A pool of pre-booted, **unassigned** instances is arguably not "reserved per user", but it is a grey area. Ask, or justify it explicitly.

### B3: Two-way clipboard
- **Testing:** both directions, plus an understanding of the browser's security model.
- **Good:**
  - Computer → device: the text arrives in the focused field.
  - Device → computer: copied text can be pasted locally.
  - Clear UI, because reading the clipboard needs permission or a user click.
- **Bad:** one direction only, or it only works on localhost.
- **Traps:**
  - The browser Clipboard API needs HTTPS, and reading needs permission or a user gesture. Chrome, Firefox and Safari behave differently. *(verify)*
  - Non-English text and emoji often break when sent as simulated key presses. Setting the device clipboard and pasting is more robust.

### B4: Restricted access
- **Asks:**
  - The session is limited to one app of your choice and a defined set of actions.
  - The user can't leave the app, open other apps or reach system controls.
  - You justify the blocked list.
  - Enforcement must not rely only on the browser.
- **Testing:** security thinking: a threat model, server-side enforcement and adversarial testing.
- **Good:**
  - An app chosen for a stated reason.
  - An explicit list of escape routes: Home, Recents, notification shade, quick settings, power menu, backing out of the app, links that open other apps, share sheets, settings shortcuts, keyboard shortcuts and long-press menus.
  - Each route blocked on the **device** (OS kiosk features) and on the **server** (filtering control messages).
  - A log of your own attempts to break it.
- **Bad:** hiding buttons in the UI. A user who sends a hand-crafted WebSocket message walks straight out.
- **Traps:**
  - The app itself can open other apps through links, "open with…" or share. A simple app with few outbound paths makes this tractable.
  - Android's strong kiosk mode needs device-owner setup, which has preconditions. *(verify)*

### B5: Session recording
- **Asks:** recording is automatic, can be played or downloaded afterwards, and is tied to its session.
- **Good:**
  - Recording starts with the session, with no button.
  - Files are stored by session ID, play in the browser and have a download link.
  - Only that session's user (or an admin) can access them.
  - A retention rule deletes old recordings.
- **Bad:** manual start, recordings anyone can list by guessing URLs, or a disk that fills up.
- **Traps:**
  - A raw video stream usually isn't directly playable. It needs wrapping into a container (MP4) with timestamps.
  - A session killed abruptly can leave an unfinished, unplayable MP4. Fragmented MP4 or a finalisation step handles that.

---

## 5. Scope

- **"Scaling is not required. 2 to 3 simultaneous instances on one machine is enough."** Size the server for three Android instances plus their encoders. Measure RAM and CPU per instance in the spike instead of guessing.
- **"Do not build autoscaling or clustering. The deployment itself should still work reliably on a real server."** Kubernetes here is a red flag for over-engineering. What they want is reliability on one box.
- **"A simple design that works reliably is preferred over a complex one that is half finished."** This is an explicit hint. Every choice should pass the question "is this the simplest thing that meets the requirement?"
- **"The core requirements plus one or two bonuses make a strong submission."** Five shallow bonuses lose to two deep ones.

---

## 6. Deployment

- **"Open in a browser and test without installing anything."** No extensions, no adb and no VPN on their side. List supported browsers in the README, because browser video APIs differ by browser and version. *(verify)*
- **"Generic infrastructure… must not provide the Android device streaming itself."** This is the same line as the constraint above.
- **"The backend must run on a server, not on your own computer."** A tunnel from a public URL to your laptop doesn't count.
- **"Getting this running and keeping it running (server access, networking, process management, cleaning up after sessions) is part of the challenge."**
  - **Testing:** ops maturity. It is also graded under Engineering quality.
  - **Good:** services restart on crash and on reboot, a reverse proxy handles HTTPS and WebSockets, and there is a health endpoint, logging and disk cleanup. You have actually tested a reboot.
- **"Keep it available while we evaluate your submission."** This is a billing trap. Keep the server running for a couple of weeks after submission and set a billing alert. Don't rely on a free trial that may expire mid-evaluation.
- **"State in the README where it is hosted and any limits."** Include provider, region, instance size, max simultaneous sessions and idle timeout.

---

## 7. Using AI

- **"We encourage it… what you ask, what you decide yourself, what you check, and what you change when the output is wrong."**
  - **Testing:** you as the decision-maker.
  - **Good:** prompts that set constraints, suggestions rejected or changed with reasons, and claims verified by running them.
  - **Bad:** "build it for me" prompts, or AI choices presented as yours.
- **Coding agent → compulsory `PROCESS_LOG.md`, instruction pasted "before you start", log committed "as you work".** Git history will show whether the log grew over time. Commit it at every milestone, and never let an agent tidy it.
- **AI chat → "a public link to every conversation you used".** "Every" includes the chat where you drafted your master prompt and any quick side questions to other assistants.
- **Own-words section: decisions the AI didn't suggest, and at least one place it was wrong.** It must be specific, pointing to log entries, and genuinely in your words.
- **"Please do not edit or clean up the logs or chats… A missing or edited record will [count against you]."** In chat apps, editing a sent message or regenerating a reply can change what the shared view shows. Send corrections as new messages instead.

---

## 8. Deliverables (all tracked in `CHECKLIST.md`)

- **Demo video:** 3–5 minutes, one continuous take of the deployed version, narrated, covering every feature built. That is tight, so script it, rehearse it and budget for a few takes.
- **Architecture write-up:** 1–2 pages. Brevity is part of the test. It must include the alternatives you rejected and why.
- **"What went wrong"** and **"With more time"** are separate sections.
- **Time actually spent** must be stated, so track it from the start.

---

## 9. Evaluation criteria: what each line implies

- **Core: "stable on the deployed link".** Stability is judged under *their* testing, not your local demo.
- **Problem solving & AI.** This comes from the AI record, the write-up and "What went wrong". Write these as you go; they can't be reconstructed convincingly at the end.
- **Engineering: "cleanup of unused instances".** This is graded even if you skip bonus B2. At minimum, a single session must clean up after itself.
- **Communication: "strength of isolation".** Containers share the host's kernel; virtual machines don't. Expect to explain which you used and what that means for security.

---

## 10. Closing note

**"You are not expected to know Android streaming, WebRTC…"** Learning is what's being evaluated. Write down what you learned and how, not just what you built.

---

## Ambiguities worth asking about (one short email)

1. Does a small pool of pre-booted, *unassigned* instances count as "reserved per user in advance" for Bonus 2?
2. Which browsers will evaluators test in? This affects the choice of browser video decoding and the clipboard approach.

---

## Glossary

### Running Android on a server

| Term | Plain meaning | Why it matters here |
|---|---|---|
| Android Emulator / AVD | Google's official emulator, which runs a full Android system image inside a virtual machine. An AVD (Android Virtual Device) is a saved configuration: device model, Android version, screen size. | The most compatible option, but fast only with hardware virtualization (KVM). |
| Container-based Android | Android's user space running in a Linux container that shares the host's kernel (e.g. redroid, Waydroid). | Lighter and quicker to start than a VM, but needs host kernel features and gives weaker isolation. |
| redroid | Open-source project that ships Android as Docker images. | A common candidate for several instances on one server. *(verify requirements)* |
| Cuttlefish | Google's virtual Android device, built for cloud and CI use. It is VM-based. | Another option; it also needs KVM. |
| Waydroid | Container-based Android aimed at Linux desktops. | Built around a desktop session, which is awkward on a headless server. *(verify)* |
| Genymotion | Commercial Android virtualization. | Check licensing carefully; paid emulator platforms are forbidden. |
| Hypervisor / VM | Software that runs a whole virtual computer with its own kernel. | Gives stronger isolation than containers. |
| KVM | A Linux feature that lets VMs use the CPU's hardware virtualization for near-native speed. It is present if `/dev/kvm` exists. | Without it, VM-based Android is impractically slow or won't start. |
| Nested virtualization | Running a VM inside a cloud VM. The provider must expose hardware virtualization to your VM. | Many providers or instance types don't allow it; bare-metal servers are the alternative. |
| Binder | Android's inter-process communication system, implemented in the Linux kernel. | Container-based Android needs the host kernel to provide it. |
| ashmem | Android's older shared-memory kernel driver. | Only some older Android images need it; newer ones use a standard Linux alternative. *(verify)* |
| ADB | Android Debug Bridge: shell access, app install, file push and port forwarding to a device. | The control channel your backend uses to set up and manage each instance. |
| adb forward / reverse | Tunnels a TCP port between host and device, in either direction. | How a capture tool on the device gets its video and control connections out. |
| app_process | Android's launcher for running Java code outside an installed app, with shell-level privileges. | Lets tools like scrcpy capture the screen and inject input without installing an app. |
| scrcpy | Open-source (Apache-2.0) tool for screen mirroring and control. Its *server* part runs on the device, encodes the screen with MediaCodec, and exchanges video and control messages over sockets. | Many browser-based projects reuse the server part. Read its source and docs in Phase 1. |
| MediaCodec | Android's API for video encoding and decoding, in hardware or software. | Does the encoding work on the device side. |

### Video

| Term | Plain meaning | Why it matters here |
|---|---|---|
| Codec | A compressor/decompressor, such as H.264, H.265, VP8/VP9 or AV1. The encoder runs on the device and the decoder in the browser. | Both sides must support the same codec. |
| H.264 (AVC) | The most widely supported video codec. | The safe default for decoding in the browser. |
| Keyframe / I-frame | A complete picture that can be decoded on its own. | Viewers can only start, or recover, at a keyframe. |
| IDR frame | A keyframe that also resets the decoder's memory of earlier frames. | The clean starting point for a new or reconnecting viewer. |
| P-frame | A frame that stores only what changed since an earlier frame. | P-frames are small, so most frames are P-frames. |
| B-frame | A frame that uses both earlier *and later* frames. | The decoder must wait for a future frame, which adds delay. Avoid them for low latency. |
| SPS / PPS | Small configuration packets that describe the stream (resolution, profile). | The decoder needs them before the first keyframe. |
| NAL unit / Annex B | The NAL unit is H.264's packet unit. Annex B is the raw byte-stream format where units are separated by start codes (`00 00 00 01`). | Raw streams arrive in this form, and you split them into chunks for the browser decoder. |
| Keyframe interval (GOP) | How often a keyframe is sent. | A shorter interval means faster joins and recovery, but more bandwidth. |
| Bitrate / FPS | Data per second / frames per second. | The main knobs for trading quality against latency. |
| Codec vs container | The codec compresses frames; a container (such as MP4) wraps them with timestamps and an index. Fragmented MP4 (fMP4) is MP4 written in small self-contained pieces. | Recording needs a container. fMP4 survives an abrupt stop and suits live playback. |
| Muxing / ffmpeg | Muxing means wrapping encoded frames into a container without re-encoding them. ffmpeg is the standard open-source tool for it. | Makes recording cheap: copy the stream you already have into MP4. |

### Getting video to the browser

| Term | Plain meaning | Why it matters here |
|---|---|---|
| WebSocket | A persistent two-way connection over HTTP(S), running on TCP. | A simple path for binary video chunks and input messages. Because it runs on TCP, one lost packet delays everything behind it (head-of-line blocking). |
| WebRTC | The browser's real-time media stack. It covers UDP transport, congestion control and a jitter buffer. It also handles getting through home and office routers (ICE, using STUN/TURN servers) and session setup via SDP over a signalling channel you build. | Best on lossy networks, but has the most moving parts. |
| WebCodecs | A browser API that gives direct access to video decoders. You feed in encoded chunks and get back frames to draw on a canvas. | It has no built-in buffering, so latency is low, but you handle timing, errors and keyframes yourself. Needs HTTPS, and support varies by browser version. *(verify)* |
| MSE | Media Source Extensions: you feed fMP4 segments into a normal `<video>` element. | Widely supported, but players tend to buffer, which adds latency unless tuned. |
| MJPEG / JPEG frames | Every frame is sent as a separate image. | The simplest and most robust option, but heavy on bandwidth. |
| Secure context | A page served over HTTPS, or from localhost. | Required by the Clipboard API, WebCodecs and other modern APIs. |
| Reverse proxy | A front server (e.g. nginx, Caddy) that handles HTTPS and forwards requests to your app, including WebSocket upgrades. | How you put one HTTPS URL in front of the backend. |
| TLS / Let's Encrypt | TLS is the encryption behind HTTPS. Let's Encrypt is a free certificate authority. | Needs a domain name pointing at your server. |

### Input

| Term | Plain meaning | Why it matters here |
|---|---|---|
| CSS pixel vs device pixel | Browsers lay out pages in CSS pixels, but a screen may have 2–3 physical pixels per CSS pixel (`devicePixelRatio`). | Mixing the two is a classic mapping bug. |
| Letterboxing | Black bars that appear when a picture's shape doesn't match its box (`object-fit: contain`). | Clicks must be mapped from the picture's rectangle, not the box. |
| Pointer Events | Unified browser events for mouse, touch and pen (`pointerdown/move/up`). | They map directly onto Android's touch down / move / up. |
| Keycode vs text injection | Keycodes simulate physical keys (Back, Enter, Delete); text injection inserts characters. | These are different paths. Symbols and non-English text are fragile when sent as keycodes. |
| `adb shell input` | A command-line tool for injecting input. | It starts a new process for every event, so it's slow. Fine for testing, poor for live control. |
| IME | Input Method Editor, i.e. the on-screen keyboard. | May pop up and cover part of the screen when a text field gets focus. |

### Restricting the device

| Term | Plain meaning | Why it matters here |
|---|---|---|
| Kiosk mode | The generic term for locking a device to one app. | The goal of Bonus 4. |
| Screen pinning | A user-facing feature that pins one app to the screen. | The user can unpin it, so it isn't enough on its own. |
| Lock task mode | An OS-enforced kiosk mode for apps allow-listed by a device policy controller. | The strong version of kiosk mode. |
| Device owner / DPC | A device policy controller is an app with full management rights. It is typically made device owner with `dpm set-device-owner` on a freshly set-up device. | Needed for full lock task mode, and has preconditions. *(verify)* |
| Intent / deep link | Android's message for opening a screen or another app. | This is how apps launch other apps, so each one is a potential escape route. |
| Escape route | Any path out of the allowed app. | You list them, block each on the device or server, and test each. |

### Sessions and operations

| Term | Plain meaning | Why it matters here |
|---|---|---|
| Session | One user's period of use, with its own instance and secret token. | The unit for isolation, lifecycle and recording. |
| Heartbeat | A periodic "still here" message from the browser. | Missing heartbeats mean the session was abandoned. |
| Idle timeout | Ending a session after N minutes without input. | Frees capacity held by forgotten tabs. |
| Orphan / reaper | An orphan is an instance with no live session. The reaper is the cleanup job that finds and removes orphans, including on startup after a crash. | Required by "abandoned sessions must not leak resources". |
| Port allocation | Giving each instance its own network ports. | Stops two sessions colliding, or one attaching to another's. |
| systemd / restart policy | systemd is the Linux service manager. A restart policy is Docker's auto-restart rule. | Brings everything back after a crash or reboot without you logging in. |
| Health check | An endpoint that reports whether the service works. | Quick proof the deployment is alive. |

### Measurement

| Term | Plain meaning | Why it matters here |
|---|---|---|
| Latency vs throughput | Latency is the delay of one event; throughput is the data delivered per second. | Big buffers give high throughput but bad latency. This project needs low latency. |
| End-to-end ("glass-to-glass") latency | The time from the user's action to the visible change on the user's screen. | The number the assignment asks for. |
| RTT | Round-trip time on the network. | The floor under your latency. It depends on the server's region. |
| Median / p95 | Half of trials are faster than the median; 95% are faster than p95. | p95 shows the slow moments users actually feel. |
| Jitter / jitter buffer | Jitter is variation in delay. A jitter buffer smooths it out at the cost of extra delay. | A key trade-off between latency and smoothness. |
