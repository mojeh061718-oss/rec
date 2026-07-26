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
  var DB_VERSION = 1;
  var CHUNKS = 'chunks';   // keyPath [clip, seq] — one record per timeslice
  var CLIPS = 'clips';     // keyPath id — assembled, ready to hand off

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

  Store.putChunk = function (clip, seq, blob) {
    return tx(CHUNKS, 'readwrite', function (s) {
      s.put({ clip: clip, seq: seq, blob: blob });
    });
  };

  /* Stitch a clip's chunks into one file record and drop the chunks. The
     assembled Blob references the parts rather than copying them, so this
     does not pull the whole take into memory. */
  Store.assemble = function (clip, type, ext) {
    return tx(CHUNKS, 'readonly', function (s) {
      return s.getAll(range(clip));
    }).then(function (rows) {
      if (!rows || !rows.length) throw new Error('no data captured');
      rows.sort(function (a, b) { return a.seq - b.seq; });
      var parts = rows.map(function (r) { return r.blob; });
      var blob = new Blob(parts, { type: type });
      var rec = { id: clip, blob: blob, type: type, ext: ext, at: Date.now(), size: blob.size };
      return tx(CLIPS, 'readwrite', function (s) { s.put(rec); })
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
    return tx(CLIPS, 'readwrite', function (s) { s.delete(id); });
  };

  Store.toFile = function (rec) {
    return new File([rec.blob], 'clip.' + (rec.ext || 'mp4'), {
      type: rec.type || 'video/mp4',
      lastModified: rec.at
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
            return Store.assemble(clip, 'video/mp4', 'mp4').catch(function () {
              return Store.dropChunks(clip);
            });
          });
        }, Promise.resolve()).then(function () { return clips.length; });
      })
      .catch(function () { return 0; });
  };

  global.Store = Store;
})(this);
