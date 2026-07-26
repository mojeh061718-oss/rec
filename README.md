# Terminal

A PWA that looks like a coding session and captures video without showing a
preview, a timer, or any recording state on screen.

## Words

Type these at the prompt. Every one of them produces an ordinary-looking turn —
the transcript gives no hint that any of them is different from the others.

| Word        | Effect |
| ----------- | ------ |
| `ac1`       | starts capturing on the **0.5× ultra wide** |
| `ac2`       | starts capturing on the **1× main camera** |
| `f1`        | starts capturing on the **front camera** |
| `done`      | stops, stores the clip, and opens the share sheet |
| `save`      | retries the sheet for the oldest unsaved clip |
| `clips`     | lists stored clips, oldest first (`✓` = already handed off) |
| `drop`      | deletes clips already handed off |
| `drop all`  | deletes every stored clip, saved or not |
| `diag`      | **real** internals — the one output here that isn't theatre |
| `update`    | drop the cached build and reload (stored clips are untouched) |
| `warm`      | takes the camera without recording — clears the permission prompt early |
| `cool`      | releases the camera (green indicator goes out) |
| `lens`      | reports the live lens and its negotiated resolution |
| `lens next` | moves to the next back lens |

Case, spacing and punctuation don't matter — `AC1` and `a-c-1` are the same
word as `ac1`. A typo isn't: it just plays a filler turn like any other text,
and the status line tells you capture didn't start. (`agent-call1` and
`agent-call2` still work, if muscle memory has already set.)

## Checking which build is on the phone

The boot line shows it:

```
  v0.4.5 · cwd: ~/projects/relay
```

This matters more than it looks. An unrecognised word doesn't announce
itself — it just plays a filler turn, exactly like ordinary text. So a phone
running a stale build is indistinguishable from a broken one: you type `ac1`,
get a plausible-looking response, and nothing records.

If the number is behind the deployed build, type `update`. That clears the
cached copy and reloads. Stored clips are in IndexedDB and are not touched.

The service worker fetches network-first and bypasses the browser's HTTP
cache, so this shouldn't recur — but the first launch after a deploy may still
come up on the old build while the new service worker installs behind it.
Opening it a second time settles it.

If it's still stale after that: delete the home-screen icon, then Settings →
Safari → Advanced → Website Data → remove the site, then add it again.

## When something goes wrong: `diag`

Every other line in this app is canned text. `diag` is the exception — it
reports what actually happened:

```
⏺ Bash(tail -n 20 .claude/debug.log)
  ⎿  build:   5
     camera:  3840x2160 · REC
     codec:   mp4;codecs=avc1.640033
     opts:    full
     take:    12 chunks / 48.2 MB / memory
     stored:  1 clip(s) / 48 MB
     share:   (none yet)
     errors:  none
```

- **take** — chunks and megabytes captured in the current or last recording.
  `0 chunks` means the camera opened but no video ever arrived.
- **stored** — clips on disk waiting for `save`.
- **unsaved** — clips not yet handed to the share sheet. This is what the
  status-line asterisk tracks.
- **orphan** — finished clips that couldn't be written to disk. Still
  saveable, but only until the app closes, so `save` them now.
- **share** — outcome of the last `save`. `AbortError` means you dismissed the
  sheet. `canShare=false` means iOS refused the file.
- **errors** — the last three real failures.

Run it after `done` if you're unsure a take worked.

Anything else you type plays a filler turn, so you can keep typing naturally
for as long as you want.

## Saving

`done` does everything: it stops the recording, stores the clip, and opens the
share sheet with the video already attached. One tap on **Save Video** puts it
in the camera roll, or **Save to Files** if you'd rather.

That tap is the only part iOS won't let an app do for itself. No web app can
write to Photos or to Files directly, and the sheet is system UI — it can't be
replaced by anything drawn in the console. Everything either side of it is
automatic.

The sheet has to open within a few seconds of the keypress that authorised it,
so `done` shares before it plays any of its output, and the clip is written to
storage in the background rather than ahead of the sheet. Measured at about
15 ms from keypress to sheet.

If the sheet doesn't appear, or you dismiss it, the clip is kept and `save`
tries again. The status line tells you when something is waiting:

```
main* · 64% context left
```

That asterisk means at least one clip is stored and unsaved. It reads as the
ordinary git marker for a dirty working tree, it survives closing and
reopening the app, and it clears only once every clip has been handed off. If
you see it, you have footage you haven't saved yet.

## Nothing is deleted on its own

**`save` does not remove the clip.** It hands it to the share sheet, marks it
handed off, and keeps it. `clips` shows everything with a `✓` against the ones
already sent:

```
⏺ Bash(git stash list)
  ⎿  stash@{0}: 17:40 · 182M ✓
     stash@{1}: 17:52 · 96M
```

This is deliberate, and it is the fix for a recording that was lost. iOS
resolves a share as soon as the sheet closes — a denied Photos permission or a
cancelled sub-sheet still comes back as success — so deleting on that word
throws away the only copy of a clip that never actually arrived.

Clips marked `✓` are cleared automatically two days after they were saved, so
storage doesn't need managing by hand. Unsaved clips are never pruned, at any
age. To free space sooner, `drop` clears the `✓` ones immediately — it will not
touch an unsaved clip. `drop all` takes everything and is the only command here
that can destroy a recording you haven't saved.

## Every clip has its own name

Clips are named by the moment they were taken:

```
clip-20260726-174057.mp4
```

They used to all be called `clip.mp4`, which meant saving a second one into
Files silently replaced the first. Saving into Photos was never affected —
Photos keys on its own asset IDs, not filenames — but anything routed through
Files was.

## A note on timing

The sheet appears the moment you type `done`, which means it appears in front
of whoever is in the room. If you'd rather it didn't, don't type `done` yet —
capture keeps running, and the recording is only ended when you say so. Leave
the app and the take is finalised and stored, ready for `save` later.

## If the app crashes

Recording writes to disk continuously, not just at the end. Every two seconds
the take so far is flushed to IndexedDB, and a small record of what the take is
— codec and start time — is written before the first frame lands.

So if the app is killed mid-recording, whether by a crash, a force-quit, or iOS
reclaiming memory, the footage is still on the phone. The next launch finds the
leftovers, rebuilds them into a normal clip with the right format and its real
timestamp, and raises the `main*` marker. `save` hands it over like any other.

**What you lose is up to two seconds** — whatever hadn't been flushed yet.
Nothing more.

The assembled clip is also written before the raw pieces are cleared, so a
crash in that gap still leaves a recoverable take rather than half of one.

Verified by killing the app mid-recording and relaunching: the take was
rebuilt, correctly stamped, and saved.

Clips already finished live in IndexedDB too, so they survive closing the app,
force-quitting it, and rebooting the phone.

A take is held in memory first and written to disk alongside, rather than
going to disk only. Storage can refuse a write — a full origin quota is the
usual reason — and when it does, the memory copy still carries the clip
through. `diag` reports it as an `orphan`: saveable, but only until the app
closes. Past 400 MB the memory copy is dropped and disk takes over, since a
long 4K take would otherwise be large enough to bring the tab down.

A clip is never deleted because a share reported success. The only automatic
deletion is the two-day sweep of clips already handed off; everything else
needs `drop`.

## Lenses

`ac1` is the **0.5× ultra wide** — the widest field of view, and the safer
default when you can't watch a preview to check framing.

`ac2` is the **1× main camera** — sharper, much better in low light, and on an
iPhone 16 Pro it's the lens that actually reaches 4K.

`f1` is the **front camera**. Worth knowing what it changes: the screen and the
lens now point the same way, so whoever you're filming is looking straight at
the console. It still reads as a coding session, but it is no longer out of
view, and you can't watch the screen while it films. The front camera is also
a smaller sensor than the 1× rear.

iOS only reveals its individual lenses after camera permission is granted, and
only by name, so the first warm takes the camera, reads what's there, and
re-acquires on the right one. After that both triggers go straight to their
lens. If no discrete ultra wide device is exposed, the virtual multi-lens
camera is pinned to its minimum zoom instead — same lens, same result.

Type `lens` to see which one is live and what resolution it actually
negotiated. Worth doing once for each trigger on the real phone.

**Which to use:** the ultra wide has a smaller sensor and a slower aperture, so
indoors in anything less than good light it will be visibly grainier, and faces
near the frame edges get stretched by the wide geometry. If she's centred and
the room is lit, `ac2` will look considerably better. Use `ac1` when you're
unsure she'll stay in frame.

## Quality

It asks for 4K30 and takes whatever the lens actually gives back — 4K is a
request, not a guarantee, and it differs per lens. Bitrate then follows the
resolution that was really negotiated rather than a fixed number, at roughly
27 Mbps for 4K and 6.8 Mbps for 1080p, which is comparable to what the stock
camera app writes. Audio is 256 kbps, with headroom for singing rather than
speech.

The codec is H.264 rather than HEVC, deliberately. HEVC is denser per bit, but
Safari has been known to report support for a codec its recorder then produces
nothing for, and a take that silently yields zero bytes costs far more than the
few percent of quality HEVC would have bought at this bitrate.

**4K is about 180 MB per minute.** A five minute take is close to a gigabyte,
which is why chunks are written to disk as they're captured rather than held in
memory — a take that size would otherwise crash the tab. Keep an eye on free
space if you're recording several long takes before saving them.

## The one visible difference

While capturing, the status line at the very bottom reads

```
main ⏵⏵ · 64% context left
```

instead of

```
main · 64% context left
```

Two chevrons, 10px, dim grey, on the bottom bar. That's the whole tell — it
exists so you can confirm it's actually rolling rather than discovering a
failed take afterwards. Nothing else on screen changes: no timer, no colour
shift, no dot, no border.

The `*` marking unsaved clips can appear alongside it (`main* ⏵⏵ · …`). Both
read as ordinary git status markers.

## What it will not do

- **No sound.** The capture stream's audio never reaches an output. The sink
  `<video>` is built from video tracks only, so there is no audio path to the
  speaker at all — independent of the muted flag. There is no `Audio`,
  no `AudioContext`, and no `navigator.vibrate` anywhere in the codebase.
- **No light.** `torch` and `fillLightMode` are never requested, so the LED
  cannot fire. There is no screen flash, no flashing element, and no animation
  that changes overall screen brightness.
- **No notifications.** The service worker caches files and nothing else — no
  push, no badges, no background sync.

## What iOS will do regardless

- **The green camera indicator** appears in the status bar whenever the camera
  is held, and cannot be suppressed by any app, native or web. Point the lens
  at her and the screen at you and it is never in view.
- **Photos cannot be written to silently, and the share sheet cannot be drawn
  in the console.** No web app has permission to write to Photos directly, and
  the sheet is system UI. What the app controls is when it appears: `done`
  shows nothing, and `save` pops the sheet whenever you're ready.

## Setup

1. Serve over HTTPS. GitHub Pages off this repo works — Settings → Pages →
   deploy from a branch, root folder. Camera access requires a secure origin,
   so a plain `file://` or `http://` host will not work.
   **Point Pages at the branch the code is actually on.** The work lives on
   `claude/hidden-video-recorder-pwa-d97ytm`; `main` has only the README, so a
   Pages site built from `main` will serve nothing. After each push, give the
   Pages build a minute, then confirm the boot line's build number moved.
2. Open the page in Safari on the phone.
3. Share → Add to Home Screen. Launch it from the home screen icon, not from
   Safari — the home-screen copy runs without browser chrome.
4. Grant camera and microphone when asked. The prompt fires on your first tap
   inside the app, so get it out of the way in advance.

## Before it matters

Do one dry run on the actual phone:

- Take a minute on `ac1` and a minute on `ac2`, then `save` both and compare
  them in Photos. That is the only way to settle which lens suits the room
  she'll actually be singing in.
- Run `diag` right after `done`. If `take:` shows `0 chunks`, the recording
  never produced video and the `errors:` line says why.
- Run `lens` after each trigger and note the resolution it reports. If the
  ultra wide comes back at 1080p rather than 4K, that's iOS's cap for that
  lens, not a fault.
- Confirm the permission grant survives closing and reopening the app. If it
  re-prompts, open the app and tap once a few minutes early so the prompt is
  already dealt with.
- Prop the phone against something at roughly her eye level. A handheld phone
  that is supposedly being typed on does not hold a steady frame.

## Behaviour worth knowing

- **Audio is captured flat.** Echo cancellation, noise suppression, and auto
  gain are all switched off. Those defaults are tuned for phone calls and will
  duck sustained notes and pump the level — a sung note survives without them.
- **Backgrounding ends the take.** iOS suspends capture when the app leaves the
  foreground, so leaving the app finalises the clip rather than letting it
  decay into an unplayable file. It's stored like any other, ready for `save`.
- **Screen stays awake** while capturing, via the Wake Lock API. A sleeping
  phone would tear down the stream.
- **Failsafe stop at 25 minutes.** Adjust `MAX_MS` in `recorder.js`.
- **Dismissing the share sheet costs nothing.** The clip stays in storage —
  `save` again whenever. Nothing is deleted until it has been handed off.
- **Tuning:** `BPP` in `recorder.js` sets bits per pixel per frame, and the
  requested resolution is the `CONSTRAINTS.video` block just above it.

## Files

```
index.html        shell + the 1px capture sink
style.css         terminal chrome
transcript.js     canned session content
store.js          IndexedDB chunk streaming and clip storage
recorder.js       camera, lens selection, MediaRecorder, wake lock
app.js            renderer, command routing, status line
sw.js             app-shell cache
```
