# Latency

**Result: a touch shows its effect on the page after a median of 165 ms (95th percentile 191 ms), measured over 40 taps on the deployed server.**

## What is measured

The time from the page sending a touch to the page drawing the first video frame in which the device has visibly reacted. One clock is used (the browser's `performance.now()`), so no clocks need to be synchronised.

One trial:

1. Read the pixels in a 48 x 48 square around the device's Back button.
2. Send a touch-down on the Back button and start the clock.
3. Each time a video frame is drawn, read the same square. Android highlights the Back button as soon as it is pressed; when the square differs from step 1 (mean colour difference above 6 of 255), stop the clock.
4. Send the touch-up, wait 0.9 s for the highlight to fade, and repeat.

The code is `frontend/latency.mjs`. Anyone can repeat it: open the deployed page, wait for "Live" with the device on its home screen, open **Latency test** and press **Run 40 taps**. The result appears as JSON with every sample.

### What the number includes

Page, WebSocket to the server, scrcpy control socket, Android injecting the touch and drawing the highlight, screen capture, H.264 encoding, back through the server and the WebSocket, decoding in the browser, drawing on the canvas.

### What it leaves out

- The mouse or touch screen before the browser sees the event.
- The monitor after the canvas is drawn (up to one screen refresh, about 17 ms at 60 Hz).
- Android's own delay before it shows the highlight is *included*, so a different on-screen reaction could give a slightly different number.

## Conditions

| | |
|---|---|
| Date | Sun 4 Oct 2026, about 14:40 IST |
| Server | AWS EC2 m7i-flex.large (2 vCPU, 8 GB), Mumbai (ap-south-1), Ubuntu 24.04 |
| Device | redroid Android 12 container, 720 x 1280, software rendering, 30 frames per second |
| Video | H.264 (software encoder `c2.android.avc.encoder`), 2 Mbit/s, 720 x 1280 |
| Client | Chrome 154 on Windows 11, a laptop in India on a home connection |
| Path | Public HTTPS link (Caddy, then the Node backend) |
| Sessions on the server | 1 |
| Trials | 40, none timed out |

The test was started by an automated Chrome window that was not in front. The page draws each frame when it is decoded, which does not depend on the window being in front (see "What went wrong" for why that matters).

## Results

| Run | Median | 95th percentile | Min | Max |
|---|---|---|---|---|
| **30 frames per second (deployed setting)** | **165 ms** | **191 ms** | 141 ms | 196 ms |
| 60 frames per second (tuning run, not kept) | 150 ms | 181 ms | 124 ms | 225 ms |

Samples, 30 fps run (ms): 194 151 170 145 181 171 179 158 175 165 141 146 151 176 173 144 149 183 146 162 180 160 172 180 196 151 183 161 161 155 168 165 146 154 191 177 152 176 144 176

Samples, 60 fps run (ms): 225 170 134 150 158 143 158 134 133 124 134 171 133 135 148 142 148 147 173 147 141 164 157 170 142 150 174 148 132 151 134 152 174 180 165 127 185 150 162 181

### Where the time goes (30 fps run)

| Part | Median | How it was measured |
|---|---|---|
| Network round trip, page to server and back | 28 ms | 10 ping messages over the same WebSocket |
| Browser: frame data arriving to frame drawn (decode and draw) | 11 ms | timestamp when the frame's data arrived, to when it was drawn |
| Everything on the server and device | about 126 ms | the remainder (165 - 28 - 11); not measured directly |

The server-and-device part was not broken down further. It contains the touch injection, Android drawing the highlight, waiting for the next frame (up to 33 ms at 30 fps), the software H.264 encoder, and the relay.

## Tuning

| Change | Before | After | Kept? |
|---|---|---|---|
| Device and video at 60 fps instead of 30 | median 165 ms, p95 191 ms | median 150 ms, p95 181 ms | **No.** One device with a moving screen used 189 % of the 200 % CPU available, so three sessions would not fit. |
| Draw each frame when decoded, instead of on the browser's next animation frame | not measured reliably (see below) | used for both runs above | Yes |

The second change should save up to one screen refresh, but there is no trustworthy "before" number for it. The old path can still be selected with `?draw=raf` to compare in a window that is in front.

Not tried: lower resolution, a different bit rate, encoder options, a GPU.

## What went wrong while measuring

1. **First method failed.** The plan was to detect Android's "show touches" dot. On this device the dot is not drawn at all (40 of 40 trials timed out; a screenshot during a held touch showed no dot). The Back button highlight replaced it.
2. **A bug in the test.** A timer left over from one trial could cancel the next trial and hang the run. Fixed by making each timer cancel only its own trial.
3. **Misleading numbers from a hidden window.** With the page drawing on animation frames, the automated browser window gave samples that alternated between about 95 ms and about 1100 ms. The cause was the browser slowing animation frames to roughly one per second in a window that is not in front. Those numbers were discarded.

## Limits of this result

- One client, one network, one browser, one time of day. A client far from Mumbai will see a higher number, roughly by the extra round-trip time.
- One session on the server. Latency with three active sessions was not measured.
- The reaction measured is a button highlight. Typing, scrolling and app start were not timed.
- No camera measurement of the real screen was made, so the "left out" parts above are estimates, not measurements.
