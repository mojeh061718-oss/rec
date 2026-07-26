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

  function Recorder(sink) {
    this.sink = sink;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.wakeLock = null;
    this.stopTimer = null;
    this.recording = false;
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
    return navigator.mediaDevices.getUserMedia(CONSTRAINTS).then(function (stream) {
      self.stream = stream;
      if (self.sink) {
        // Video tracks only. The sink physically cannot produce sound.
        self.sink.srcObject = new MediaStream(stream.getVideoTracks());
        self.sink.muted = true;
        self.sink.volume = 0;
        var p = self.sink.play();
        if (p && p.catch) p.catch(function () {});
      }
    });
  };

  Recorder.prototype.isWarm = function () {
    return !!this.stream;
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
