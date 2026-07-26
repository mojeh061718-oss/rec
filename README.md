# Terminal

A PWA that looks like a coding session and captures video without showing a
preview, a timer, or any recording state on screen.

## Words

Type these at the prompt. Every one of them produces an ordinary-looking turn —
the transcript gives no hint that any of them is different from the others.

| Word          | Effect |
| ------------- | ------ |
| `agent-call1` | starts capturing on the **0.5× ultra wide** |
| `agent-call2` | starts capturing on the **1× main camera** |
| `done`        | stops. Stores the clip. Shows nothing. |
| `save`        | opens the share sheet with the oldest stored clip |
| `clips`       | reports how many clips are waiting |
| `warm`        | takes the camera without recording — clears the permission prompt early |
| `cool`        | releases the camera (green indicator goes out) |
| `lens`        | reports the live lens and its negotiated resolution |
| `lens next`   | moves to the next back lens |

Case, spacing and punctuation don't matter — `Agent Call 1`, `agent-call1` and
`agentcall1` are all the same word. A typo isn't: it just plays a filler turn
like any other text, and the status line tells you capture didn't start.

Anything else you type plays a filler turn, so you can keep typing naturally
for as long as you want.

## Saving, and why `done` doesn't

The iOS share sheet is system UI. Nothing drawn inside the app can replace it,
and no web app can write to Photos without it. So the only thing worth
controlling is *when* it appears — and it no longer appears when you stop.

`done` writes the clip to storage and shows nothing at all. Later, once the
room is empty, `save` pops the sheet for the oldest clip; one tap on "Save
Video" puts it in the camera roll. `save` again for the next one. `clips` tells
you how many are waiting.

Clips live in IndexedDB, so they survive closing the app, force-quitting it,
and rebooting the phone. If the app is killed mid-recording, the partial take
is recovered and assembled on next launch rather than lost.

## Lenses

`agent-call1` is the **0.5× ultra wide** — the widest field of view, and the
safer default when you can't watch a preview to check framing.

`agent-call2` is the **1× main camera** — sharper, much better in low light,
and on an iPhone 16 Pro it's the lens that actually reaches 4K.

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
the room is lit, `agent-call2` will look considerably better. Use `agent-call1`
when you're unsure she'll stay in frame.

## Quality

It asks for 4K30 and takes whatever the lens actually gives back — 4K is a
request, not a guarantee, and it differs per lens. Bitrate then follows the
resolution that was really negotiated rather than a fixed number, at roughly
27 Mbps for 4K and 6.8 Mbps for 1080p, which is comparable to what the stock
camera app writes. Audio is 256 kbps, with headroom for singing rather than
speech.

HEVC is preferred over H.264 where the phone offers it — it's the codec the
phone's own camera writes, Photos handles it natively, and it holds more detail
per bit at 4K.

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

Two chevrons, 11px, dim grey, on the bottom bar. That's the whole tell — it
exists so you can confirm it's actually rolling rather than discovering a
failed take afterwards. Nothing else on screen changes: no timer, no colour
shift, no dot, no border.

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
2. Open the page in Safari on the phone.
3. Share → Add to Home Screen. Launch it from the home screen icon, not from
   Safari — the home-screen copy runs without browser chrome.
4. Grant camera and microphone when asked. The prompt fires on your first tap
   inside the app, so get it out of the way in advance.

## Before it matters

Do one dry run on the actual phone:

- Take a minute on `agent-call1` and a minute on `agent-call2`, then `save`
  both and compare them in Photos. That is the only way to settle which lens
  suits the room she'll actually be singing in.
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
