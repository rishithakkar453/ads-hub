/* ============================================================================
   ADS HUB — state store
   localStorage-backed (instant) + best-effort durable disk backup via the
   server (/api/store). Seeds sample data on first run. Pub/sub. window.Ads.store

   Data model
   ----------
   state = {
     meta:     { version, savedAt },
     brand:    { name, accent, font, voice, logo, defaultBackground },
     settings: { currency, ctrTarget, cpaTarget, roasTarget },
     ads:      [ AdRecord ]
   }
   AdRecord = creative spec  +  lifecycle  +  performance
     spec:    template, format, theme, font, background, bgImage, accent,
              badge, headlineStart, headlineHighlight, subtext, boldPhrases[],
              cta, brand, logo, images{}, captions{}, bullets[], stat{}, quote{}, angle
     life:    id, name, status, createdAt, updatedAt, approvedAt, launchedAt,
              objective, audience, platform, metaIds{}
     perf:    metrics{ spend, impressions, reach, frequency, clicks, conversions, convValue },
              history[ { date, ...metrics } ], notes
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var util = Ads.util;
  var KEY = 'ads-hub:v1';
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var listeners = [];
  var state = null;
  var diskSave; // debounced, set after util is available

  /* ---- Defaults ---------------------------------------------------------- */
  var EMPTY_METRICS = { spend: null, impressions: null, reach: null, frequency: null, clicks: null, conversions: null, convValue: null };

  function defaultBrand() {
    return { name: 'PARTISANS', accent: '#ff7a3c', font: 'clean', voice: '', logo: null, defaultBackground: 'gradient-blue' };
  }
  function defaultSettings() {
    // tracking.url = the PUBLIC base for tracked links + beacons (the office
    // collector once deployed); empty = this machine only (local testing)
    return { currency: '$', ctrTarget: 1.0, cpaTarget: 40, roasTarget: 2.0, useAI: true, tracking: { url: '' } };
  }

  // A fully-formed ad spec with sensible defaults; callers override fields.
  function blankSpec() {
    return {
      template: 'comparison', format: 'square', theme: 'dark', font: 'clean',
      background: 'gradient-blue', bgImage: null, accent: '#ff7a3c',
      badge: 'Join 500+ teams',
      headlineStart: 'Your AI Data Analyst',
      headlineHighlight: 'for GTM Teams',
      subtext: 'Get the insights your team needs to grow faster. No SQL required. Up and running in a day.',
      boldPhrases: ['No SQL required', 'in a day'],
      cta: 'Get started free',
      caption: '', description: '',
      layout: 'auto', density: 'standard', align: 'left',
      kind: 'post', motion: 'auto', videoFormat: 'story', bgVideo: null, clip: null, dna: null,
      brand: 'PARTISANS', logo: null,
      images: { before: null, after: null, product: null },
      captions: { before: 'Hours of SQL', after: 'Just ask in English' },
      bullets: ['Live dashboards in minutes', 'Ask questions in plain English', 'No engineering bottleneck'],
      stat: { value: '3.2x', label: 'faster pipeline reporting' },
      quote: { text: 'We replaced three tools and a week of work with one afternoon.', author: 'Dana Lin', role: 'Head of Growth, Northwind' },
      angle: ''
    };
  }

  function newAd(spec, extra) {
    var rec = Object.assign(blankSpec(), spec || {}, {
      id: util.uid('ad'),
      name: (spec && spec.name) || (spec && spec.headlineStart) || 'Untitled ad',
      status: 'draft',
      createdAt: util.nowISO(), updatedAt: util.nowISO(),
      approvedAt: null, launchedAt: null,
      objective: '', audience: '', platform: 'Meta',
      metaIds: { campaign: '', adset: '', ad: '' },
      metrics: clone(EMPTY_METRICS), history: [], notes: ''
    }, extra || {});
    return rec;
  }

  /* ---- Seed (sample portfolio so dashboards aren't empty) ---------------- */
  function seed() {
    var brand = defaultBrand();
    var ads = [
      newAd({
        template: 'comparison', name: 'AI Analyst — SQL pain', angle: 'Pain point',
        background: 'gradient-blue', accent: '#ff7a3c',
        badge: 'Join 500+ GTM teams', headlineStart: 'Your AI Data Analyst', headlineHighlight: 'for GTM Teams',
        subtext: 'Get the insights your GTM team needs to grow faster. No SQL required. Up and running in a day.',
        boldPhrases: ['No SQL required', 'in a day'], cta: 'Start free'
      }, { status: 'active', approvedAt: util.nowISO(), launchedAt: util.nowISO(),
        metrics: { spend: 1240, impressions: 182000, reach: 96000, frequency: 1.9, clicks: 3120, conversions: 142, convValue: 8520 } }),
      newAd({
        template: 'stat', name: 'AI Analyst — 3.2x stat', angle: 'Outcome / proof',
        background: 'gradient-purple', accent: '#9b6dff',
        badge: 'Backed by data teams', headlineStart: 'Ship reports', headlineHighlight: '3.2x faster',
        subtext: 'Teams on Graphed cut reporting time from days to minutes. See the difference in week one.',
        boldPhrases: ['days to minutes'], cta: 'See how', stat: { value: '3.2x', label: 'faster reporting' }
      }, { status: 'active', approvedAt: util.nowISO(), launchedAt: util.nowISO(),
        metrics: { spend: 980, impressions: 121000, reach: 70000, frequency: 1.7, clicks: 1450, conversions: 96, convValue: 6240 } }),
      newAd({
        template: 'quote', name: 'AI Analyst — testimonial', angle: 'Social proof',
        background: 'solid-light', theme: 'light', accent: '#ff7a3c',
        badge: 'What teams say', headlineStart: 'Loved by', headlineHighlight: 'growth teams',
        subtext: 'Real teams, real results.', cta: 'Read stories',
        quote: { text: 'We replaced three tools and a week of work with one afternoon.', author: 'Dana Lin', role: 'Head of Growth, Northwind' }
      }, { status: 'paused', approvedAt: util.nowISO(), launchedAt: util.nowISO(),
        metrics: { spend: 760, impressions: 145000, reach: 88000, frequency: 1.6, clicks: 980, conversions: 21, convValue: 1260 } }),
      newAd({
        template: 'statement', name: 'AI Analyst — bold hook', angle: 'Curiosity',
        background: 'mesh', accent: '#39d4a6',
        badge: '', headlineStart: 'Stop waiting on', headlineHighlight: 'the data team',
        subtext: 'Self-serve answers for every GTM question. Ask in plain English, get a dashboard back.',
        boldPhrases: ['plain English'], cta: 'Try it free'
      }, { status: 'approved', approvedAt: util.nowISO(),
        metrics: clone(EMPTY_METRICS) })
    ];
    return {
      meta: { version: 1, savedAt: util.nowISO() },
      brand: brand, settings: defaultSettings(), ads: ads,
      prefs: { liked: [], disliked: [] },
      projects: [],
      tracking: { spend: {}, snapshot: null, syncedAt: null }
    };
  }

  // A project = a product/site being advertised: its full brief (all uploaded
  // material) + the ads the user liked (savedAds), all persisted so it can be
  // reopened. Generated batches are session-only — only liked ads survive.
  function newProject(data) {
    return Object.assign({
      id: util.uid('proj'),
      name: 'Untitled project',
      createdAt: util.nowISO(), updatedAt: util.nowISO(),
      thumb: null,
      brief: { url: '', site: null, text: '', files: [], images: [], videos: [] },
      results: [], savedAds: [], genImages: [], mix: 'both', count: 12,
      copyEngine: '', copyInputs: []
    }, data || {});
  }

  /* ---- Persistence ------------------------------------------------------- */
  function persistLocal() {
    state.meta.savedAt = util.nowISO();
    try { window.localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) {
      // quota exceeded (projects can be big) or private mode: drop the local
      // copy so the DISK snapshot stays the source of truth on next load —
      // otherwise a stale localStorage copy would shadow newer disk data
      try { window.localStorage.removeItem(KEY); } catch (e2) {}
    }
  }
  function notify() { listeners.forEach(function (fn) { try { fn(state); } catch (e) { console.error(e); } }); }
  function commit() {
    // bump a monotonic revision so a newer copy can be told from an older one
    // when reconciling localStorage against disk (see pick())
    if (!state.meta) state.meta = {};
    state.meta.rev = (state.meta.rev || 0) + 1;
    persistLocal(); if (diskSave) diskSave(); notify();
  }

  // How many projects hold real work — the anti-clobber signal. Mirrors the
  // server's projectHasContent(): a near-empty state must never be chosen over,
  // or written on top of, a state full of saved ads / landings / research.
  function contentProjectCount(s) {
    var ps = (s && Array.isArray(s.projects)) ? s.projects : [];
    var c = 0;
    ps.forEach(function (p) {
      if ((p.savedAds && p.savedAds.length) || (p.landings && p.landings.length) ||
          (p.genImages && p.genImages.length) || (p.results && p.results.length) ||
          (p.research && p.research.painPoints && p.research.painPoints.length) || p.dossier) c++;
    });
    return c;
  }
  function revOf(s) { return (s && s.meta && s.meta.rev) || 0; }
  // Choose the better of two snapshots: MORE real work wins (protects against a
  // seed/empty state clobbering full data); on a tie, the newer revision wins
  // (protects genuine edits that only reached localStorage). Ties keep `a`.
  function pick(a, b) {
    var ca = contentProjectCount(a), cb = contentProjectCount(b);
    if (ca !== cb) return ca > cb ? a : b;
    return revOf(b) > revOf(a) ? b : a;
  }

  var diskFailing = false;
  function pushToDisk() {
    try {
      fetch('/api/store', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' }, body: JSON.stringify(state) })
        .then(function (r) {
          if (r.status === 409) {
            // The server BLOCKED this write because it would erase projects still
            // on disk — meaning our in-memory state is poorer than disk (e.g. we
            // booted a seed while the server was briefly restarting). Pull the
            // authoritative disk copy back in instead of nagging or losing it.
            return fetch('/api/store').then(function (g) { return g.status === 200 ? g.json() : null; })
              .then(function (disk) {
                if (disk && Array.isArray(disk.ads) && pick(disk, state) === disk && disk !== state) {
                  state = disk; migrate(); persistLocal(); notify();
                  if (window.Ads && Ads.toast) Ads.toast('Reloaded your projects from disk.', false);
                }
                diskFailing = false;
              });
          }
          if (!r.ok) throw new Error('disk save failed (' + r.status + ')');
          diskFailing = false;
        })
        .catch(function (e) {
          // fail LOUDLY once per failure streak — silent loss is worse than noise
          if (!diskFailing && window.Ads && Ads.toast) Ads.toast('Warning: could not back up to disk — ' + e.message, true);
          diskFailing = true;
        });
    } catch (e) {}
  }

  // Async init: reconcile localStorage against the disk snapshot and keep the
  // RICHER copy (see pick()). This heals both directions — a restored disk is
  // never shadowed by a stale/emptied localStorage, and a disk that lost data
  // is re-seeded from a richer localStorage. If the disk read FAILS outright
  // (server briefly down), we fall back to localStorage and never seed over it.
  function init() {
    diskSave = util.debounce(pushToDisk, 1500);
    var local = null;
    try { var raw = window.localStorage.getItem(KEY); if (raw) local = JSON.parse(raw); } catch (e) {}
    var localOk = local && Array.isArray(local.ads);
    return fetch('/api/store').then(function (r) {
      if (r.status === 200) return r.json();
      if (r.status === 204) return null;          // server answered: disk simply empty
      return Promise.reject(new Error('http ' + r.status));
    }).then(function (disk) {
      var diskOk = disk && Array.isArray(disk.ads);
      if (diskOk && localOk) state = pick(disk, local);   // both readable → richer/newer wins
      else if (diskOk) state = disk;
      else if (localOk) state = local;
      else state = seed();
      migrate(); persistLocal();
      return state;
    }).catch(function () {
      // disk UNREADABLE (server down / network error) — trust localStorage if we
      // have it; otherwise an in-memory seed. Either way the server's clobber
      // guard blocks this state from later overwriting good disk data.
      if (localOk) { state = local; migrate(); return state; }
      state = seed(); migrate(); return state;
    });
  }

  // Forward-compatible: backfill any newly-added top-level keys.
  function migrate() {
    if (!state.brand) state.brand = defaultBrand();
    if (!state.settings) state.settings = defaultSettings();
    if (!state.settings.tracking) state.settings.tracking = { url: '' };
    if (!state.ads) state.ads = [];
    if (!state.meta) state.meta = { version: 1 };
    // live tracking: spend per adKey + the last stats snapshot pulled from the collector
    if (!state.tracking || typeof state.tracking !== 'object') state.tracking = { spend: {}, snapshot: null, syncedAt: null };
    if (!state.tracking.spend) state.tracking.spend = {};
    if (!state.tracking.ig) state.tracking.ig = { byId: {}, syncedAt: null };   // synced Instagram per-post insights
    if (!state.prefs || !state.prefs.liked) state.prefs = { liked: [], disliked: [] };
    if (!Array.isArray(state.projects)) state.projects = [];
    state.projects.forEach(function (p) {
      if (!p.brief) p.brief = { url: '', site: null, text: '', files: [], images: [], videos: [] };
      ['files', 'images', 'videos'].forEach(function (k) { if (!Array.isArray(p.brief[k])) p.brief[k] = []; });
      if (!Array.isArray(p.results)) p.results = [];
      if (!Array.isArray(p.savedAds)) p.savedAds = [];
      if (!Array.isArray(p.genImages)) p.genImages = [];
      if (!Array.isArray(p.rounds)) p.rounds = [];   // posting rounds (Performance → Campaign Rounds)
    });
    state.ads.forEach(function (a) {
      if (!a.metrics) a.metrics = clone(EMPTY_METRICS);
      if (!a.history) a.history = [];
      if (!a.metaIds) a.metaIds = { campaign: '', adset: '', ad: '' };
      if (!a.images) a.images = { before: null, after: null, product: null };
      if (!a.captions) a.captions = {};
      if (a.caption == null) a.caption = '';
      if (a.description == null) a.description = '';
      if (!a.layout) a.layout = 'auto';
      if (!a.density) a.density = 'standard';
      if (!a.align) a.align = 'left';
      if (!a.kind) a.kind = 'post';
      if (!a.motion) a.motion = 'auto';
      if (!a.videoFormat) a.videoFormat = 'story';
    });
  }

  /* ---- API --------------------------------------------------------------- */
  var store = {
    get state() { return state; },
    init: init,
    blankSpec: blankSpec,
    subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    notify: notify,

    // brand / settings
    getBrand: function () { return state.brand; },
    updateBrand: function (patch) { Object.assign(state.brand, patch); commit(); },
    getSettings: function () { return state.settings; },
    updateSettings: function (patch) { Object.assign(state.settings, patch); commit(); },

    // ads
    getAd: function (id) { return state.ads.filter(function (a) { return a.id === id; })[0] || null; },
    allAds: function () { return state.ads.slice(); },
    addAd: function (spec, extra) { var rec = newAd(spec, extra); state.ads.unshift(rec); commit(); return rec; },
    addAds: function (specs, extra) {
      var made = specs.map(function (s) { return newAd(s, extra); });
      state.ads = made.concat(state.ads); commit(); return made;
    },
    updateAd: function (id, patch) {
      var a = store.getAd(id); if (!a) return null;
      Object.assign(a, patch); a.updatedAt = util.nowISO(); commit(); return a;
    },
    duplicateAd: function (id) {
      var a = store.getAd(id); if (!a) return null;
      var copy = newAd(clone(a), { name: a.name + ' (copy)', status: 'draft', approvedAt: null, launchedAt: null, metrics: clone(EMPTY_METRICS), history: [] });
      state.ads.unshift(copy); commit(); return copy;
    },
    deleteAd: function (id) { state.ads = state.ads.filter(function (a) { return a.id !== id; }); commit(); },

    setStatus: function (id, status) {
      var a = store.getAd(id); if (!a) return;
      a.status = status; a.updatedAt = util.nowISO();
      if (status === 'approved' && !a.approvedAt) a.approvedAt = util.nowISO();
      if (status === 'active' && !a.launchedAt) a.launchedAt = util.nowISO();
      commit();
    },

    // metrics
    setMetrics: function (id, metrics) {
      var a = store.getAd(id); if (!a) return;
      Object.keys(metrics).forEach(function (k) { a.metrics[k] = metrics[k]; });
      a.updatedAt = util.nowISO(); commit();
    },
    addSnapshot: function (id, snapshot) {
      var a = store.getAd(id); if (!a) return;
      a.history.push(Object.assign({ date: util.todayISO() }, snapshot));
      commit();
    },

    // live tracking (collector stats + per-adKey spend) -----------------------
    getTracking: function () {
      if (!state.tracking) state.tracking = { spend: {}, snapshot: null, syncedAt: null };
      if (!state.tracking.spend) state.tracking.spend = {};
      if (!state.tracking.ig) state.tracking.ig = { byId: {}, syncedAt: null };
      return state.tracking;
    },
    setTrackSnapshot: function (snap) {
      var t = store.getTracking();
      t.snapshot = snap || null; t.syncedAt = util.nowISO(); commit();
    },
    // merge freshly synced Instagram per-post insights (keyed by IG media id)
    setTrackIG: function (byId) {
      var t = store.getTracking();
      Object.keys(byId || {}).forEach(function (id) { t.ig.byId[id] = byId[id]; });
      t.ig.syncedAt = util.nowISO(); commit();
    },
    setTrackSpend: function (adKey, val) {
      var t = store.getTracking();
      if (val == null || val === '' || isNaN(val)) delete t.spend[adKey];
      else t.spend[adKey] = +val;
      commit();
    },

    // projects (persistent briefs + their generated batches) ------------------
    listProjects: function () {
      return (state.projects || []).slice().sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    },
    getProject: function (id) { return (state.projects || []).filter(function (p) { return p.id === id; })[0] || null; },
    createProject: function (data) {
      var p = newProject(data);
      state.projects.unshift(p); commit(); return p;
    },
    updateProject: function (id, patch) {
      var p = store.getProject(id); if (!p) return null;
      Object.assign(p, patch); p.updatedAt = util.nowISO(); commit(); return p;
    },
    deleteProject: function (id) { state.projects = (state.projects || []).filter(function (p) { return p.id !== id; }); commit(); },

    // preference learning (liked / disliked ad signatures) --------------------
    getPrefs: function () { if (!state.prefs) state.prefs = { liked: [], disliked: [] }; return state.prefs; },
    recordVerdict: function (spec, verdict) {
      var p = store.getPrefs();
      var sig = {
        id: util.uid('v'), verdict: verdict, ts: util.nowISO(),
        kind: spec.kind, template: spec.template, format: spec.format,
        background: spec.background, accent: spec.accent, layout: spec.layout,
        density: spec.density, align: spec.align, motion: spec.motion, font: spec.font,
        typeMotion: (spec.dna && spec.dna.typeMotion) || '', bgMove: (spec.dna && spec.dna.bgMove) || '', grade: (spec.dna && spec.dna.grade) || '',
        isClip: !!spec.clip,
        headline: ((spec.headlineStart || '') + ' ' + (spec.headlineHighlight || '')).trim(),
        subtext: spec.subtext, cta: spec.cta, badge: spec.badge, caption: spec.caption,
        angle: spec.angle, hadImage: !!(spec.images && spec.images.product)
      };
      var arr = verdict === 'like' ? p.liked : p.disliked;
      arr.push(sig);
      while (arr.length > 300) arr.shift(); // cap the corpus
      commit();
      return sig.id;
    },
    removeVerdict: function (id) {
      var p = store.getPrefs();
      p.liked = p.liked.filter(function (s) { return s.id !== id; });
      p.disliked = p.disliked.filter(function (s) { return s.id !== id; });
      commit();
    },
    clearPrefs: function () { state.prefs = { liked: [], disliked: [] }; commit(); },

    // io
    exportJSON: function () { return JSON.stringify(state, null, 2); },
    importJSON: function (text) {
      var data = JSON.parse(text);
      if (!data || !Array.isArray(data.ads)) throw new Error('Not a valid Ads Hub export (missing "ads").');
      state = data; migrate(); commit();
    },
    saveToDisk: function () { return fetch('/api/store', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' }, body: JSON.stringify(state) }); },
    reset: function () { state = seed(); commit(); }
  };

  Ads.store = store;
})();
