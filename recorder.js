/* Capture layer.
 *
 * Hard guarantees this file is written to keep:
 *   - No audio is ever played back. The sink <video> receives a stream built
 *     from video tracks only, so there is no audio path to the speaker at all,
 *     independent of the muted attribute.
 *   - No torch / fill light. `torch` and `fillLightMode` are never requested,
 *     so the LED cannot come on.
 *   - No vibration, no notifications, no sound effects anywhere in the app.
 *   - Nothing in here touches the DOM outside the 1px transparent sink.
 */
(function (global) {
  'use strict';

  var VIDEO_BPS = 5000000;
  var AUDIO_BPS = 128000;
  var TIMESLICE_MS = 4000;      // flush cadence — bounds loss on interruption
  var MAX_MS = 25 * 60 * 1000;  // failsafe stop

  var LENS_KEY = 'terminal.lens';
  var DEFAULT_LENS = 'ultrawide';

  var CONSTRAINTS = {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 }
    },
    audio: {
      // Defaults here are tuned for speech on a phone call: they duck sustained
      // notes and pump the gain. All three are off so a sung note survives.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 }
    }
  };

  var MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=h264,opus',
    'video/webm'
  ];

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (var i = 0; i < MIME_CANDIDATES.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i];
      } catch (e) { /* older impls throw instead of returning false */ }
    }
    return '';
  }

  function extFor(mime) {
    return mime && mime.indexOf('webm') !== -1 ? 'webm' : 'mp4';
  }

  /* Lens selection ------------------------------------------------------
   *
   * iOS only reveals per-lens devices once camera permission has been
   * granted, and only under labels — there is no capability that says
   * "this one is the 0.5x". So: acquire once to get permission, read the
   * labels, and re-acquire on the right device if the first pick was wrong.
   *
   * Two routes to 0.5x, tried in order:
   *   1. A discrete "Back Ultra Wide Camera" device, if one is exposed.
   *   2. The virtual dual/triple device pinned to its minimum zoom, which
   *      on a multi-lens iPhone is the ultra-wide.
   * If neither is available it stays on the standard back camera, which is
   * what every browser gives you by default.
   */

  function classify(label) {
    var l = (label || '').toLowerCase();
    if (l.indexOf('front') !== -1) return 'front';
    if (l.indexOf('ultra') !== -1) return 'ultrawide';
    if (l.indexOf('tele') !== -1) return 'telephoto';
    if (l.indexOf('dual') !== -1 || l.indexOf('triple') !== -1) return 'virtual';
    if (l.indexOf('back') !== -1 || l.indexOf('rear') !== -1) return 'wide';
    return 'other';
  }

  var LENS_LABELS = {
    ultrawide: '0.5x ultra wide',
    virtual: '0.5x-3x auto',
    wide: '1x wide',
    telephoto: 'telephoto',
    other: 'camera'
  };

  /* Back-facing devices only, best-for-coverage first. */
  function backCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return Promise.resolve([]);
    }
    var order = { ultrawide: 0, virtual: 1, wide: 2, telephoto: 3, other: 4 };
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      return devices
        .filter(function (d) { return d.kind === 'videoinput'; })
        .map(function (d) {
          return { id: d.deviceId, label: d.label, kind: classify(d.label) };
        })
        .filter(function (d) { return d.kind !== 'front'; })
        .sort(function (a, b) { return order[a.kind] - order[b.kind]; });
    }).catch(function () { return []; });
  }

  function storedLens() {
    try { return localStorage.getItem(LENS_KEY) || DEFAULT_LENS; }
    catch (e) { return DEFAULT_LENS; }
  }

  function storeLens(kind) {
    try { localStorage.setItem(LENS_KEY, kind); } catch (e) {}
  }

  /* Pull a virtual multi-lens device down to its widest field of view. */
  function widenToMinZoom(track) {
    if (!track || !track.getCapabilities || !track.applyConstraints) return;
    var caps;
    try { caps = track.getCapabilities(); } catch (e) { return; }
    if (!caps || !caps.zoom || typeof caps.zoom.min !== 'number') return;
    if (caps.zoom.min >= 1) return;   // no sub-1x range on this device
    track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] })
      .catch(function () { /* best effort */ });
  }

  function Recorder(sink) {
    this.sink = sink;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.wakeLock = null;
    this.stopTimer = null;
    this.recording = false;
    this.cameras = [];        // back-facing devices, widest first
    this.lens = null;         // the one currently held
    this.onAutoStop = null;   // (file|null, err|null)

    var self = this;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        // Backgrounding suspends capture on iOS. Finalise what we have rather
        // than letting the whole take decay into an unplayable file.
        if (self.recording) self._finish().then(function (file) {
          if (self.onAutoStop) self.onAutoStop(file, null);
        }, function (err) {
          if (self.onAutoStop) self.onAutoStop(null, err);
        });
      } else if (self.recording) {
        self._lock();
      }
    });
  }

  /* Acquire and hold the camera without recording. Run this ahead of time so
     the permission sheet — the one thing that would give the game away — is
     dealt with before it matters. */
  Recorder.prototype.warm = function () {
    var self = this;
    if (this.stream) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('capture unavailable'));
    }
    return this._open(null)
      .then(function (stream) { return self._selectLens(stream); })
      .then(function (stream) { self._attach(stream); });
  };

  /* One getUserMedia call, optionally pinned to a device. */
  Recorder.prototype._open = function (deviceId) {
    var video = {};
    for (var k in CONSTRAINTS.video) video[k] = CONSTRAINTS.video[k];
    if (deviceId) {
      delete video.facingMode;
      video.deviceId = { exact: deviceId };
    }
    return navigator.mediaDevices.getUserMedia({
      video: video,
      audio: CONSTRAINTS.audio
    });
  };

  /* Re-acquire on the preferred lens if the default pick wasn't it. Any
     failure here leaves the already-working stream alone. */
  Recorder.prototype._selectLens = function (stream) {
    var self = this;
    var want = storedLens();

    return backCameras().then(function (cams) {
      self.cameras = cams;
      if (!cams.length) return stream;

      var target = null;
      for (var i = 0; i < cams.length; i++) {
        if (cams[i].kind === want) { target = cams[i]; break; }
      }
      // Asked for ultra wide and there's no discrete one: the virtual
      // device at minimum zoom is the same lens.
      if (!target && want === 'ultrawide') {
        for (var j = 0; j < cams.length; j++) {
          if (cams[j].kind === 'virtual') { target = cams[j]; break; }
        }
      }
      if (!target) target = cams[0];

      var track = stream.getVideoTracks()[0];
      var current = track && track.getSettings ? track.getSettings().deviceId : null;

      if (current && target.id && current === target.id) {
        self.lens = target;
        if (want === 'ultrawide') widenToMinZoom(track);
        return stream;
      }

      return self._open(target.id).then(function (next) {
        stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
        self.lens = target;
        if (want === 'ultrawide') widenToMinZoom(next.getVideoTracks()[0]);
        return next;
      }, function () {
        self.lens = null;
        return stream;   // keep what already works
      });
    }, function () { return stream; });
  };

  Recorder.prototype._attach = function (stream) {
    this.stream = stream;
    if (!this.sink) return;
    // Video tracks only. The sink physically cannot produce sound.
    this.sink.srcObject = new MediaStream(stream.getVideoTracks());
    this.sink.muted = true;
    this.sink.volume = 0;
    var p = this.sink.play();
    if (p && p.catch) p.catch(function () {});
  };

  Recorder.prototype.isWarm = function () {
    return !!this.stream;
  };

  /* Which lens is live, for the operator's own confirmation. */
  Recorder.prototype.lensReport = function () {
    var want = storedLens();
    var cams = this.cameras || [];
    return {
      want: want,
      wantLabel: LENS_LABELS[want] || want,
      active: this.lens ? (LENS_LABELS[this.lens.kind] || this.lens.kind) : null,
      available: cams.map(function (c) {
        return { kind: c.kind, label: LENS_LABELS[c.kind] || c.kind };
      })
    };
  };

  /* Move to the next available back lens and re-acquire on it. Refuses while
     recording — switching devices mid-take would end the take. */
  Recorder.prototype.cycleLens = function () {
    var self = this;
    if (this.recording) return Promise.resolve(this.lensReport());

    var cams = this.cameras || [];
    var kinds = [];
    for (var i = 0; i < cams.length; i++) {
      if (kinds.indexOf(cams[i].kind) === -1) kinds.push(cams[i].kind);
    }
    if (kinds.indexOf('ultrawide') === -1 && kinds.indexOf('virtual') !== -1) {
      kinds.unshift('ultrawide');   // reachable via min zoom
    }
    if (!kinds.length) return Promise.resolve(this.lensReport());

    var at = kinds.indexOf(storedLens());
    storeLens(kinds[(at + 1) % kinds.length]);

    if (this.stream) {
      this.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      this.stream = null;
    }
    return this.warm().then(function () { return self.lensReport(); },
                            function () { return self.lensReport(); });
  };

  Recorder.prototype.start = function () {
    var self = this;
    if (this.recording) return Promise.resolve();
    return this.warm().then(function () {
      var mime = pickMime();
      if (mime === null) throw new Error('MediaRecorder unavailable');

      var opts = { videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: AUDIO_BPS };
      if (mime) opts.mimeType = mime;

      try {
        self.recorder = new MediaRecorder(self.stream, opts);
      } catch (e) {
        self.recorder = new MediaRecorder(self.stream);  // last-ditch defaults
      }

      self.chunks = [];
      self.recorder.ondataavailable = function (ev) {
        if (ev.data && ev.data.size) self.chunks.push(ev.data);
      };
      self.recorder.start(TIMESLICE_MS);
      self.recording = true;

      self._lock();
      self.stopTimer = setTimeout(function () {
        if (!self.recording) return;
        self._finish().then(function (file) {
          if (self.onAutoStop) self.onAutoStop(file, null);
        }, function (err) {
          if (self.onAutoStop) self.onAutoStop(null, err);
        });
      }, MAX_MS);
    });
  };

  Recorder.prototype.stop = function () {
    if (!this.recording) return Promise.resolve(null);
    return this._finish();
  };

  Recorder.prototype._finish = function () {
    var self = this;
    this.recording = false;

    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    this._unlock();

    return new Promise(function (resolve, reject) {
      var rec = self.recorder;
      if (!rec) { resolve(null); return; }
      self.recorder = null;

      var settled = false;
      var done = function () {
        if (settled) return;
        settled = true;
        var mime = rec.mimeType || 'video/mp4';
        var type = mime.split(';')[0];
        if (!self.chunks.length) { reject(new Error('no data captured')); return; }
        var blob = new Blob(self.chunks, { type: type });
        self.chunks = [];
        resolve(new File([blob], 'clip.' + extFor(type), {
          type: type,
          lastModified: Date.now()
        }));
      };

      rec.onstop = done;
      rec.onerror = function () { done(); };
      // Some builds never fire onstop if the track ended first.
      setTimeout(done, 3000);

      try {
        if (rec.state !== 'inactive') rec.stop();
        else done();
      } catch (e) { done(); }
    });
  };

  /* Release the camera entirely. Green indicator goes out. */
  Recorder.prototype.release = function () {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch (e) {}
    }
    this.recorder = null;
    this.recording = false;
    this.chunks = [];
    this.lens = null;
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    this._unlock();
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      this.stream = null;
    }
    if (this.sink) this.sink.srcObject = null;
  };

  /* Screen must stay awake — a sleeping phone tears down the stream. */
  Recorder.prototype._lock = function () {
    var self = this;
    if (this.wakeLock || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      self.wakeLock = lock;
      lock.addEventListener('release', function () { self.wakeLock = null; });
    }).catch(function () { /* not fatal */ });
  };

  Recorder.prototype._unlock = function () {
    if (!this.wakeLock) return;
    try { this.wakeLock.release(); } catch (e) {}
    this.wakeLock = null;
  };

  /* Hand the file to iOS. The share sheet's "Save Video" puts it in Photos.
     Resolves 'saved' | 'dismissed' | 'downloaded'. */
  Recorder.save = function (file) {
    if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      return navigator.share({ files: [file] }).then(function () {
        return 'saved';
      }, function (err) {
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
          return 'dismissed';
        }
        return Recorder._download(file);
      });
    }
    return Promise.resolve(Recorder._download(file));
  };

  Recorder._download = function (file) {
    var url = URL.createObjectURL(file);
    var a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 30000);
    return 'downloaded';
  };

  global.Recorder = Recorder;
})(this);
