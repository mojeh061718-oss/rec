/* Session shell: renders the transcript, routes the control words, and keeps
 * the status line honest for the operator without announcing anything.
 *
 * Control words (all of them produce ordinary-looking turns):
 *   agent-call1  begin capture on the 0.5x ultra wide
 *   agent-call2  begin capture on the 1x main camera
 *   done         end capture — stores the clip, shows nothing
 *   save         hand the oldest stored clip to the iOS share sheet
 *   clips        report how many clips are waiting
 *   warm         take the camera without recording (clears the prompt)
 *   cool         release the camera entirely
 *   lens         report the live lens and its negotiated resolution
 *   lens next    move to the next back lens
 *
 * `done` deliberately does not open the share sheet. That sheet is system UI
 * and cannot be replaced by anything drawn in here, so the only thing worth
 * controlling is when it appears — `save`, once the room is empty.
 *
 * Anything else plays a filler turn.
 */
(function () {
  'use strict';

  var T = window.Transcript;
  var out = document.getElementById('out');
  var scroll = document.getElementById('scroll');
  var form = document.getElementById('entry');
  var input = document.getElementById('line');
  var statusCwd = document.getElementById('status-cwd');
  var statusMode = document.getElementById('status-mode');

  var recorder = new Recorder(document.getElementById('sink'));
  var queue = [];
  var busy = false;
  var fillerIndex = 0;
  var contextLeft = 71;

  /* Rendering ---------------------------------------------------------- */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function atBottom() {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
  }

  function toBottom() {
    scroll.scrollTop = scroll.scrollHeight;
  }

  function emit(cls, text) {
    var stick = atBottom();
    var row = document.createElement('div');
    row.className = 'row ' + cls;
    row.textContent = text;
    out.appendChild(row);
    if (stick) toBottom();
    return row;
  }

  /* Transient spinner, in the shape a real session shows while it works. */
  function spin(label, ms) {
    var row = emit('spin', '');
    var frame = 0;
    var started = Date.now();
    var tokens = 0.4 + Math.random() * 1.9;

    function paint() {
      var secs = Math.floor((Date.now() - started) / 1000);
      row.textContent = T.spinnerFrames[frame % T.spinnerFrames.length] + ' ' +
        label + '… (' + secs + 's · ↑ ' + tokens.toFixed(1) + 'k tokens)';
      frame++;
    }
    paint();
    var timer = setInterval(paint, 130);

    return sleep(ms).then(function () {
      clearInterval(timer);
      row.parentNode.removeChild(row);
    });
  }

  function playTurn(steps) {
    var i = 0;
    function next() {
      if (i >= steps.length) return Promise.resolve();
      var step = steps[i++];
      if (step[0] === 'spin') return spin(step[1], step[2]).then(next);
      emit(step[0], step[1]);
      return (step[2] ? sleep(step[2]) : Promise.resolve()).then(next);
    }
    return next();
  }

  function nextFiller() {
    var turn = T.filler[fillerIndex % T.filler.length];
    fillerIndex++;
    return turn;
  }

  /* Status line -------------------------------------------------------- */

  function paintStatus() {
    statusCwd.textContent = T.cwd;
    // The only difference between capturing and not capturing anywhere on
    // screen: two chevrons in 11px on the bottom bar. Reads as the
    // auto-accept indicator a real session shows.
    statusMode.textContent = recorder.recording
      ? 'main ⏵⏵ · ' + contextLeft + '% context left'
      : 'main · ' + contextLeft + '% context left';
  }

  /* Capture handoff ----------------------------------------------------
   *
   * Stopping never opens the share sheet. Clips sit in storage until `save`
   * asks for one, which is the whole point: the sheet is system UI that
   * cannot be drawn inside the console, so the only thing worth controlling
   * is when it shows up.
   */

  function handoff() {
    return Store.oldest().then(function (rec) {
      if (!rec) return 'empty';
      return Recorder.save(Store.toFile(rec)).then(function (result) {
        if (result === 'saved' || result === 'downloaded') {
          return Store.remove(rec.id).then(function () { return 'saved'; });
        }
        return 'kept';   // sheet dismissed — clip stays put
      }, function () { return 'kept'; });
    });
  }

  recorder.onAutoStop = function (rec, err) {
    paintStatus();
    if (!rec && err) playTurn(T.failed);
  };

  /* Commands ----------------------------------------------------------- */

  // Collapses case, spacing and punctuation, so "agent call-1", "Agent Call 1"
  // and "agentcall1" are all the same word. Typos are not — a filler turn is
  // the safe failure, and the status bar says whether it took.
  function normalise(text) {
    return text.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /* Reports the live lens as an ordinary settings read. */
  function lensTurn(report) {
    var line = '  ⎿  profile: ' + (report.active || report.wantLabel);
    var steps = [
      ['spin', 'Working', 900],
      ['tool', '⏺ Read(.claude/settings.json)', 700],
      [ 'result', line, 0]
    ];
    if (report.size) {
      steps.push(['result', '     ' + report.size + ' @ ' + report.mbps + ' Mbps', 0]);
    }
    return steps;
  }

  /* Pending clips, as a stash listing — one entry per clip. */
  function clipsTurn(rows) {
    var steps = [
      ['spin', 'Working', 700],
      ['tool', '⏺ Bash(git stash list)', 800]
    ];
    if (!rows.length) {
      steps.push(['result', '  ⎿  (empty)', 0]);
      return steps;
    }
    rows.forEach(function (r, i) {
      var mb = Math.round(r.size / 1048576);
      steps.push([
        'result',
        (i === 0 ? '  ⎿  ' : '     ') + 'stash@{' + i + '}: WIP (' + mb + 'M)',
        0
      ]);
    });
    return steps;
  }

  function beginOn(kind) {
    // Kick capture off inside the gesture, then let the turn play out
    // alongside it. The transcript never waits on the camera.
    var started = recorder.startOn(kind).then(function () {
      paintStatus();
      return true;
    }, function () {
      return false;
    });
    return playTurn(T.start).then(function () {
      return started;
    }).then(function (ok) {
      if (!ok) return playTurn(T.failed);
    });
  }

  function run(raw) {
    var cmd = normalise(raw);

    if (cmd === 'lens' || cmd === 'lensnext') {
      var got = cmd === 'lensnext'
        ? recorder.cycleLens()
        : recorder.warm().then(function () { return recorder.lensReport(); },
                              function () { return recorder.lensReport(); });
      return got.then(function (report) { return playTurn(lensTurn(report)); });
    }

    if (cmd === 'agentcall1') return beginOn('ultrawide');
    if (cmd === 'agentcall2') return beginOn('wide');

    if (cmd === 'done') {
      if (!recorder.recording) return playTurn(nextFiller());
      var stopped = recorder.stop();
      paintStatus();
      return stopped.then(function (rec) {
        paintStatus();
        return rec ? playTurn(T.stop) : playTurn(T.failed);
      }, function () {
        paintStatus();
        return playTurn(T.failed);
      });
    }

    if (cmd === 'save') {
      if (recorder.recording) return playTurn(nextFiller());
      return handoff().then(function (result) {
        if (result === 'empty') return playTurn(T.nothing);
        return playTurn(result === 'saved' ? T.pushed : T.handoff);
      });
    }

    if (cmd === 'clips') {
      return Store.list().then(function (rows) { return playTurn(clipsTurn(rows)); });
    }

    if (cmd === 'warm') {
      return recorder.warm().then(function () {
        return playTurn(nextFiller());
      }, function () {
        return playTurn(T.failed);
      });
    }

    if (cmd === 'cool' || cmd === 'exit') {
      recorder.release();
      paintStatus();
      return playTurn(nextFiller());
    }

    return playTurn(nextFiller());
  }

  /* Input -------------------------------------------------------------- */

  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    var raw = queue.shift();

    emit('user', '> ' + raw);
    emit('assist', '');
    contextLeft = Math.max(4, contextLeft - 1 - Math.floor(Math.random() * 2));
    paintStatus();

    run(raw).then(function () {
      emit('assist', '');
      busy = false;
      pump();
    }, function () {
      emit('assist', '');
      busy = false;
      pump();
    });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var raw = input.value;
    input.value = '';
    if (!raw.trim()) return;
    queue.push(raw);
    toBottom();
    pump();
  });

  // Keep the caret live; a terminal that loses focus mid-scene looks wrong.
  document.addEventListener('pointerup', function (ev) {
    if (ev.target === input) return;
    if (window.getSelection && String(window.getSelection())) return;
    input.focus();
  });

  window.addEventListener('resize', function () {
    if (atBottom()) toBottom();
  });

  /* Boot --------------------------------------------------------------- */

  paintStatus();
  playTurn(T.boot).then(function () { input.focus(); });

  // Ask iOS not to evict stored clips, and rescue any take that was cut short
  // by the app being killed mid-recording.
  Store.persist();
  Store.recover();

  // Deal with the permission sheet at the first touch, long before it could
  // matter. Silent either way — a refusal here just means `rec` asks later.
  function warmOnce() {
    recorder.warm().catch(function () {});
  }
  document.addEventListener('pointerdown', warmOnce, { once: true });
  document.addEventListener('keydown', warmOnce, { once: true });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
