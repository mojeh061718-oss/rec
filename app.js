/* Session shell: renders the transcript, routes the control words, and keeps
 * the status line honest for the operator without announcing anything.
 *
 * Control words (all of them produce ordinary-looking turns):
 *   ac1          begin capture on the 0.5x ultra wide
 *   ac2          begin capture on the 1x main camera
 *   f1           begin capture on the front camera
 *   done         end capture, store the clip, and open the share sheet
 *   save         hand the oldest stored clip to the iOS share sheet
 *   clips        list stored clips, oldest first, ✓ = already handed off
 *   pending      list only the clips not yet handed off
 *   clear        wipe the screen and delete clips already handed off
 *   drop         delete clips already handed off
 *   drop all     delete every stored clip, saved or not
 *   diag         real internals — the one output here that isn't theatre
 *   update       drop the cached build and reload (clips are not touched)
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
  var pending = 0;          // clips stored and waiting for `save`
  var lastCrash = null;     // operation in flight when the app last died

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
    // Two tells, both in 10px on the bottom bar, both reading as ordinary
    // git status:
    //   ⏵⏵  capturing right now
    //   *   clips are stored and waiting for `save`
    // The asterisk matters more than it looks — `done` prints a clean-looking
    // build message, so without it there is nothing to say a take exists.
    var branch = 'main' + (pending > 0 ? '*' : '');
    statusMode.textContent = recorder.recording
      ? branch + ' ⏵⏵ · ' + contextLeft + '% context left'
      : branch + ' · ' + contextLeft + '% context left';
  }

  /* Recount clips still waiting to be handed off, then repaint. Clips that
     have been saved stay in storage but no longer raise the asterisk. */
  function refreshPending() {
    return Store.list().then(function (rows) {
      pending = rows.filter(function (r) { return !r.saved; }).length +
                Recorder.orphans.length;
      paintStatus();
      return rows;
    }, function () { return []; });
  }

  /* Capture handoff ----------------------------------------------------
   *
   * Stopping never opens the share sheet. Clips sit in storage until `save`
   * asks for one, which is the whole point: the sheet is system UI that
   * cannot be drawn inside the console, so the only thing worth controlling
   * is when it shows up.
   */

  /* Hand the oldest unsaved clip to the share sheet.
   *
   * Nothing is ever deleted here. iOS resolves a share before Photos has
   * necessarily written anything — a denied permission or a cancelled
   * sub-sheet still comes back as success — and deleting on that word has
   * already cost one recording. Clips are marked saved and kept; `drop`
   * removes them when you have confirmed they are in the camera roll.
   */
  /* Breadcrumb that outlives a crash. If the tab dies mid-share this is the
     only evidence left, and `diag` reports it on the next launch. */
  function mark(what) {
    try {
      if (what) localStorage.setItem('terminal.inflight', what);
      else localStorage.removeItem('terminal.inflight');
    } catch (e) {}
  }

  /* Offer one specific clip to the share sheet. */
  function shareRecord(rec) {
    var mb = Math.round((rec.size || 0) / 1048576);
    mark('save ' + Store.nameFor(rec) + ' ' + mb + 'M');

    return Store.fileFor(rec).then(function (file) {
      if (!file) { mark(null); return 'missing'; }
      return Recorder.save(file).then(function (result) {
        mark(null);
        if (result !== 'saved') return 'kept';
        var i = Recorder.orphans.indexOf(rec);
        rec.saved = true;
        if (i !== -1) {
          // Never made it to storage; put it there now that it is safe.
          Recorder.orphans.splice(i, 1);
          return Store.put(rec).then(function () { return 'saved'; },
                                     function () { return 'saved'; });
        }
        // Wait for the background write before marking, so the flag can't be
        // overwritten by a put still in flight. Metadata only — the video is
        // already stored and is not rewritten.
        return (recorder.lastWrite || Promise.resolve())
          .catch(function () {})
          .then(function () { return Store.putMeta(rec); })
          .then(function () { return 'saved'; }, function () { return 'saved'; });
      }, function () { mark(null); return 'kept'; });
    }, function () { mark(null); return 'kept'; });
  }

  /* Oldest clip still waiting. Orphans finished but could not be stored and
     only live for this session, so they go first. */
  function handoff() {
    var pick = Recorder.orphans.length
      ? Promise.resolve(Recorder.orphans[0])
      : Store.unsaved().then(function (rows) { return rows[0] || null; });

    return pick.then(function (rec) {
      return rec ? shareRecord(rec) : 'empty';
    }, function () { return 'empty'; });
  }

  recorder.onAutoStop = function (rec, err) {
    paintStatus();
    refreshPending();
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

  function clock(at) {
    var d = new Date(at);
    return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' +
           (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }

  /* Every stored clip, oldest first. A tick marks one already handed to the
     share sheet; those are the only ones `drop` will remove. */
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
        (i === 0 ? '  ⎿  ' : '     ') + 'stash@{' + i + '}: ' + clock(r.at) +
          ' · ' + mb + 'M' + (r.saved ? ' ✓' : ''),
        0
      ]);
    });
    return steps;
  }

  function droppedTurn(n, what) {
    return [
      ['spin', 'Working', 700],
      ['tool', '⏺ Bash(git stash drop)', 800],
      ['result', '  ⎿  Dropped ' + n + ' ' + what, 0]
    ];
  }

  /* The only truthful output in the app. Everything else is canned; this
     reports what actually happened, so a failure on the phone is legible
     instead of hiding behind a plausible-looking build error. */
  function diagTurn(r, rows) {
    var stored = rows.reduce(function (n, x) { return n + x.size; }, 0);
    var lines = [
      'build:   ' + T.build,
      'camera:  ' + r.camera + (r.recording ? ' · REC' : ''),
      'codec:   ' + r.mime.replace('video/', '').slice(0, 30),
      'opts:    ' + r.opts,
      'take:    ' + r.chunks + ' chunks / ' + r.mb + ' MB / ' + r.held,
      'stored:  ' + rows.length + ' clip(s) / ' +
        Math.round(stored / 1048576) + ' MB',
      'unsaved: ' + rows.filter(function (x) { return !x.saved; }).length,
      'share:   ' + r.lastShare
    ];
    if (r.orphanCount) {
      lines.push('orphan:  ' + r.orphanCount + ' × ' + r.orphan + ' MB unstored');
    }
    if (lastCrash) lines.push('! died during: ' + lastCrash.slice(0, 34));
    if (r.errors.length) {
      r.errors.forEach(function (e) { lines.push('! ' + e.slice(0, 40)); });
    } else {
      lines.push('errors:  none');
    }

    var steps = [
      ['spin', 'Working', 700],
      ['tool', '⏺ Bash(tail -n 20 .claude/debug.log)', 800]
    ];
    lines.forEach(function (l, i) {
      steps.push(['result', (i === 0 ? '  ⎿  ' : '     ') + l, 0]);
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

    if (cmd === 'ac1' || cmd === 'agentcall1') return beginOn('ultrawide');
    if (cmd === 'ac2' || cmd === 'agentcall2') return beginOn('wide');
    if (cmd === 'f1') return beginOn('front');

    // Drops the app-shell cache and the service worker, then reloads. Stored
    // clips live in IndexedDB and are untouched.
    if (cmd === 'update') {
      return caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }).catch(function () {}).then(function () {
        if (!navigator.serviceWorker) return [];
        return navigator.serviceWorker.getRegistrations().catch(function () { return []; });
      }).then(function (regs) {
        return Promise.all((regs || []).map(function (r) {
          return r.unregister().catch(function () {});
        }));
      }).then(function () {
        location.reload();
      });
    }

    if (cmd === 'diag') {
      return Store.list().then(function (rows) {
        return playTurn(diagTurn(recorder.report(), rows));
      });
    }

    if (cmd === 'done') {
      if (!recorder.recording) return playTurn(nextFiller());
      var stopped = recorder.stop();
      paintStatus();
      return stopped.then(function (rec) {
        if (!rec) { paintStatus(); return playTurn(T.failed); }
        pending++;
        paintStatus();
        // Share straight away, before any of the turn's animation runs. The
        // keypress that submitted `done` is what authorises the sheet, and
        // that authorisation expires in seconds — playing the turn first
        // would spend it on a spinner.
        return shareRecord(rec).then(function (result) {
          return refreshPending().then(function () {
            return playTurn(result === 'saved' ? T.stop : T.handoff);
          });
        });
      }, function () {
        paintStatus();
        return playTurn(T.failed);
      });
    }

    if (cmd === 'save') {
      if (recorder.recording) return playTurn(nextFiller());
      return handoff().then(function (result) {
        return refreshPending().then(function () {
          if (result === 'empty') return playTurn(T.nothing);
          if (result === 'missing') return playTurn(T.failed);
          return playTurn(result === 'saved' ? T.pushed : T.handoff);
        });
      });
    }

    // Wipes the screen and clears out clips already handed off. Unsaved
    // recordings are never touched — `drop all` is still the only way to
    // remove those, deliberately.
    if (cmd === 'clear') {
      if (recorder.recording) { out.textContent = ''; return Promise.resolve(); }
      return Store.removeSaved().then(function (n) {
        return refreshPending().then(function () {
          out.textContent = '';
          return playTurn(T.boot).then(function () {
            if (n) emit('result', '  ⎿  Dropped ' + n + ' saved');
          });
        });
      }, function () { out.textContent = ''; return playTurn(T.boot); });
    }

    if (cmd === 'pending' || cmd === 'unsaved') {
      return refreshPending().then(function (rows) {
        return playTurn(clipsTurn(rows.filter(function (r) { return !r.saved; })));
      });
    }

    if (cmd === 'clips') {
      return refreshPending().then(function (rows) { return playTurn(clipsTurn(rows)); });
    }

    // Removes only clips already handed off. `drop all` takes everything, and
    // is the one command here that can destroy an unsaved recording.
    if (cmd === 'drop' || cmd === 'dropall') {
      if (recorder.recording) return playTurn(nextFiller());
      var all = cmd === 'dropall';
      return (all ? Store.removeAll() : Store.removeSaved()).then(function (n) {
        return refreshPending().then(function () {
          return playTurn(droppedTurn(n, all ? 'stash entries' : 'saved'));
        });
      }, function () { return playTurn(T.failed); });
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
  // Recover anything cut short by a kill, clear out clips that were saved
  // more than two days ago, then show the waiting count. A clip left over
  // from an earlier session shows its asterisk at boot.
  Store.migrate()
    .then(function () { return Store.recover(); })
    .then(function () { return Store.prune(48 * 60 * 60 * 1000); })
    .then(refreshPending, refreshPending);

  // Anything left here means the app died mid-operation last time.
  try {
    var stuck = localStorage.getItem('terminal.inflight');
    if (stuck) {
      lastCrash = stuck;
      localStorage.removeItem('terminal.inflight');
    }
  } catch (e) {}

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
