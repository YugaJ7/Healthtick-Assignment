# Write-up

The architecture, with the alternatives considered, is in [ARCHITECTURE.md](ARCHITECTURE.md). The latency method and numbers are in [LATENCY.md](LATENCY.md). This file holds the rest: what went wrong, what I would do with more time, and my own account of working with the AI.

## What went wrong

Each item is in `PROCESS_LOG.md` with the time it happened.

**Getting a server**

- **No local test machine.** WSL on the laptop was broken, and redroid on WSL needs a rebuilt kernel anyway. Abandoned; everything was tried on a cloud server from the start.
- **AWS CloudShell refused the new account**, so the scripted launch was dropped and the server was made by hand in the console.
- **Wrong image, wrong region, wrong size.** The first image picked was Ubuntu 22.04 bundled with SQL Server, which the free plan refused; plain 22.04 was not in the list, so 24.04 was used. The first server landed in Sydney instead of Mumbai because the region instructions did not match the console. A later server was launched as `m7i.large` instead of `m7i-flex.large` and had to be changed.
- **The feasibility check said binder was missing.** It was a false alarm: the kernel module ships in a separate Ubuntu package (`linux-modules-extra`). After installing it, binder loaded.

**Building**

- **Killing the backend over SSH killed the SSH command itself.** `pkill -f "node src/server.js"` matches its own command line. Two silent failures before the cause was found; fixed with a script file and `pkill -x node`.
- **A killed backend left adb port forwards behind**, and the next start failed to connect. Fixed with cleanup at start-up; later replaced by per-session devices and deletion of leftover devices.
- **Nothing came back after a reboot.** Binder was not loaded at boot and nothing restarted the device or the backend. Fixed with a module-load entry and a systemd service; a reboot now brings the site back in 25 seconds without anyone logging in.
- **A code review found that one unexpected error while handling input could crash the backend** for every visitor (the error was rethrown inside an event handler). Now it is logged and only that viewer is closed.

**Measuring latency**

- **The planned visual marker did not exist.** Android's "show touches" dot is not drawn on redroid with software rendering: 40 of 40 trials timed out. Switched to the highlight of the Back button.
- **A stale timer hung the test run.** A timeout from one trial fired during the next. Fixed by giving each trial its own timer.
- **A false result of 849 ms.** The test browser window was not in front, and browsers slow `requestAnimationFrame` to about once a second in that state. The page now draws each frame when it is decoded, and the median is 165 ms.
- **60 frames a second was tried and dropped:** 15 ms faster, but one device used 189 % of the two CPUs.

**Restricted mode**

- **The watchdog raised a false alarm every second** while a Clock menu was open, because a menu is its own window. It now checks the resumed activity instead of the focused window.
- **The first fence broke every device.** Setting Android's "no app installs" restriction through adb failed with a permission error, because the adb shell is not root, and the backend refused to hand out an unfenced device, as designed. Found on the first live run; fixed by setting it as root through Docker.
- **Clock has a link into Settings** ("Change date & time"). With Settings disabled, Clock crashes when it is pressed, and the watchdog reopens it. It holds, but it is not graceful.

**Security review, late**

- A review of the finished system found a chain that had not been planned for: the site is open, a visitor could install an app on a full device, the device's debugging port accepts connections from the device itself without authentication, and the container is privileged. A test script confirmed every step on the live server, with one correction: the shell behind that port is Android's `shell` user, not root as the review had assumed. Fences were added and the same script now passes; see "Main security risks" below.

## With more time

### Scaling beyond a few users

The limit today is one machine: about 600 MB of memory per device, and CPU, because Android draws and encodes video in software. Starting two devices at once took about 16 seconds each on 2 CPUs.

1. **A bigger machine first.** The design does not change; more CPUs and memory carry more devices. How many per CPU has not been measured with several active users, so the first step would be that measurement. A machine with a graphics card would remove the software drawing cost.
2. **Warm pool.** Keep one or two booted, unused devices ready so a visitor waits about a second instead of 7. They are still never reused: a device handed out once is deleted afterwards.
3. **Several device hosts.** Split the backend in two: a small front service that owns sessions and picks a host, and an agent on each host that creates devices and relays video. The browser would connect straight to the host that has its device. Session state would move from memory to a small shared store, so a restart of the front service loses nothing.
4. **WebRTC for bad networks.** WebSocket runs over TCP, so one lost packet stalls everything behind it. Fine on good connections, poor on mobile networks.
5. **A queue with a position** instead of "all devices are in use", and sign-in with a quota per person instead of a limit per network address.

### Main security risks

1. **Privileged containers on a shared kernel.** Root inside a device is close to root on the server. The real fix is one small virtual machine per session (the Android Emulator or Cuttlefish under KVM, which this server supports), at the cost of slower starts and more memory.
2. **An open site that hands out a full Android device.** Devices now have no network access, so a device cannot be used to browse or attack from the server's address, but anyone can still occupy devices. A real service would put the full device behind sign-in.
3. **The path from visitor to server.** Fenced and tested: the device's debugging port is closed to the device itself, visitors cannot install apps, devices cannot reach the server, the private network, the cloud metadata address or the internet, each device has a CPU limit, and one network address can hold at most two devices. What remains is risk 1: a bug in the kernel or in Docker.
4. **The backend can control Docker**, which equals administrator rights on the server. A separate small helper offering only "create device" and "delete device" would shrink that.
5. **Screen pinning is not a kiosk lock.** Clock-only mode relies on the server's input filter and its once-a-second check, and that check runs only while a viewer is connected. A device-owner app with a true lock task would be stronger.
6. **Old Android.** The image is Android 12 with an old security patch level; known Android bugs apply inside the device.
7. **Recordings are sensitive.** They show everything a visitor did and typed. They are kept 24 hours and need the session's token, but they sit unencrypted on the server's disk.
8. **No audit trail or abuse controls** beyond the limits above: no record of who did what, and no way to block an abusive address.
