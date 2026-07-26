# Terminal

A PWA that looks like a coding session and captures video without showing a
preview, a timer, or any recording state on screen.

## Words

Type these at the prompt. Every one of them produces an ordinary-looking turn —
the transcript gives no hint that any of them is different from the others.

| Word   | Effect |
| ------ | ------ |
| `rec`  | starts capturing |
| `done` | stops, then opens the iOS share sheet with the clip attached |
| `warm` | takes the camera without recording — clears the permission prompt early |
| `cool` | releases the camera (green indicator goes out) |

Anything else you type plays a filler turn, so you can keep typing naturally
for as long as you want.

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
- **Photos cannot be written to silently.** No web app has that permission.
  `done` opens the share sheet with the clip already attached; one tap on
  "Save Video" puts it in the camera roll. That tap happens after the singing
  is over.

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

- Type `rec`, wait a minute, type `done`, confirm the clip lands in Photos and
  the audio sounds right.
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
  decay into an unplayable file. Recovered clips still go through the share
  sheet.
- **Screen stays awake** while capturing, via the Wake Lock API. A sleeping
  phone would tear down the stream.
- **Failsafe stop at 25 minutes.** Adjust `MAX_MS` in `recorder.js`.
- **If you dismiss the share sheet**, the clip is held in memory. Type `done`
  again to re-open it. Closing the app before that loses it.
- **Roughly 5 Mbps**, so about 40 MB per minute. Tune `VIDEO_BPS` in
  `recorder.js` if you want longer takes.

## Files

```
index.html        shell + the 1px capture sink
style.css         terminal chrome
transcript.js     canned session content
recorder.js       camera, MediaRecorder, wake lock, share handoff
app.js            renderer, command routing, status line
sw.js             app-shell cache
```
