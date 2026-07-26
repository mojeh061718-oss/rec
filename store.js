/* Clip storage.
 *
 * Chunks are written to IndexedDB as they arrive rather than accumulated in
 * memory. At 4K the bitrate is around 180 MB per minute, so a five minute take
 * is roughly a gigabyte — far past what a tab can hold as a live array.
 *
 * The second reason is timing: a clip that survives on disk can be handed to
 * the share sheet whenever it suits, rather than the moment capture stops.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'terminal';
  var DB_VERSION = 3;
  var CHUNKS = 'chunks';   // keyPath [clip, seq] — one record per timeslice
  var CLIPS = 'clips';     // keyPath id — metadata ONLY, never video data
  var BLOBS = 'blobs';     // keyPath id — the video, read only when saving
  var META = 'meta';       // keyPath clip — written before the first chunk, so
                           // a take interrupted by a crash can be rebuilt with
                           // the right codec and its real start time

  /* Video lives apart from the record that describes it.
   *
   * They used to be one record, so listing clips — which happens on launch,
   * after every take, and inside save itself — pulled every video out of the
   * database just to count them. A handful of 4K takes was enough to bring
   * the whole app down. Metadata is small and read constantly; a clip's video
   * is read once, when it is actually being handed to the share sheet. */

  var dbp = null;

  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(CHUNKS)) {
          d.createObjectStore(CHUNKS, { keyPath: ['clip', 'seq'] });
        }
        if (!d.objectStoreNames.contains(CLIPS)) {
          d.createObjectStore(CLIPS, { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains(META)) {
          d.createObjectStore(META, { keyPath: 'clip' });
        }
        if (!d.objectStoreNames.contains(BLOBS)) {
          d.createObjectStore(BLOBS, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(store, mode);
        var out = fn(t.objectStore(store));
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('aborted')); };
      });
    });
  }

  function range(clip) {
    return IDBKeyRange.bound([clip, -1], [clip, Number.MAX_SAFE_INTEGER]);
  }

  var Store = {};

  /* Ask iOS not to evict us. Best effort — refusal changes nothing. */
  Store.persist = function () {
    if (navigator.storage && navigator.storage.persist) {
      return navigator.storage.persist().catch(function () { return false; });
    }
    return Promise.resolve(false);
  };

  function meta(rec) {
    return { id: rec.id, type: rec.type, ext: rec.ext, at: rec.at,
             size: rec.size, saved: !!rec.saved, name: Store.nameFor(rec) };
  }

  /* Park an already-assembled clip: video into BLOBS, description into CLIPS.
     Rejects loudly — the caller decides whether a storage failure is worth
     losing the take over. */
  Store.put = function (rec) {
    return tx(BLOBS, 'readwrite', function (s) {
      s.put({ id: rec.id, blob: rec.blob });
    }).then(function () {
      return tx(CLIPS, 'readwrite', function (s) { s.put(meta(rec)); });
    });
  };

  /* Description only — no video is read. */
  Store.putMeta = function (rec) {
    return tx(CLIPS, 'readwrite', function (s) { s.put(meta(rec)); });
  };

  Store.getBlob = function (id) {
    return tx(BLOBS, 'readonly', function (s) { return s.get(id); })
      .then(function (row) { return row ? row.blob : null; });
  };

  Store.putChunk = function (clip, seq, blob) {
    return tx(CHUNKS, 'readwrite', function (s) {
      s.put({ clip: clip, seq: seq, blob: blob });
    });
  };

  /* Written before the first chunk lands. If the app dies mid-take this is
     what lets the leftovers be rebuilt as the right kind of file, stamped
     with when the recording actually started. */
  Store.beginClip = function (clip, type, ext, at) {
    return tx(META, 'readwrite', function (s) {
      s.put({ clip: clip, type: type, ext: ext, at: at });
    }).catch(function () {});
  };

  Store.getMeta = function (clip) {
    return tx(META, 'readonly', function (s) { return s.get(clip); })
      .catch(function () { return null; });
  };

  Store.dropMeta = function (clip) {
    return tx(META, 'readwrite', function (s) { s.delete(clip); })
      .catch(function () {});
  };

  /* Stitch a clip's chunks into one file record and drop the chunks. The
     assembled Blob references the parts rather than copying them, so this
     does not pull the whole take into memory. */
  Store.assemble = function (clip, type, ext, startedAt) {
    return tx(CHUNKS, 'readonly', function (s) {
      return s.getAll(range(clip));
    }).then(function (rows) {
      if (!rows || !rows.length) throw new Error('no data captured');
      rows.sort(function (a, b) { return a.seq - b.seq; });
      var parts = rows.map(function (r) { return r.blob; });
      var blob = new Blob(parts, { type: type });
      var at = startedAt || Date.now();
      var rec = { id: clip, blob: blob, type: type, ext: ext, at: at,
                  size: blob.size, saved: false,
                  name: 'clip-' + Store.stamp(at) + '.' + ext };
      return Store.put(rec)
        .then(function () { return Store.dropChunks(clip); })
        .then(function () { return rec; });
    });
  };

  Store.dropChunks = function (clip) {
    return tx(CHUNKS, 'readwrite', function (s) { s.delete(range(clip)); });
  };

  /* Oldest first — clips hand off in the order they were taken. */
  Store.list = function () {
    return tx(CLIPS, 'readonly', function (s) { return s.getAll(); })
      .then(function (rows) {
        rows = rows || [];
        rows.sort(function (a, b) { return a.at - b.at; });
        return rows;
      })
      .catch(function () { return []; });
  };

  Store.oldest = function () {
    return Store.list().then(function (rows) { return rows[0] || null; });
  };

  Store.remove = function (id) {
    return tx(BLOBS, 'readwrite', function (s) { s.delete(id); })
      .catch(function () {})
      .then(function () {
        return tx(CLIPS, 'readwrite', function (s) { s.delete(id); });
      });
  };

  /* Clips written before video and metadata were separated still carry their
     blob inline, which is exactly what made listing expensive. Move them
     across once, on launch. */
  Store.migrate = function () {
    return tx(CLIPS, 'readonly', function (s) { return s.getAllKeys(); })
      .then(function (ids) {
        return (ids || []).reduce(function (chain, id) {
          return chain.then(function () {
            return tx(CLIPS, 'readonly', function (s) { return s.get(id); })
              .then(function (rec) {
                if (!rec || !rec.blob) return null;
                return Store.put(rec);   // splits it, then rewrites metadata
              });
          }).catch(function () {});
        }, Promise.resolve());
      })
      .catch(function () {});
  };

  /* Every clip carries its own timestamped name. They used to all be
     "clip.mp4", which meant saving a second one to Files silently replaced
     the first. */
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  Store.stamp = function (at) {
    var d = new Date(at);
    return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  };

  Store.nameFor = function (rec) {
    return rec.name || ('clip-' + Store.stamp(rec.at) + '.' + (rec.ext || 'mp4'));
  };

  /* Build the File to hand to the share sheet. The video is fetched here and
     nowhere else, so nothing that merely lists or counts clips ever touches
     it. Resolves null if the video is missing. */
  Store.fileFor = function (rec) {
    var wrap = function (blob) {
      if (!blob) return null;
      return new File([blob], Store.nameFor(rec), {
        type: rec.type || 'video/mp4',
        lastModified: rec.at
      });
    };
    if (rec.blob) return Promise.resolve(wrap(rec.blob));
    return Store.getBlob(rec.id).then(wrap, function () { return null; });
  };

  /* Flag a clip as handed off. Deliberately not a delete — iOS reports a
     successful share before Photos has necessarily written anything, so
     removing here has already cost one recording. */
  Store.markSaved = function (id) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(CLIPS, 'readwrite');
        var s = t.objectStore(CLIPS);
        var get = s.get(id);
        get.onsuccess = function () {
          var rec = get.result;
          if (rec) { rec.saved = true; s.put(rec); }
        };
        t.oncomplete = resolve;
        t.onerror = function () { reject(t.error); };
      });
    });
  };

  Store.unsaved = function () {
    return Store.list().then(function (rows) {
      return rows.filter(function (r) { return !r.saved; });
    });
  };

  /* Remove every clip already handed off. Unsaved clips are never touched. */
  Store.removeSaved = function () {
    return Store.list().then(function (rows) {
      var gone = rows.filter(function (r) { return r.saved; });
      return gone.reduce(function (chain, r) {
        return chain.then(function () { return Store.remove(r.id); });
      }, Promise.resolve()).then(function () { return gone.length; });
    });
  };

  /* Housekeeping at boot: clear clips that were handed off and are older than
     maxAgeMs. Only ever touches clips already marked saved, so a recording
     you haven't sent anywhere is never at risk from this. */
  Store.prune = function (maxAgeMs) {
    var cutoff = Date.now() - maxAgeMs;
    return Store.list().then(function (rows) {
      var stale = rows.filter(function (r) { return r.saved && r.at < cutoff; });
      return stale.reduce(function (chain, r) {
        return chain.then(function () { return Store.remove(r.id); });
      }, Promise.resolve()).then(function () { return stale.length; });
    }).catch(function () { return 0; });
  };

  Store.removeAll = function () {
    return Store.list().then(function (rows) {
      return rows.reduce(function (chain, r) {
        return chain.then(function () { return Store.remove(r.id); });
      }, Promise.resolve()).then(function () { return rows.length; });
    });
  };

  /* Anything left in CHUNKS at boot is a take that never finished — the app
     was killed mid-recording. Recover it rather than leaking the space. */
  Store.recover = function () {
    return tx(CHUNKS, 'readonly', function (s) { return s.getAllKeys(); })
      .then(function (keys) {
        var clips = [];
        (keys || []).forEach(function (k) {
          if (clips.indexOf(k[0]) === -1) clips.push(k[0]);
        });
        return clips.reduce(function (chain, clip) {
          return chain.then(function () {
            return Store.getMeta(clip).then(function (m) {
              return Store.assemble(clip,
                (m && m.type) || 'video/mp4',
                (m && m.ext) || 'mp4',
                m && m.at);
            }).then(function () {
              return Store.dropMeta(clip);
            }, function () {
              return Store.dropChunks(clip).then(function () {
                return Store.dropMeta(clip);
              });
            });
          });
        }, Promise.resolve()).then(function () { return clips.length; });
      })
      .catch(function () { return 0; });
  };

  global.Store = Store;
})(this);
