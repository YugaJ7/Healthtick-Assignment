# Requirements checklist

Every requirement, bonus, deliverable and constraint from `ASSIGNMENT.md`, with how we'll prove it. Fill in **Evidence** with a link, commit, screenshot or command output. A row is only ☑ once evidence exists.

Status: ☐ not started · ◐ in progress · ☑ done (evidence linked) · ✗ dropped (reason in write-up)

## Core requirements (30%)

| ID | Requirement | How we will prove it | Evidence | Status |
|---|---|---|---|---|
| C1 | Live screen updates continuously, no manual refresh | Leave the deployed page open for 10+ min. Cut the network for ~10 s and check the stream recovers without a reload. Show it in the demo video. | | ☐ |
| C2a | Tap, swipe and scroll work from the browser | Demo video: swipe through a list, scroll a page with the mouse wheel, long-press. | | ☐ |
| C2b | Typing works, including special keys | Type `Hello World 123 !@#` into a text field. Check that Enter, Backspace, Back and the arrow keys behave correctly. | | ☐ |
| C2c | Input lands correctly at any window size | Automated test taps the 4 corners + centre with Android's pointer-location overlay on *(verify setting)*. Compare reported vs expected device coordinates at 3 window sizes, on a phone browser, and after rotation. | | ☐ |
| C3 | Responsive, with measured latency | `LATENCY.md`: method, ≥30 trials, median / p95 / min / max, conditions (server region, client network, resolution, bitrate, FPS), and before/after numbers for tuning. | | ☐ |
| C4 | Runs on one machine from documented steps | On a fresh VM, follow the README / setup script word for word until it works. Record any deviation and fix the docs. | | ☐ |
| C5 | Deployed, public link | Open over HTTPS from a different network and device, e.g. a phone on mobile data. | | ☐ |

## Bonus requirements (25%). Chosen at Phase 0 gate: _TBD_

| ID | Requirement | How we will prove it | Evidence | Status |
|---|---|---|---|---|
| B1 | Isolated instance per user: no leak of actions, files, settings or installed state | Session A creates a file, changes a setting and installs an app; session B sees none of it. B cannot connect to A's stream with A's session ID alone. A's instance cannot reach B's over the network. | | ☐ |
| B2 | Instance on demand, released on end/idle, nothing pre-reserved per user, no leaks | Check the instance list (`docker ps` / process list) before, during and after each ending: explicit end, tab close, network cut, idle timeout. Kill the server mid-session and restart it; the reaper removes the leftovers. No stray ports or files remain. At capacity, the page shows "busy". | | ☐ |
| B3 | Two-way clipboard | Copy on the computer and paste into a device text field. Copy on the device and paste on the computer. Include non-English text. | | ☐ |
| B4 | Restricted to one app and a defined set of actions, enforced beyond the browser | Document the app and the reasons for choosing it. Escape-route table (route → how blocked → test result), including crafted WebSocket messages sent outside the UI. | | ☐ |
| B5 | Automatic session recording, playable/downloadable, tied to session | End a session; the recording appears under its ID, plays in the browser and downloads. Other sessions can't access it. A retention rule deletes old files. | | ☐ |

## Constraints

| ID | Constraint | How we will prove it | Evidence | Status |
|---|---|---|---|---|
| K1 | Core built with free / open-source software | Component + licence table in `ARCHITECTURE.md`. | | ☐ |
| K2 | No paid device-streaming service, paid emulator or device farm, or commercial streaming SDK | Same table; nothing proprietary in the device or stream path. | | ☐ |
| K3 | Hosting provides only generic infrastructure; README states where it's hosted and its limits | README names the provider, region and instance type, plus limits (max simultaneous sessions, idle timeout). | | ☐ |
| K4 | Backend runs on a server, not a personal computer | It works with my laptop switched off. | | ☐ |
| K5 | Available throughout evaluation | Unattended reboot test passes. Billing covers ≥2 weeks after submission, with a billing alert set. | | ☐ |
| K6 | Testable with no installation | Works in a plain browser; supported browsers listed in the README. | | ☐ |
| K7 | Submitted within 72 h, with actual time spent reported | Time log in `NOTES.md`; total stated in the write-up. | | ☐ |

## Deliverables

| ID | Deliverable | How we will prove it | Evidence | Status |
|---|---|---|---|---|
| D1 | Public Git repo with all backend and frontend code | A fresh clone in a clean environment builds and runs per the README. | | ☐ |
| D2 | Deployed link, plus any credentials or steps for each feature | README section, checked from a logged-out browser. | | ☐ |
| D3 | Demo video: 3–5 min, one continuous take of the deployed version, narrated, every built feature | Script from Phase 7; check the final take's length; no cuts. | | ☐ |
| D4 | README: local setup and how to test each feature | Someone else follows it, or a clean-VM run does. | | ☐ |
| D5 | Architecture write-up, 1–2 pages: screen → browser, input → device, isolation and restriction, alternatives rejected | Check the page count and that each topic is present. | | ☐ |
| D6 | "What went wrong" section | Built from `NOTES.md` and the AI record, with real errors. | | ☐ |
| D7 | "With more time": scaling beyond a few users, and main security risks | Section present. | | ☐ |
| D8 | AI record | Public links to **every** AI chat used, including any used to draft prompts. If a coding agent was used, `PROCESS_LOG.md` committed throughout. | | ☐ |
| D9 | Own-words section: decisions the AI didn't suggest, and at least one place the AI was wrong and how I noticed | Written by me, referencing specific moments in the log. | | ☐ |

## Engineering quality (10%) and communication (10%)

| ID | Item | How we will prove it | Evidence | Status |
|---|---|---|---|---|
| E1 | Clear code structure | Backend, frontend, infra and docs separated, with short module READMEs where useful. | | ☐ |
| E2 | Error handling | Device crash, socket drop and server restart each produce a clear UI state (loading, connected, error, ended). | | ☐ |
| E3 | Cleanup of unused instances | Applies even without B2: ending a session leaves nothing running. | | ☐ |
| M1 | Trade-offs discussed | Write-up covers latency vs quality and isolation strength (container vs VM). | | ☐ |

## AI record integrity

| ID | Item | How we will prove it | Evidence | Status |
|---|---|---|---|---|
| A1 | Logging instruction in `CLAUDE.md` / `AGENTS.md` before first agent use | Present in the earliest commits. | | ☐ |
| A2 | `PROCESS_LOG.md` never rewritten | `git log -p PROCESS_LOG.md` shows additions only. | | ☐ |
| A3 | Chats unedited | No edited or regenerated messages; corrections sent as new messages. | | ☐ |
