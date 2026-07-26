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

  // Bits per pixel per frame. 0.11 puts 4K30 near 27 Mbps and 1080p30 near
  // 6.8 Mbps — comparable to what the stock camera app writes, and well past
  // the point where more bitrate stops being visible.
  var BPP = 0.11;
  var MIN_BPS = 4000000;
  var MAX_BPS = 40000000;
  var AUDIO_BPS = 256000;       // headroom for singing, not speech
  // Flush cadence. This is exactly how much of the tail a crash can cost, so
  // it is kept short; the cost is one more IndexedDB write every two seconds.
  var TIMESLICE_MS = 2000;
  var MAX_MS = 25 * 60 * 1000;  // failsafe stop
  var MEM_LIMIT = 400 * 1024 * 1024;  // hand over to disk past this

  var LENS_KEY = 'terminal.lens';
  var DEFAULT_LENS = 'ultrawide';

  var CONSTRAINTS = {
    video: {
      facingMode: { ideal: 'environment' },
      // Ask for 4K and take whatever the lens actually gives back. The
      // ultra wide may cap lower; `lens` reports what was really negotiated.
      width: { ideal: 3840 },
      height: { ideal: 2160 },
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

  // H.264 first, deliberately. HEVC is denser per bit, but Safari has been
  // known to report support for a codec its recorder then produces nothing
  // for — and a take that silently yields zero bytes is worth far more than
  // the few percent of quality HEVC would have bought at this bitrate.
  var MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.640033,mp4a.40.2',
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=h264,opus',
    'video/webm'
  ];

  /* Bitrate follows the resolution actually negotiated, not the one asked
     for. A fixed number would starve 4K and waste space on 1080p. */
  function bitrateFor(track) {
    var s = track && track.getSettings ? track.getSettings() : null;
    var w = (s && s.width) || 1920;
    var h = (s && s.height) || 1080;
    var fps = (s && s.frameRate) || 30;
    return Math.max(MIN_BPS, Math.min(MAX_BPS, Math.round(w * h * fps * BPP)));
  }

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
    front: 'front camera',
    other: 'camera'
  };

  /* Every camera, widest-covering rear lens first and the front one last, so
     that anything falling back to cams[0] still lands on a rear lens. */
  function allCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return Promise.resolve([]);
    }
    var order = { ultrawide: 0, virtual: 1, wide: 2, telephoto: 3, other: 4, front: 5 };
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      return devices
        .filter(function (d) { return d.kind === 'videoinput'; })
        .map(function (d) {
          return { id: d.deviceId, label: d.label, kind: classify(d.label) };
        })
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
    this.bytes = 0;
    this.spilled = false;
    this.writes = Promise.resolve();
    // Real internals, surfaced by `diag`. Everything else on screen is
    // theatre; this is the one thing that tells the truth.
    this.diag = { mime: null, opts: null, chunks: 0, bytes: 0,
                  held: 'memory', errors: [] };
    this.onAutoStop = null;   // (clip|null, err|null)

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
    // Once the device list is known, open the wanted lens directly. Only the
    // very first warm has to open blind and then correct itself, and that one
    // happens long before a trigger word does.
    var known = this.cameras && this.cameras.length ? this._pick(this.cameras) : null;
    // With no device list yet, a front request still opens facing the right
    // way rather than grabbing a rear lens and correcting afterwards.
    var facing = storedLens() === 'front' ? 'user' : 'environment';
    return this._open(known ? known.id : null, facing)
      .catch(function () { return self._open(null, facing); })   // stale id
      .then(function (stream) { return self._selectLens(stream); })
      .then(function (stream) { self._attach(stream); });
  };

  /* Best available match for the stored preference. */
  Recorder.prototype._pick = function (cams) {
    var want = storedLens();
    for (var i = 0; i < cams.length; i++) {
      if (cams[i].kind === want) return cams[i];
    }
    // Asked for ultra wide and there's no discrete one: the virtual device
    // at minimum zoom is the same lens.
    if (want === 'ultrawide') {
      for (var j = 0; j < cams.length; j++) {
        if (cams[j].kind === 'virtual') return cams[j];
      }
    }
    // No front device exposed — facingMode handles it instead of silently
    // handing back a rear lens.
    if (want === 'front') return null;
    return cams[0];
  };

  /* One getUserMedia call, optionally pinned to a device or a facing. */
  Recorder.prototype._open = function (deviceId, facing) {
    var video = {};
    for (var k in CONSTRAINTS.video) video[k] = CONSTRAINTS.video[k];
    if (deviceId) {
      delete video.facingMode;
      video.deviceId = { exact: deviceId };
    } else if (facing) {
      video.facingMode = { ideal: facing };
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

    return allCameras().then(function (cams) {
      self.cameras = cams;
      if (!cams.length) return stream;

      var target = self._pick(cams);
      var track = stream.getVideoTracks()[0];
      var current = track && track.getSettings ? track.getSettings().deviceId : null;

      // Front requested but no front device listed: facingMode already
      // opened the right camera, so leave the stream be.
      if (!target) {
        self.lens = { kind: 'front', id: null, label: 'front' };
        return stream;
      }

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

  /* Which lens is live and at what resolution it actually negotiated —
     worth checking once on the real phone, since 4K is a request, not a
     guarantee, and it varies by lens. */
  Recorder.prototype.lensReport = function () {
    var want = storedLens();
    var cams = this.cameras || [];
    var track = this.stream ? this.stream.getVideoTracks()[0] : null;
    var s = track && track.getSettings ? track.getSettings() : null;
    return {
      want: want,
      wantLabel: LENS_LABELS[want] || want,
      size: s && s.width ? s.width + 'x' + s.height : null,
      mbps: track ? Math.round(bitrateFor(track) / 100000) / 10 : null,
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

  /* Switch to a named lens and begin. Used by the two trigger words. */
  Recorder.prototype.startOn = function (kind) {
    var self = this;
    if (this.recording) return Promise.resolve();
    if (storedLens() === kind && this.stream) return this.start();

    storeLens(kind);
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      this.stream = null;
    }
    return this.warm().then(function () { return self.start(); });
  };

  /* Build the recorder, giving up one option at a time rather than jumping
     straight to bare defaults — a rejected bitrate shouldn't cost the codec
     choice too. Records which rung actually worked. */
  Recorder.prototype._build = function (mime, bps) {
    var attempts = [
      ['full', { mimeType: mime, videoBitsPerSecond: bps, audioBitsPerSecond: AUDIO_BPS }],
      ['no-audio-rate', { mimeType: mime, videoBitsPerSecond: bps }],
      ['codec only', { mimeType: mime }],
      ['defaults', null]
    ];
    for (var i = 0; i < attempts.length; i++) {
      var opts = attempts[i][1];
      if (opts && !opts.mimeType) continue;
      try {
        var rec = opts ? new MediaRecorder(this.stream, opts) : new MediaRecorder(this.stream);
        this.diag.opts = attempts[i][0];
        return rec;
      } catch (e) {
        this.diag.errors.push('build: ' + (e && e.name ? e.name : 'failed'));
      }
    }
    throw new Error('MediaRecorder rejected every configuration');
  };

  Recorder.prototype.start = function () {
    var self = this;
    if (this.recording) return Promise.resolve();
    return this.warm().then(function () {
      var mime = pickMime();
      if (mime === null) throw new Error('MediaRecorder unavailable');

      self.clipId = 'c' + Date.now();
      self.seq = 0;
      self.chunks = [];
      self.bytes = 0;
      self.spilled = false;
      self.writes = Promise.resolve();
      self.diag = { mime: mime || '(default)', opts: null, chunks: 0, bytes: 0,
                    held: 'memory', errors: [] };

      self.recorder = self._build(mime, bitrateFor(self.stream.getVideoTracks()[0]));
      self.diag.mime = self.recorder.mimeType || mime || '(default)';

      // Record what this take is before any of it lands, so a crash leaves
      // enough behind to rebuild it correctly.
      self.startedAt = Date.now();
      var liveType = (self.recorder.mimeType || 'video/mp4').split(';')[0];
      Store.beginClip(self.clipId, liveType, extFor(liveType), self.startedAt);

      // Memory is the primary copy — it is the one path that cannot fail
      // underneath us. Disk is written alongside it for persistence and for
      // crash recovery, and a disk failure is recorded rather than swallowed.
      //
      // Past MEM_LIMIT the memory copy is dropped and disk takes over, since
      // 4K runs about 180 MB per minute and a long take would otherwise take
      // the tab down. If disk is also failing by then, the take is doomed
      // either way and `diag` will say so.
      self.recorder.ondataavailable = function (ev) {
        if (!ev.data || !ev.data.size) return;
        var seq = self.seq++;
        var clip = self.clipId;
        var blob = ev.data;

        self.bytes += blob.size;
        self.diag.chunks = seq + 1;
        self.diag.bytes = self.bytes;

        if (!self.spilled) {
          self.chunks.push(blob);
          if (self.bytes > MEM_LIMIT) {
            self.spilled = true;
            self.chunks = [];
            self.diag.held = 'disk (over memory limit)';
          }
        }

        self.writes = self.writes.then(function () {
          return Store.putChunk(clip, seq, blob);
        }).catch(function (e) {
          if (!self.diag.storeFailed) {
            self.diag.storeFailed = true;
            self.diag.errors.push('store: ' + (e && e.name ? e.name : 'write failed'));
          }
        });
      };

      self.recorder.onerror = function (ev) {
        var e = ev && ev.error;
        self.diag.errors.push('recorder: ' + (e && e.name ? e.name : 'error'));
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

    var clip = this.clipId;
    return new Promise(function (resolve) {
      var rec = self.recorder;
      if (!rec) { resolve(null); return; }
      self.recorder = null;

      var settled = false;
      var done = function () {
        if (settled) return;
        settled = true;
        resolve(rec.mimeType || 'video/mp4');
      };

      rec.onstop = done;
      rec.onerror = function () { done(); };
      // Backstop for builds that never fire onstop. Generous, because if the
      // per-timeslice events never arrived, the final blob is the entire take
      // and can take real time to materialise.
      setTimeout(done, 20000);

      try {
        if (rec.state !== 'inactive') rec.stop();
        else done();
      } catch (e) { done(); }
    }).then(function (mime) {
      if (!mime) return null;
      var type = mime.split(';')[0];
      var ext = extFor(type);

      // Assemble from memory when we still hold it — that copy is known good
      // and needs nothing from storage. Disk is the fallback, used when the
      // take outgrew memory or when memory somehow came back empty.
      if (!self.spilled && self.chunks.length) {
        var blob = new Blob(self.chunks, { type: type });
        self.chunks = [];
        var at = self.startedAt || Date.now();
        var rec = { id: clip, blob: blob, type: type, ext: ext, at: at,
                    size: blob.size, saved: false,
                    name: 'clip-' + Store.stamp(at) + '.' + ext };

        // Hand the clip back immediately and persist in the background.
        //
        // The share sheet has to open inside the few seconds of user
        // activation that the keypress granted, and writing a gigabyte to
        // IndexedDB first would spend that budget before the sheet ever
        // opened. Assembling the Blob is cheap — it references the chunks
        // rather than copying them — so the caller can share at once while
        // the write lands behind it.
        // Chunks are only cleared once the assembled clip is safely stored,
        // so a crash in between leaves the take recoverable either way.
        self.lastWrite = Store.put(rec).then(function () {
          Store.dropChunks(clip);
          Store.dropMeta(clip);
        }, function (e) {
          self.diag.errors.push('save: ' + (e && e.name ? e.name : 'failed'));
          Recorder.orphans.push(rec);   // a list: a second failure must not
                                        // displace the first one's only copy
        });
        return rec;
      }

      // Spilled to disk mid-take: the clip has to be read back and stitched,
      // which is slower and may outlast the activation window. `save` picks
      // it up if the automatic attempt misses.
      return self.writes.then(function () {
        self.lastWrite = Promise.resolve();
        return Store.assemble(clip, type, ext, self.startedAt).then(function (rec) {
          Store.dropMeta(clip);
          return rec;
        });
      });
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

  /* Real internals for `diag`. Nothing here is theatre. */
  Recorder.prototype.report = function () {
    var d = this.diag || {};
    var track = this.stream ? this.stream.getVideoTracks()[0] : null;
    var s = track && track.getSettings ? track.getSettings() : null;
    return {
      recording: this.recording,
      camera: this.stream ? (s && s.width ? s.width + 'x' + s.height : 'open') : 'closed',
      mime: d.mime || '(none yet)',
      opts: d.opts || '(none yet)',
      chunks: d.chunks || 0,
      mb: Math.round((d.bytes || 0) / 1048576 * 10) / 10,
      held: d.held || 'memory',
      lastShare: Recorder.lastSave || '(none yet)',
      orphan: Recorder.orphans.reduce(function (n, o) {
        return n + Math.round(o.size / 1048576);
      }, 0),
      orphanCount: Recorder.orphans.length,
      errors: (d.errors || []).slice(-3)
    };
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
     Resolves 'saved' | 'dismissed' | 'blocked' | 'downloaded'.
     Only 'saved' means the clip definitely reached Photos — everything else
     leaves it in storage. A download fallback in a standalone PWA often does
     nothing visible, so treating it as success would quietly bin the take. */
  Recorder.save = function (files) {
    if (!files) return Promise.resolve('missing');
    if (!(files instanceof Array)) files = [files];
    if (!files.length) return Promise.resolve('missing');

    Recorder.lastSave = null;
    if (navigator.canShare && navigator.canShare({ files: files }) && navigator.share) {
      return navigator.share({ files: files }).then(function () {
        Recorder.lastSave = 'shared';
        return 'saved';
      }, function (err) {
        var name = err && err.name ? err.name : 'unknown';
        Recorder.lastSave = name;
        if (name === 'AbortError') return 'dismissed';
        if (name === 'NotAllowedError') return 'blocked';   // lost the gesture
        files.forEach(Recorder._download);
        return 'downloaded';
      });
    }
    Recorder.lastSave = 'canShare=false';
    files.forEach(Recorder._download);
    return Promise.resolve('downloaded');
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

  /* Clips that finished but could not be written to storage. In-memory only,
     so they last until the app closes. */
  Recorder.orphans = [];

  global.Recorder = Recorder;
})(this);
