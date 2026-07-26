/* Canned session content.
 *
 * Every turn is a flat list of steps. A step is either:
 *   ['spin', label, ms]        transient spinner line, removed when it ends
 *   [cls, text, pauseAfterMs]  a permanent line
 *
 * Keep every line at or under 50 characters. At 12px on a 6.3" screen that is
 * the wrap point, and a wrapped continuation line is the fastest way to make
 * the transcript look synthetic.
 *
 * The `rec` and `done` turns are built from exactly the same vocabulary as the
 * filler turns on purpose: nothing about the transcript distinguishes a
 * recording turn from any other one.
 */
(function (global) {
  'use strict';

  var CWD = '~/projects/relay';

  /* Bump on every deploy. Shown at boot so the build running on the phone can
     be identified without typing anything — a stale home-screen install is
     otherwise indistinguishable from a broken one, since unknown words just
     fall through to filler turns. */
  var BUILD = 5;

  var BOOT = [
    ['banner', '✻ Welcome to Claude Code', 90],
    ['hint', '', 0],
    ['hint', '  /help for help, /status for your setup', 0],
    ['hint', '', 0],
    ['hint', '  v0.4.' + BUILD + ' · cwd: ' + CWD, 260],
    ['hint', '', 0],
    ['result', '⏺ Resumed session — 14 messages restored', 0],
    ['hint', '', 0]
  ];

  /* Turns used for any input that isn't a control word. */
  var FILLER = [
    [
      ['spin', 'Thinking', 1500],
      ['assist', '⏺ Let me look at how the queue drains first.', 700],
      ['assist', '', 0],
      ['tool', '⏺ Read(src/queue/drain.ts)', 900],
      ['result', '  ⎿  Read 186 lines', 1100],
      ['assist', '', 0],
      ['assist', '⏺ The drain loop awaits each job serially, so', 60],
      ['assist', '  one slow handler stalls the whole queue.', 0]
    ],
    [
      ['spin', 'Searching', 1200],
      ['tool', '⏺ Grep(pattern: "createSession", path: "src")', 800],
      ['result', '  ⎿  Found 6 files', 700],
      ['result', '     src/session/store.ts', 0],
      ['result', '     src/session/refresh.ts', 0],
      ['result', '     src/http/middleware.ts', 900],
      ['assist', '', 0],
      ['assist', '⏺ Only the store writes the TTL. The other', 60],
      ['assist', '  two just read it.', 0]
    ],
    [
      ['spin', 'Working', 1700],
      ['tool', '⏺ Update(src/session/store.ts)', 1000],
      ['result', '  ⎿  Updated store.ts with 12 additions and', 0],
      ['result', '     4 removals', 1300],
      ['assist', '', 0],
      ['tool', '⏺ Bash(npm test -- session)', 2400],
      ['result', '  ⎿  PASS  test/session.test.ts (2.1s)', 0],
      ['result', '     Tests: 18 passed, 18 total', 0]
    ],
    [
      ['spin', 'Pondering', 1400],
      ['assist', '⏺ Two ways to go here:', 500],
      ['assist', '', 0],
      ['assist', '  1. Cap the client retry at 3 attempts', 90],
      ['assist', '  2. Move it server-side so every caller', 0],
      ['assist', '     inherits the backoff', 700],
      ['assist', '', 0],
      ['assist', '⏺ Second one is less code. Going with that.', 0]
    ],
    [
      ['spin', 'Analyzing', 1300],
      ['tool', '⏺ Read(package.json)', 700],
      ['result', '  ⎿  Read 48 lines', 800],
      ['assist', '', 0],
      ['tool', '⏺ Bash(npx tsc --noEmit)', 3100],
      ['result', '  ⎿  (no output)', 600],
      ['assist', '', 0],
      ['assist', '⏺ Types are clean.', 0]
    ],
    [
      ['spin', 'Working', 1600],
      ['tool', '⏺ Glob(**/*.test.ts)', 800],
      ['result', '  ⎿  Found 23 files', 1000],
      ['assist', '', 0],
      ['assist', '⏺ Nothing covers the reconnect path yet.', 60],
      ['assist', '  Adding a case for it.', 600],
      ['assist', '', 0],
      ['tool', '⏺ Write(test/reconnect.test.ts)', 1200],
      ['result', '  ⎿  Wrote 61 lines', 0]
    ],
    [
      ['spin', 'Thinking', 1900],
      ['assist', '⏺ Timestamps are written in local time and', 60],
      ['assist', '  read back as UTC, so anything after 5pm', 60],
      ['assist', '  lands on the next day.', 800],
      ['assist', '', 0],
      ['tool', '⏺ Update(src/lib/time.ts)', 1000],
      ['result', '  ⎿  Updated time.ts with 6 additions and 6', 0],
      ['result', '     removals', 0]
    ],
    [
      ['spin', 'Working', 1500],
      ['tool', '⏺ Bash(git status --short)', 900],
      ['result', '  ⎿   M src/queue/drain.ts', 0],
      ['result', '      M src/session/store.ts', 0],
      ['result', '     ?? test/reconnect.test.ts', 900],
      ['assist', '', 0],
      ['assist', '⏺ Three files touched. Commit them together?', 0]
    ],
    [
      ['spin', 'Cogitating', 2100],
      ['assist', '⏺ Traced it. The listener is registered in', 60],
      ['assist', '  the render path, so every re-render adds', 60],
      ['assist', '  another one and none get torn down.', 700],
      ['assist', '', 0],
      ['tool', '⏺ Update(src/ui/panel.ts)', 1100],
      ['result', '  ⎿  Updated panel.ts with 9 additions and 3', 0],
      ['result', '     removals', 0]
    ]
  ];

  /* Turn played when capture starts. Ends on a long-running process so that
     sitting at the prompt for several minutes reads as normal. */
  var START = [
    ['spin', 'Working', 1400],
    ['tool', '⏺ Bash(npm run dev -- --watch)', 1500],
    ['result', '  ⎿  ▲ ready on http://localhost:3000', 0],
    ['result', '     watching 214 files for changes', 900],
    ['assist', '', 0],
    ['assist', '⏺ Dev server is up. I’ll watch the rebuilds.', 0]
  ];

  /* Turn played when capture stops. */
  var STOP = [
    ['spin', 'Working', 1200],
    ['tool', '⏺ Bash(npm run build)', 2000],
    ['result', '  ⎿  ✓ compiled successfully in 4.2s', 0],
    ['result', '     output written to dist/', 800],
    ['assist', '', 0],
    ['assist', '⏺ Build is clean. Nothing left to do here.', 0]
  ];

  /* Shown if capture could not start. Reads as an ordinary recoverable error. */
  var FAILED = [
    ['result', '  ⎿  Error: EADDRINUSE :::3000', 0],
    ['assist', '', 0],
    ['assist', '⏺ Port is already bound. Retry once the old', 60],
    ['assist', '  process exits.', 0]
  ];

  /* Share sheet was dismissed or blocked — the clip is still in storage.
     Deliberately unlike NOTHING, so the two are told apart at a glance. */
  var HANDOFF = [
    ['spin', 'Working', 700],
    ['tool', '⏺ Bash(git push)', 900],
    ['result', '  ⎿  error: failed to push some refs', 0],
    ['result', '     hint: run it again once resolved', 0]
  ];

  /* A clip went to the share sheet and was taken. */
  var PUSHED = [
    ['spin', 'Working', 800],
    ['tool', '⏺ Bash(git push)', 1100],
    ['result', '  ⎿  Enumerating objects: 1, done.', 0],
    ['result', '     3af4052..c597f9a  main -> main', 0]
  ];

  /* Nothing waiting to hand off. */
  var NOTHING = [
    ['spin', 'Working', 700],
    ['tool', '⏺ Bash(git push)', 800],
    ['result', '  ⎿  Everything up-to-date', 0]
  ];

  global.Transcript = {
    cwd: CWD,
    build: BUILD,
    boot: BOOT,
    filler: FILLER,
    start: START,
    stop: STOP,
    failed: FAILED,
    handoff: HANDOFF,
    pushed: PUSHED,
    nothing: NOTHING,
    spinnerFrames: ['✢', '✳', '∗', '✻', '✽']
  };
})(this);
