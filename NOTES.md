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
