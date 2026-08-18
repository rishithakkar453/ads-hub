/* ============================================================================
   ADS HUB — AI-first mass generator
   One flow: feed it a brief (website URL + extra text + PDF/TXT files +
   product images), pick how many variations (1–100), and the engine writes
   the copy and composes radically different creatives — different templates,
   image placements, image choices, copy density, palettes and alignment.
   Every variation ships as a complete Facebook ad (creative + caption +
   headline + description + CTA) previewed in a phone / tablet / laptop frame.
   Editing is AI-first: an "Edit ad" button opens the full editor.
   Exposes window.Ads.gen.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var store = Ads.store, util = Ads.util, T = Ads.templates, render = Ads.render,
      ai = Ads.ai, devices = Ads.devices, briefLib = Ads.brief;
  var esc = util.escapeHtml;
  function icons() { return Ads.icons; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ===================== state ========================================== */
  var gen = {
    projectId: null,          // the persistent project this work is saved to
    projectName: '',
    brief: { url: '', site: null, text: '', files: [], images: [], videos: [] },
    count: 12,
    imgCount: 6,              // how many relevant images to generate at a time
    genImgBusy: false,        // an image-concept generation is in flight
    animBusy: {},             // genImage id → true while Veo is filming it
    audienceBusy: false,      // an audience analysis is in flight (project id)
    gemStatus: null,          // cached Nano Banana (Gemini) on/off, so the panel can offer an inline key
    view: 'plain',            // default: just the ad + caption, no device chrome
    platform: 'facebook',
    mix: 'both',              // both (2:1 posts:video) | posts | video
    results: [],
    selected: {},
    liked: {},                // index → verdict id (for un-liking)
    disliked: {},             // index → { id, timer } (undo window)
    removed: {},              // index → true (disliked past the undo window)
    generating: false,
    statusMsg: '',
    runSeq: 0                 // bumped on project switch → stale async work bails
  };
  var viewEl = null;

  /* ===================== projects: persistence ========================== */
  function projectNameFrom() {
    var b = gen.brief, site = b.site;
    if (site && (site.siteName || site.title)) return (site.siteName || site.title).split(/[|–—·]/)[0].trim().slice(0, 60);
    var u = (b.url || '').trim();
    if (u) { try { return new URL(/^https?:/i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch (e) {} }
    if (b.videos.length) return String(b.videos[0].name || 'Video project').replace(/\.[a-z0-9]+$/i, '');
    if (b.files.length) return String(b.files[0].name || 'Document project').replace(/\.[a-z0-9]+$/i, '');
    return 'Untitled project';
  }
  function currentProject() { return gen.projectId ? store.getProject(gen.projectId) : null; }
  // base for tracked ad links: the public collector once configured, else this
  // machine (works for local testing; real campaigns need the public URL)
  function trackBase() {
    var t = store.getSettings().tracking || {};
    return String(t.url || window.location.origin).replace(/\/+$/, '');
  }
  function ensureProject() {
    var p = currentProject();
    if (p) return p;
    p = store.createProject({ name: projectNameFrom() });
    gen.projectId = p.id; gen.projectName = p.name;
    rememberProject(p.id);
    refreshProjectBar();
    return p;
  }
  function projectThumb() {
    var b = gen.brief;
    return b.images[0] || (b.videos[0] && b.videos[0].poster) ||
      (b.site && ((b.site.images || [])[0] || b.site.ogImage)) || null;
  }
  // videos are saved by reference to their server URL only — a blob: object
  // URL is session-scoped and would be a dead link after reload
  function durableUrl(u) { return /^\/pfiles\//.test(u || '') ? u : null; }
  function briefForSave() {
    var b = gen.brief;
    return {
      url: b.url, site: b.site ? clone(b.site) : null, text: b.text,
      files: clone(b.files), images: b.images.slice(),
      videos: b.videos.map(function (v) {
        return { name: v.name || '', url: durableUrl(v.url), poster: v.poster || null,
          clips: v.clips ? clone(v.clips) : [], frames: (v.frames || []).slice(), transcript: v.transcript || '',
          frameSel: v.frameSel ? v.frameSel.slice() : null,
          framesTried: !!v.framesTried, transcriptTried: !!v.transcriptTried };
      })
    };
  }
  function saveProject(extra) {
    var p = currentProject(); if (!p) return;
    var patch = Object.assign({
      name: (p.name === 'Untitled project') ? projectNameFrom() : p.name,
      thumb: projectThumb(),
      brief: briefForSave(),
      mix: gen.mix, count: gen.count
    }, extra || {});
    store.updateProject(p.id, patch);
    gen.projectName = store.getProject(p.id).name;
    refreshProjectBar();
  }
  var saveProjectSoon = util.debounce(function () { if (gen.projectId) saveProject(); }, 900);

  function openProject(id) {
    var p = store.getProject(id);
    if (!p) { Ads.toast('Project not found', true); return; }
    stopControllers();
    gen.projectId = p.id; gen.projectName = p.name;
    var b = clone(p.brief || {});
    gen.brief = {
      url: b.url || '', site: b.site || null, text: b.text || '',
      files: b.files || [], images: b.images || [],
      videos: (b.videos || []).filter(function (v) { return durableUrl(v.url); })
    };
    gen.mix = p.mix || 'both'; gen.count = p.count || 12;
    // generated batches are session-only: a reopened project starts with a
    // clean slate + its saved (liked) ads. Only savedAds survive reloads.
    gen.results = [];
    gen.selected = {}; gen.liked = {}; gen.disliked = {}; gen.removed = {};
    gen.generating = false; gen.statusMsg = '';
    gen.researching = false; gen.analyzing = false; gen.genImgBusy = false; gen.animBusy = {}; gen.audienceBusy = false;   // a switch must not leave the old project's in-flight flags set (would block the new project's auto-research / image gen)
    gen.runSeq++;                       // cancel any in-flight generate/upload work
    gen.copyEngine = p.copyEngine || ''; gen.copyInputs = p.copyInputs || [];
    rememberProject(p.id);
    Ads.go('generator');
    setTimeout(backfillVideos, 80);   // process pre-feature videos (frames/transcript)
    setTimeout(healMounts, 900);      // fix any creatives mounted before the layout settled
    setTimeout(healMounts, 2600);
    setTimeout(function () { reportRenderDiag(p.id); }, 4000);
  }
  // Self-diagnostic: after the saved shelf has had time to decode + paint,
  // measure how it ACTUALLY rendered on this machine and log it server-side
  // (data/track/diag.jsonl). Debugs "shows for me, blank for a colleague"
  // without needing access to the other person's browser. One report per
  // project per page load; fire-and-forget, never user-visible.
  var diagSent = {};
  function reportRenderDiag(pid, recheck) {
    try {
      if ((!recheck && diagSent[pid]) || gen.projectId !== pid) return;
      if (!recheck) diagSent[pid] = 1;
      var shelf = document.querySelector('#gen-saved');
      var p = store.getProject(pid);
      var imgs = shelf ? [].slice.call(shelf.querySelectorAll('img')) : [];
      var canvases = shelf ? [].slice.call(shelf.querySelectorAll('canvas')) : [];
      var stages = shelf ? [].slice.call(shelf.querySelectorAll('.ad-stage')) : [];
      var painted = 0;
      canvases.slice(0, 6).forEach(function (cv) {
        try {
          var c = document.createElement('canvas'); c.width = 8; c.height = 8;
          var x = c.getContext('2d'); x.drawImage(cv, 0, 0, 8, 8);
          var d = x.getImageData(0, 0, 8, 8).data, s = 0;
          for (var i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
          if (s > 400) painted++;
        } catch (e) { painted = -1; }
      });
      var visible = stages.filter(function (s) { var r = s.getBoundingClientRect(); return r.width > 5 && r.height > 5; }).length;
      // per-cell layout forensics: slot width, mounted visual's rect + transform,
      // and offsetParent (null ⇔ a display:none ancestor kills all layout)
      var cellsDiag = [];
      if (shelf) [].slice.call(shelf.querySelectorAll('.saved-cell')).slice(0, 3).forEach(function (cell) {
        var slot = cell.querySelector('[data-ad-slot]');
        var vis = slot && slot.firstChild;
        var r = (vis && vis.getBoundingClientRect) ? vis.getBoundingClientRect() : null;
        cellsDiag.push({
          slotW: slot ? slot.clientWidth : -1,
          visW: r ? Math.round(r.width) : -1,
          visH: r ? Math.round(r.height) : -1,
          tf: vis ? getComputedStyle(vis).transform.slice(0, 40) : '',
          hidden: slot ? (slot.offsetParent === null) : null
        });
      });
      var shelfR = shelf ? shelf.getBoundingClientRect() : null;
      var report = {
        v: 2,
        why: recheck ? 'saved-shelf recheck' : 'saved-shelf render',
        ua: navigator.userAgent.slice(0, 160),
        viewport: window.innerWidth + 'x' + window.innerHeight,
        dpr: window.devicePixelRatio,
        visState: document.visibilityState,
        framed: window.top !== window.self,
        project: pid,
        savedInStore: (p && p.savedAds || []).length,
        shelfCells: shelf ? shelf.querySelectorAll('.ad-stage-scaler, canvas').length : -1,
        shelfRect: shelfR ? Math.round(shelfR.width) + 'x' + Math.round(shelfR.height) + '@' + Math.round(shelfR.top) : null,
        shelfHidden: shelf ? (shelf.offsetParent === null) : null,
        imgs: imgs.length,
        imgsDecoded: imgs.filter(function (im) { return im.naturalWidth > 0; }).length,
        canvases: canvases.length,
        canvasPaintedSample: painted + '/' + Math.min(6, canvases.length),
        stages: stages.length,
        stagesVisible: visible,
        cells: cellsDiag,
        healRuns: healCount,
        memoryMB: (performance && performance.memory) ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null
      };
      fetch('/api/diag', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' }, body: JSON.stringify(report) }).catch(function () {});
      // if nothing was visible, report again later so the log shows whether
      // the visibility-triggered heal eventually fixed it on this machine
      if (!recheck && stages.length && !visible) setTimeout(function () { reportRenderDiag(pid, true); }, 10000);
    } catch (e) {}
  }
  // the last opened project auto-reopens after a page reload, so saved ads
  // and the whole brief are right there without a trip to My Projects
  function rememberProject(id) {
    try { window.localStorage.setItem('ads-hub:lastProject', id || ''); } catch (e) {}
  }
  function lastProjectId() {
    try { return window.localStorage.getItem('ads-hub:lastProject') || ''; } catch (e) { return ''; }
  }
  function startNewProject() {
    stopControllers();
    gen.runSeq++;                       // cancel any in-flight generate/upload work
    gen.projectId = null; gen.projectName = '';
    gen.brief = { url: '', site: null, text: '', files: [], images: [], videos: [] };
    gen.results = []; gen.selected = {}; gen.liked = {}; gen.disliked = {}; gen.removed = {};
    gen.generating = false; gen.statusMsg = ''; gen.copyEngine = ''; gen.copyInputs = [];
    gen.researching = false; gen.analyzing = false; gen.genImgBusy = false; gen.animBusy = {}; gen.audienceBusy = false;
    Ads.go('generator');
  }
  function refreshProjectBar() {
    var elp = viewEl && viewEl.querySelector('#gb-projname');
    if (elp) elp.textContent = gen.projectName || 'New project';
  }
  /* ===================== project dossier (deep understanding) =========== */
  // The AI reads EVERYTHING on the project (site copy, documents, notes,
  // images + video frames) and writes a long grounded dossier. That dossier —
  // not the raw scraps — is what every ad is then written from.
  function sourcesKey() {
    // content fingerprints, not counts — swapping an image or a same-length
    // text edit must register as a change (hashStr is hoisted from below)
    var b = gen.brief;
    return [
      (b.url || '').trim(),
      hashStr(((b.site && b.site.text) || '') + '|' + ((b.site && b.site.title) || '')),
      hashStr(b.text || ''),
      b.files.map(function (f) { return f.name + ':' + hashStr(f.text || ''); }).join(','),
      b.images.map(function (i) { return hashStr(String(i).slice(0, 4096)) + ':' + String(i).length; }).join(','),
      b.videos.map(function (v) { return (v.name || '') + ':' + ((v.clips || []).length) + ':' + ((v.frames || []).length) + ':' + hashStr(v.transcript || ''); }).join(',')
    ].join('|');
  }
  function currentDossier() {
    var p = currentProject();
    return (p && p.dossier && p.dossier.sections) ? p.dossier : null;
  }
  function dossierFresh() {
    var d = currentDossier();
    return !!(d && d.sourcesKey === sourcesKey());
  }
  // images the model should look at: uploads, frames sampled ACROSS each
  // video (real scene coverage — this is how it "watches" the footage),
  // clip posters as fallback, site hero
  function dossierImages() {
    var b = gen.brief, out = [];
    b.images.slice(0, 3).forEach(function (i) { out.push(i); });
    b.videos.forEach(function (v) {
      if ((v.frames || []).length) {
        v.frames.slice(0, 9).forEach(function (f) { out.push(f); });
      } else {
        (v.clips || []).slice(0, 2).forEach(function (c) { if (c.poster) out.push(c.poster); });
        if (v.poster) out.push(v.poster);
      }
    });
    if (b.site && (b.site.images || [])[0]) out.push(b.site.images[0]);
    return out.filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, 12);
  }
  function dossierVideos() {
    return gen.brief.videos
      .filter(function (v) { return v.transcript; })
      .map(function (v) { return { name: v.name || 'video', transcript: String(v.transcript).slice(0, 9000) }; });
  }
  // flatten the structured dossier into the long-form brief the copy AI reads
  function dossierText(d) {
    if (!d) return '';
    function list(t, a) { return (Array.isArray(a) && a.length) ? (t + ':\n- ' + a.join('\n- ') + '\n\n') : ''; }
    return (d.summary ? d.summary + '\n\n' : '') +
      (d.product ? 'THE PRODUCT: ' + d.product + '\n\n' : '') +
      (d.audience ? 'AUDIENCE: ' + d.audience + '\n\n' : '') +
      list('KEY BENEFITS', d.benefits) + list('FEATURES', d.features) +
      list('REAL PROOF (use ONLY these for stats/quotes)', d.proof) +
      list('OBJECTIONS TO ANSWER', d.objections) +
      (d.tone ? 'BRAND TONE: ' + d.tone + '\n\n' : '') +
      (d.visuals ? 'VISUALS: ' + d.visuals + '\n\n' : '') +
      list('KEYWORDS', d.keywords);
  }
  var analyzeState = null;   // { pid, promise } — the in-flight deep read
  function analyzeProject() {
    if (!Ads._aiEnabled) { Ads.toast('Turn AI on (top-right) so it can read the project', true); return Promise.resolve(null); }
    var p = ensureProject(), pid = p.id;
    // join an in-flight analysis of the same project instead of racing it —
    // e.g. Generate clicked while the manual "Read everything" is running
    if (analyzeState && analyzeState.pid === pid) return analyzeState.promise;

    // a typed-but-never-read URL must be scraped first (the manual-analyze
    // path doesn't go through generate()'s scrape step)
    var url = gen.brief.url.trim();
    var needScrape = url && (!gen.brief.site || gen.brief.site.url !== url);
    gen.analyzing = pid; refreshDossierPanel();
    var pre = needScrape
      ? ai.scrape(url).then(function (site) {
          if (gen.projectId === pid) { gen.brief.site = site; gen.brief.site.url = url; renderSources(); }
        }).catch(function () {     // site is optional, but never fail silently
          if (gen.projectId === pid) Ads.toast('Couldn\'t read the website — analyzing everything else without it', true);
        })
      : Promise.resolve();

    var promise = pre.then(function () {
      if (gen.projectId !== pid) throw new Error('__switched__');
      var key = sourcesKey();      // computed AFTER the scrape settles
      // record EXACTLY what this analysis consumed — the panel shows this,
      // so "did it read the website?" is never a mystery
      var readSnapshot = {
        website: gen.brief.site
          ? ((gen.brief.site.siteName || gen.brief.site.title || 'website') + ' (' + (String(gen.brief.site.text || '').length > 2500 ? 'full page copy' : String(gen.brief.site.text || '').length + ' chars of page copy') + ')')
          : ((gen.brief.url || '').trim() ? 'WEBSITE COULD NOT BE READ' : null),
        files: gen.brief.files.map(function (f) { return f.name; }),
        images: gen.brief.images.length,
        videos: gen.brief.videos.map(function (v) {
          var vBits = [];
          if ((v.frames || []).length) vBits.push(v.frames.length + ' frames');
          if (v.transcript) vBits.push('transcript');
          return (v.name || 'video') + (vBits.length ? ' (' + vBits.join(' + ') + ')' : ' (poster only)');
        })
      };
      return ai.generateDossier({
        site: gen.brief.site, files: gen.brief.files, notes: gen.brief.text,
        images: dossierImages(),
        videos: dossierVideos(),           // full transcripts — what the footage says
        brand: { name: (gen.brief.site && gen.brief.site.siteName) || store.getBrand().name }
      }).then(function (d) {
        gen.analyzing = false; analyzeState = null;
        // the write targets the CAPTURED project — safe even after a switch
        var dossier = { sections: d, text: dossierText(d), sourcesKey: key, read: readSnapshot, createdAt: util.nowISO() };
        store.updateProject(pid, { dossier: dossier });
        if (gen.projectId === pid) refreshDossierPanel();
        maybeAutoResearch(pid);   // now that we understand it, research the market (background)
        return dossier;
      });
    }).catch(function (e) {
      gen.analyzing = false; analyzeState = null;
      if (gen.projectId === pid && e.message !== '__switched__') {
        refreshDossierPanel();
        Ads.toast('Could not analyze the project: ' + e.message, true);
      }
      return null;
    });
    analyzeState = { pid: pid, promise: promise };
    return promise;
  }
  // what the dossier ACTUALLY consumed at analysis time (falls back to the
  // live brief for dossiers created before the read-record existed)
  function sourcesReadLine() {
    var d = currentDossier();
    if (d && d.read) {
      var r = d.read, bits = [];
      if (r.website) bits.push(r.website);
      if ((r.files || []).length) bits.push(r.files.join(', '));
      if (r.images) bits.push(r.images + ' image' + (r.images > 1 ? 's' : ''));
      (r.videos || []).forEach(function (vd) { bits.push(vd); });
      return bits.join(' · ');
    }
    var b = gen.brief, bits2 = [];
    if (b.site || (b.url || '').trim()) bits2.push('website');
    if (b.files.length) bits2.push(b.files.length + ' doc' + (b.files.length > 1 ? 's' : ''));
    if (b.images.length) bits2.push(b.images.length + ' image' + (b.images.length > 1 ? 's' : ''));
    b.videos.forEach(function (v) { bits2.push((v.name || 'video') + ((v.frames || []).length ? ' (' + v.frames.length + ' frames)' : '')); });
    return bits2.join(' · ');
  }
  function dossierPanel() {
    var d = currentDossier(), s = d && d.sections;
    var inner;
    if (gen.analyzing && gen.analyzing === gen.projectId) {
      inner = '<div class="dos-state"><span class="spinner"></span> Reading everything you provided — site copy, documents, images and video frames…</div>';
    } else if (!s) {
      inner = '<div class="dos-state is-empty">The AI hasn\'t read this project yet. It happens automatically when you Generate' +
        (Ads._aiEnabled ? '' : ' (needs the AI toggle on)') + ', or start it now.</div>' +
        '<div class="btn-row"><button class="btn is-sm" id="dos-analyze"><span class="btn-ico">' + icons().sparkle + '</span> Read &amp; understand everything</button></div>';
    } else {
      function list(t, a) { return (Array.isArray(a) && a.length) ? ('<div class="dos-sec"><h4>' + t + '</h4><ul>' + a.map(function (x) { return '<li>' + esc(String(x)) + '</li>'; }).join('') + '</ul></div>') : ''; }
      function para(t, x) { return x ? ('<div class="dos-sec"><h4>' + t + '</h4><p>' + esc(x) + '</p></div>') : ''; }
      var stale = !dossierFresh() ? '<span class="dos-stale" title="You added or removed material since this was written">sources changed — will re-read on Generate</span>' : '';
      inner =
        '<p class="dos-summary">' + esc(s.summary || '') + '</p>' +
        '<details class="dos-details"><summary>Show the full dossier</summary>' +
          para('The product', s.product) + para('Audience', s.audience) +
          list('Key benefits', s.benefits) + list('Features', s.features) +
          list('Real proof found', s.proof) + list('Objections to answer', s.objections) +
          para('Brand tone', s.tone) + para('Visuals', s.visuals) + list('Keywords', s.keywords) +
        '</details>' +
        '<div class="dos-foot"><span class="u-faint">Read: ' + esc(sourcesReadLine() || '—') + '</span>' + stale +
          '<span class="toolbar-spacer"></span>' +
          '<button class="btn is-ghost is-sm" id="dos-edit">Edit</button>' +
          '<button class="btn is-ghost is-sm" id="dos-analyze">Re-analyze</button>' +
        '</div>';
    }
    return '<section class="gen-dossier" id="gen-dossier">' +
      '<div class="dos-head"><h3>Project understanding</h3>' +
        '<span class="u-label">' + (s ? 'every ad is written from this' : 'deep read of all your material') + '</span></div>' +
      inner +
    '</section>';
  }
  function bindDossier(el) {
    var an = el.querySelector('#dos-analyze');
    if (an) an.addEventListener('click', function () {
      if (!hasAnyInput()) { Ads.toast('Add a URL, files, images or a video first', true); return; }
      function go() { analyzeProject().then(function (d) { if (d) Ads.toast('Project read & understood — ads will now be written from the dossier'); }); }
      var d = currentDossier();
      if (d && d.editedAt) {
        Ads.confirm({ title: 'Replace your edits?', message: 'Re-analyzing rewrites the dossier from scratch and replaces the manual edits you made.', okLabel: 'Re-analyze', danger: true, onConfirm: go });
      } else go();
    });
    var ed = el.querySelector('#dos-edit');
    if (ed) ed.addEventListener('click', openDossierEditor);
  }
  function refreshDossierPanel() {
    var elp = viewEl && viewEl.querySelector('#gen-dossier');
    if (!elp) return;
    elp.outerHTML = dossierPanel();
    bindDossier(viewEl);
  }
  function openDossierEditor() {
    var d = currentDossier(); if (!d) return;
    var s = d.sections;
    function j(a) { return (a || []).join('\n'); }
    Ads.form({
      title: 'Edit project understanding', wide: true,
      fields: [
        { name: 'summary', label: 'Summary', type: 'textarea', rows: 3, default: s.summary || '' },
        { name: 'product', label: 'The product', type: 'textarea', rows: 4, default: s.product || '' },
        { name: 'audience', label: 'Audience', type: 'textarea', rows: 3, default: s.audience || '' },
        { name: 'benefits', label: 'Key benefits (one per line)', type: 'textarea', rows: 4, default: j(s.benefits) },
        { name: 'features', label: 'Features (one per line)', type: 'textarea', rows: 4, default: j(s.features) },
        { name: 'proof', label: 'Real proof (one per line)', type: 'textarea', rows: 3, default: j(s.proof) },
        { name: 'objections', label: 'Objections to answer (one per line)', type: 'textarea', rows: 3, default: j(s.objections) },
        [{ name: 'tone', label: 'Brand tone', type: 'textarea', rows: 2, default: s.tone || '' },
         { name: 'visuals', label: 'Visuals', type: 'textarea', rows: 2, default: s.visuals || '' }],
        { name: 'keywords', label: 'Keywords (one per line)', type: 'textarea', rows: 2, default: j(s.keywords) }
      ],
      submitLabel: 'Save dossier',
      onSubmit: function (data) {
        function sp(t) { return String(t || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean); }
        var ns = {
          summary: data.summary, product: data.product, audience: data.audience,
          benefits: sp(data.benefits), features: sp(data.features), proof: sp(data.proof),
          objections: sp(data.objections), tone: data.tone, visuals: data.visuals, keywords: sp(data.keywords)
        };
        var p = currentProject(); if (!p) return Ads.closeModal();
        // the user just reviewed the dossier against the CURRENT material —
        // stamp today's key so their edits aren't clobbered on the next Generate
        store.updateProject(p.id, { dossier: { sections: ns, text: dossierText(ns), sourcesKey: sourcesKey(), createdAt: d.createdAt, editedAt: util.nowISO() } });
        Ads.closeModal(); refreshDossierPanel();
        Ads.toast('Dossier updated — future ads use your edits');
      }
    });
  }

  /* ===================== market research (pain points) ================== */
  // The research bar mines the market for real pain points (via Claude web
  // search when available) — each one an ad-ready hook + headline + tagline +
  // description. Selected pain points feed every subsequent Generate.
  function currentResearch() {
    var p = currentProject();
    return (p && p.research && Array.isArray(p.research.painPoints)) ? p.research : null;
  }
  function researchSelection() {
    var r = currentResearch(); if (!r) return [];
    return r.painPoints.filter(function (_, i) { return r.selected ? !!r.selected[i] : true; });
  }
  function defaultTopic() {
    var r = currentResearch(); if (r && r.topic) return r.topic;
    var d = currentDossier();
    if (d && d.sections) {
      if (d.sections.researchQuery) return d.sections.researchQuery;   // the AI's own suggested topic
      if ((d.sections.keywords || []).length) return d.sections.keywords.slice(0, 3).join(', ');
    }
    var n = projectNameFrom();
    return n === 'Untitled project' ? '' : n;
  }
  // Once the project is understood, automatically research the market for the
  // pain points it should target — the AI chooses the topic (dossier.researchQuery),
  // with a derived fallback. Non-blocking so it never holds up generation, and
  // it only fires when nothing has been researched yet (respects the user).
  function autoResearchTopic() {
    var d = currentDossier(); if (!d || !d.sections) return '';
    var s = d.sections;
    if (s.researchQuery) return String(s.researchQuery).slice(0, 220);
    if (s.audience) return 'frustrations and unmet needs of ' + String(s.audience).split(/[.,;:]/)[0].trim().slice(0, 140);
    if ((s.keywords || []).length) return s.keywords.slice(0, 3).join(', ');
    return '';
  }
  function maybeAutoResearch(pid) {
    if (!Ads._aiEnabled) return;
    if (gen.projectId !== pid) return;           // only for the project on screen
    var proj = store.getProject(pid);
    if (!proj || proj.research) return;          // already has research — don't override
    if (gen.researching) return;                 // something already running
    var topic = autoResearchTopic();
    if (topic) runResearch(topic, true);         // true = auto (softer toasts)
  }
  function runResearch(topic, auto) {
    if (!Ads._aiEnabled) { if (!auto) Ads.toast('Turn AI on (top-right) to run market research', true); return Promise.resolve(null); }
    topic = String(topic || '').trim();
    if (!topic) { if (!auto) Ads.toast('Give the research bar a topic first', true); return Promise.resolve(null); }
    if (gen.researching) {
      if (!auto) Ads.toast(gen.researching === gen.projectId ? 'Research is already running' : 'Research is still running in another project — give it a moment', true);
      return Promise.resolve(null);
    }
    if (auto) Ads.toast('Understood your project — now researching the market for pain points to target…');
    var p = ensureProject(), pid = p.id;
    gen.researching = pid; refreshResearchPanel();
    var d = currentDossier();
    var context = d ? (d.sections.summary + ' ' + (d.sections.product || '')).slice(0, 2000)
      : (gen.brief.site ? ((gen.brief.site.title || '') + ' — ' + (gen.brief.site.description || '')) : '');
    return ai.research({ topic: topic, context: context, count: 20 }).then(function (r) {
      if (gen.researching === pid) gen.researching = false;   // only clear OUR run — a concurrent one on another project keeps its flag
      var research = {
        topic: r.research.topic || topic, summary: r.research.summary || '',
        painPoints: r.research.painPoints, selected: {},
        webSearch: r.webSearch, createdAt: util.nowISO()
      };
      r.research.painPoints.forEach(function (_, i) { research.selected[i] = true; });  // all on by default
      var patch = { research: research };
      var proj = store.getProject(pid);
      if (proj && proj.name === 'Untitled project') patch.name = topic.slice(0, 60);
      store.updateProject(pid, patch);
      if (gen.projectId === pid) { gen.projectName = store.getProject(pid).name; refreshProjectBar(); refreshResearchPanel(); }
      Ads.toast((auto ? 'Auto-research done — ' : 'Found ') + research.painPoints.length + ' pain point' + (research.painPoints.length === 1 ? '' : 's') + (r.webSearch ? ' (web-researched)' : ' (market knowledge)') + (auto ? ' — they\'ll shape your ads' : ''));
      return research;
    }).catch(function (e) {
      if (gen.researching === pid) gen.researching = false;
      if (gen.projectId === pid) { refreshResearchPanel(); Ads.toast('Research failed: ' + e.message, true); }
      return null;
    });
  }
  function researchPanel() {
    var r = currentResearch();
    var inner;
    if (gen.researching && gen.researching === gen.projectId) {
      inner = '<div class="dos-state"><span class="spinner"></span> Researching the market — complaints, reviews, forums… this can take a minute.</div>';
    } else if (!r) {
      inner = '<div class="rs-bar">' +
        '<input class="input" id="rs-topic" placeholder="e.g. home espresso machines — or leave it to your project topic" value="' + esc(defaultTopic()) + '">' +
        '<button class="btn is-sm" id="rs-go"><span class="btn-ico">' + icons().search + '</span> Research pain points</button>' +
      '</div>' +
      '<div class="hint">Runs <strong>automatically</strong> once the AI understands your project — it picks the topic from what it learns. Or type your own here. Each pain point becomes an ad-ready hook, headline, tagline and description that feeds Generate.</div>';
    } else {
      var sel = r.selected || {};
      var cards = r.painPoints.map(function (pp, i) {
        var on = sel[i] === undefined ? true : !!sel[i];   // honor a stored false
        return '<div class="rs-card' + (on ? ' is-on' : '') + '" data-rsi="' + i + '">' +
          '<label class="rs-check"><input type="checkbox" data-rstoggle="' + i + '"' + (on ? ' checked' : '') + '> use in ads</label>' +
          '<div class="rs-pain">' + esc(pp.pain) + (pp.who ? ' <span class="rs-who">— ' + esc(pp.who) + '</span>' : '') + '</div>' +
          (pp.quote ? '<div class="rs-quote">“' + esc(pp.quote) + '”</div>' : '') +
          '<div class="rs-hook">' + esc(pp.hook || pp.headline) + '</div>' +
          '<div class="rs-lines"><b>' + esc(pp.headline || '') + '</b>' + (pp.tagline ? ' · ' + esc(pp.tagline) : '') + '</div>' +
          (pp.description ? '<div class="rs-desc">' + esc(pp.description) + '</div>' : '') +
          (pp.source ? '<div class="rs-src">' + esc(pp.source) + '</div>' : '') +
        '</div>';
      }).join('');
      var nSel = researchSelection().length;
      inner =
        (r.summary ? '<p class="dos-summary">' + esc(r.summary) + '</p>' : '') +
        '<div class="rs-grid">' + cards + '</div>' +
        '<div class="dos-foot">' +
          '<span class="u-faint" id="rs-count">' + nSel + ' of ' + r.painPoints.length + ' pain points will shape the next Generate · ' + (r.webSearch ? 'web-researched' : 'market knowledge') + '</span>' +
          '<span class="toolbar-spacer"></span>' +
          '<input class="input rs-again-input" id="rs-topic" value="' + esc(r.topic) + '">' +
          '<button class="btn is-ghost is-sm" id="rs-go">Re-research</button>' +
          '<button class="btn is-ghost is-sm" id="rs-clear">Clear</button>' +
        '</div>';
    }
    return '<section class="gen-dossier gen-research" id="gen-research">' +
      '<div class="dos-head"><h3>Market research</h3>' +
        '<span class="u-label">' + (r ? 'pain points → hooks, headlines & taglines' : 'find the market\'s pain points') + '</span></div>' +
      inner +
    '</section>';
  }
  function bindResearch(el) {
    var go = el.querySelector('#rs-go');
    if (go) go.addEventListener('click', function () {
      var t = el.querySelector('#rs-topic');
      runResearch(t ? t.value : defaultTopic());
    });
    var ti = el.querySelector('#rs-topic');
    if (ti) ti.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); runResearch(ti.value); } });
    var cl = el.querySelector('#rs-clear');
    if (cl) cl.addEventListener('click', function () {
      var p = currentProject(); if (!p) return;
      Ads.confirm({ title: 'Clear this research?', message: 'The pain points and their hooks will be removed from the project.', danger: true, okLabel: 'Clear', onConfirm: function () {
        store.updateProject(p.id, { research: null }); refreshResearchPanel();
      } });
    });
    el.querySelectorAll('[data-rstoggle]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var p = currentProject(); if (!p || !p.research) return;
        var i = +cb.getAttribute('data-rstoggle');
        p.research.selected = p.research.selected || {};
        p.research.selected[i] = cb.checked;
        store.updateProject(p.id, { research: p.research });
        var card = cb.closest('.rs-card'); if (card) card.classList.toggle('is-on', cb.checked);
        var cnt = viewEl && viewEl.querySelector('#rs-count');
        if (cnt) cnt.textContent = researchSelection().length + ' of ' + p.research.painPoints.length + ' pain points will shape the next Generate · ' + (p.research.webSearch ? 'web-researched' : 'market knowledge');
      });
    });
  }
  function refreshResearchPanel() {
    var elp = viewEl && viewEl.querySelector('#gen-research');
    if (!elp) return;
    elp.outerHTML = researchPanel();
    bindResearch(viewEl);
  }

  /* ===================== generate relevant images ======================= */
  // Reference photos the AI art-directs FROM (uploads + site + video frames) —
  // NOT the already-generated ones, so there's no feedback loop.
  function referenceImages() {
    var pool = (gen.brief.images || []).slice();
    var site = gen.brief.site;
    if (site && site.images && site.images.length) pool = pool.concat(site.images);
    (gen.brief.videos || []).forEach(function (v) { framesOf(v).slice(0, 4).forEach(function (f) { pool.push(f); }); });
    return pool.filter(function (u, i, a) { return /^data:/i.test(u) && a.indexOf(u) === i; }).slice(0, 6);
  }
  // what the art director understands the project to be: the FULL dossier and
  // the research pain points in the buyers' own words — this is the raw
  // material the image concepts are invented from, so hold nothing back
  function imageContext() {
    var d = currentDossier(), parts = [];
    if (d && d.sections) {
      var s = d.sections;
      if (s.summary) parts.push('WHAT THIS IS:\n' + s.summary);
      if (s.product) parts.push('THE PRODUCT IN DETAIL:\n' + s.product);
      if (s.audience) parts.push('WHO IT IS FOR:\n' + s.audience);
      if ((s.benefits || []).length) parts.push('WHAT BUYERS GET:\n- ' + s.benefits.slice(0, 10).join('\n- '));
      if ((s.proof || []).length) parts.push('REAL PROOF:\n- ' + s.proof.slice(0, 6).join('\n- '));
      if ((s.objections || []).length) parts.push('WHAT HOLDS BUYERS BACK:\n- ' + s.objections.slice(0, 6).join('\n- '));
      if (s.visuals) parts.push('THE BRAND\'S CURRENT VISUAL WORLD:\n' + s.visuals);
      if (s.tone) parts.push('BRAND TONE: ' + s.tone);
    }
    var r = currentResearch();
    if (r && (r.painPoints || []).length) {
      parts.push('MARKET RESEARCH — REAL BUYER PAIN POINTS (each is a story an image could dramatize):\n' +
        r.painPoints.slice(0, 14).map(function (p, i) {
          var line = (i + 1) + '. ' + (p.pain || '');
          if (p.who) line += '\n   Who feels it: ' + p.who;
          if (p.quote) line += '\n   In their words: "' + p.quote + '"';
          if (p.hook) line += '\n   The ad hook it powers: ' + p.hook;
          return line;
        }).join('\n'));
    }
    if (!parts.length && gen.brief.site) parts.push((gen.brief.site.title || '') + ' — ' + (gen.brief.site.description || ''));
    if (!parts.length && gen.brief.text) parts.push(gen.brief.text.slice(0, 1500));
    return parts.join('\n\n').slice(0, 16000);
  }
  // tiny colour blend for the placeholder swatches
  function blend2(hex, hex2, t) {
    function rgb(h) { h = String(h || '').replace('#', ''); if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
    var a = rgb(hex), b = rgb(hex2); if (isNaN(a[0])) a = [120, 120, 130];
    return 'rgb(' + a.map(function (x, i) { return Math.round(x + (b[i] - x) * t); }).join(',') + ')';
  }
  function drawWrapped(g, text, cx, y, maxW, lineH, maxLines) {
    var words = String(text || '').split(/\s+/), line = '', n = 0;
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (g.measureText(test).width > maxW && line) {
        g.fillText(line, cx, y + n * lineH); n++; line = words[i];
        if (maxLines && n >= maxLines) { g.fillText(line.length > 3 ? line.slice(0, Math.max(1, line.length - 1)) + '…' : line, cx, y + (n - 1) * lineH); return n; }
      } else line = test;
    }
    if (line && (!maxLines || n < maxLines)) { g.fillText(line, cx, y + n * lineH); n++; }
    return n;
  }
  // Placeholder swatch for a concept until a real image model is connected.
  // Carries the concept's label + prompt so it's meaningful and swappable.
  function renderConceptImage(concept, accent, i) {
    var S = 768, c = document.createElement('canvas'); c.width = S; c.height = S; var g = c.getContext('2d');
    var mid = blend2(accent, '#000000', 0.25), dark = blend2(accent, '#000000', 0.62);
    var ang = i % 4;
    var grad = ang === 0 ? g.createLinearGradient(0, 0, S, S) : ang === 1 ? g.createLinearGradient(S, 0, 0, S) : ang === 2 ? g.createLinearGradient(0, 0, 0, S) : g.createLinearGradient(0, S, S, 0);
    grad.addColorStop(0, mid); grad.addColorStop(1, dark);
    g.fillStyle = grad; g.fillRect(0, 0, S, S);
    var rg = g.createRadialGradient(S * 0.5, S * 0.4, 0, S * 0.5, S * 0.4, S * 0.62);
    rg.addColorStop(0, blend2(accent, '#ffffff', 0.22)); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = 0.55; g.fillStyle = rg; g.fillRect(0, 0, S, S); g.globalAlpha = 1;
    g.textAlign = 'center';
    g.fillStyle = '#ffffff'; g.font = '600 46px -apple-system,"Segoe UI",Arial,sans-serif';
    drawWrapped(g, concept.label || 'Concept', S / 2, S * 0.28, S * 0.82, 54, 2);
    g.fillStyle = 'rgba(255,255,255,.86)'; g.font = '400 26px -apple-system,"Segoe UI",Arial,sans-serif';
    drawWrapped(g, concept.prompt || '', S / 2, S * 0.46, S * 0.82, 34, 6);
    g.fillStyle = 'rgba(255,255,255,.5)'; g.font = '600 19px -apple-system,"Segoe UI",Arial,sans-serif';
    g.fillText('✨ AI image concept — connect an image model to render', S / 2, S * 0.94);
    return c.toDataURL('image/jpeg', 0.82);
  }
  function setGenImgStatus(t) {
    var el = viewEl && viewEl.querySelector('#gi-status');
    if (el) el.innerHTML = t ? '<span class="spinner"></span> ' + esc(t) : '';
  }
  // shrink a (possibly large) generated image to a ≤1024px JPEG so a handful can
  // live inline in the store without blowing localStorage
  function compactImage(src) {
    return new Promise(function (resolve) {
      var im = new Image();
      im.onload = function () {
        var S = 1024, w = im.naturalWidth || S, h = im.naturalHeight || S, sc = Math.min(1, S / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        try { c.getContext('2d').drawImage(im, 0, 0, cw, ch); resolve(c.toDataURL('image/jpeg', 0.85)); }
        catch (e) { resolve(src); }
      };
      im.onerror = function () { resolve(src); };
      im.src = src;
    });
  }
  // Turn concepts into candidate images: real via Nano Banana when a Gemini key
  // is set, else labelled placeholder swatches. A per-image failure degrades to
  // a placeholder rather than losing the whole batch.
  function renderConcepts(concepts, refs, accent, stale) {
    return ai.geminiStatus().then(function (gs) {
      // No key, or a key Google is actively blocking → don't burn calls; make
      // concept previews and say EXACTLY why real photos didn't render.
      if (!(gs && gs.enabled) || gs.ok === false) {
        var why = (gs && gs.enabled && gs.ok === false)
          ? 'Google is blocking your Gemini key (' + (gs.error || 'restricted key') + ') — fix it in the panel above.'
          : 'Paste a Gemini key in the Generate images panel to render real photos.';
        gen.gemStatus = gs || { enabled: false }; refreshImagesPanel();
        Ads.toast('Showing concept previews — no real photos. ' + why, true);
        return concepts.map(function (c, i) { return { label: c.label, mode: c.mode, prompt: c.prompt, why: c.why, dataURL: renderConceptImage(c, accent, i), placeholder: true }; });
      }
      // ONE batch request → the server fires every Nano Banana call IN PARALLEL
      // and streams each image back as it lands, so N images take about as long
      // as the slowest single one. TEXT-ONLY on purpose: handing Nano Banana the
      // input images makes it EDIT them (near-variations of what you gave it) —
      // the brand's world lives in the concept prompts instead.
      var out = new Array(concepts.length), done = 0, fails = 0, firstErr = '';
      setGenImgStatus('Rendering all ' + concepts.length + ' images with Nano Banana at once…');
      return ai.genImages({
        prompts: concepts.map(function (c) { return c.prompt; }),
        onOne: function (d) {
          var c = concepts[d.i]; if (!c || out[d.i]) return;
          done++;
          if (d.ok && d.dataURL) out[d.i] = { label: c.label, mode: c.mode, prompt: c.prompt, why: c.why, dataURL: d.dataURL, placeholder: false };
          else { fails++; if (!firstErr) firstErr = d.error || 'failed'; out[d.i] = { label: c.label, mode: c.mode, prompt: c.prompt, why: c.why, dataURL: renderConceptImage(c, accent, d.i), placeholder: true }; }
          if (!stale()) setGenImgStatus('Rendering images with Nano Banana… ' + done + '/' + concepts.length + ' arrived');
        }
      }).then(function () {
        // any index the stream never answered for → placeholder, not a hole
        concepts.forEach(function (c, i) {
          if (!out[i]) { fails++; if (!firstErr) firstErr = 'no result came back'; out[i] = { label: c.label, mode: c.mode, prompt: c.prompt, why: c.why, dataURL: renderConceptImage(c, accent, i), placeholder: true }; }
        });
        // shrink the real renders so a batch can live inline in the store
        return Promise.all(out.map(function (o) {
          if (o.placeholder) return o;
          return compactImage(o.dataURL).then(function (durl) { o.dataURL = durl; return o; });
        }));
      }).then(function () {
        if (fails === concepts.length) { syncGemStatus(); throw new Error(firstErr || 'Every image failed to render'); }
        if (fails) Ads.toast(fails + ' of ' + concepts.length + ' image' + (fails === 1 ? '' : 's') + ' failed (' + firstErr + ') — shown as placeholders', true);
        return out;
      });
    });
  }
  function runGenImages() {
    if (!Ads._aiEnabled) { Ads.toast('Turn AI on (top-right) so it can design images from your project', true); return; }
    if (gen.genImgBusy) { Ads.toast('Image generation is already running', true); return; }
    var p = ensureProject(), pid = p.id;
    var run = ++gen.runSeq;   // a project switch (which bumps runSeq) invalidates this in-flight request
    function stale() { return gen.projectId !== pid || gen.runSeq !== run; }
    var count = Math.max(1, Math.min(25, gen.imgCount || 6));
    var refs = referenceImages();
    var accent = store.getBrand().accent || (gen.brief.site && gen.brief.site.themeColor) || '#ff7a3c';
    gen.genImgBusy = pid; refreshImagesPanel();
    setGenImgStatus('Art-directing image concepts from your project…');
    ai.imageConcepts({
      context: imageContext(), images: refs, count: count,
      brand: { name: (gen.brief.site && gen.brief.site.siteName) || store.getBrand().name }
    }).then(function (concepts) {
      if (stale()) return null;
      if (!concepts.length) throw new Error('No image concepts came back — try again');
      return renderConcepts(concepts, refs, accent, stale);   // stays busy through image rendering
    }).then(function (candidates) {
      if (stale() || !candidates) return;
      gen.genImgBusy = false; refreshImagesPanel();
      openConceptPicker(candidates, function (keepers) {
        if (!keepers.length) return;
        var proj = store.getProject(pid); if (!proj) return;
        // placeholder flag carries through: real Nano Banana images are false and
        // flow everywhere (incl. published landings); placeholders are true
        var stamped = keepers.map(function (k) { return { id: util.uid('gi'), label: k.label, mode: k.mode || '', prompt: k.prompt, why: k.why, dataURL: k.dataURL, placeholder: !!k.placeholder, createdAt: util.nowISO() }; });
        store.updateProject(pid, { genImages: (proj.genImages || []).concat(stamped) });
        if (gen.projectId === pid) refreshImagesPanel();
        var realN = keepers.filter(function (k) { return !k.placeholder; }).length;
        Ads.toast('Kept ' + keepers.length + ' image' + (keepers.length === 1 ? '' : 's') + (realN && realN < keepers.length ? ' (' + realN + ' real)' : '') + ' — they now feed every Generate');
      });
    }).catch(function (e) {
      if (stale()) return;
      gen.genImgBusy = false; refreshImagesPanel();
      Ads.toast('Could not generate images: ' + e.message, true);
    });
  }
  function openConceptPicker(candidates, onKeep) {
    var anyPlaceholder = candidates.some(function (c) { return c.placeholder; });
    var intro = anyPlaceholder
      ? 'The AI designed these for your project from your dossier, research and images. Click to keep or discard — kept ones stay in the project and feed every Generate. (These are placeholder swatches carrying real prompts — paste a Gemini key in the Generate images panel to render them as real photos.)'
      : 'Nano Banana generated these for your project from your dossier, research and reference images. Click to keep or discard — kept ones stay in the project and feed every Generate as input visuals.';
    var body = '<div class="fp-grid">' + candidates.map(function (c, i) {
      var tag = c.mode === 'fresh' ? ' · ✨ new idea' : (c.mode === 'world' ? ' · 🌍 brand world' : '');
      return '<div class="fp-item is-on" data-ci="' + i + '" title="' + esc(c.prompt || '') + '">' +
        '<img src="' + c.dataURL + '" alt=""><span class="fp-tick">✓</span>' +
        (c.label ? '<div class="gi-cap">' + esc(c.label) + tag + '</div>' : '') + '</div>';
    }).join('') + '</div>';
    Ads.modal({
      title: 'Keep the images you like', xwide: true,
      body: '<p class="u-muted" style="margin-bottom:1.2rem">' + esc(intro) + '</p>' + body +
        '<div class="hint" id="ci-count" style="margin-top:1rem"></div>',
      foot: [
        { label: 'Keep none', act: 'none', ghost: true },
        { label: 'Cancel', act: 'cancel', ghost: true },
        { label: 'Keep selected', act: 'keep', primary: true }
      ],
      onMount: function (m) {
        function upd() { var on = m.querySelectorAll('.fp-item.is-on').length; var c = m.querySelector('#ci-count'); if (c) c.textContent = on + ' of ' + candidates.length + ' will be kept'; }
        m.querySelectorAll('.fp-item').forEach(function (it) {
          it.addEventListener('click', function () { it.classList.toggle('is-on'); upd(); });
          it.addEventListener('dblclick', function () {   // double-click → see it full-size (leaves the keep/discard state as it was)
            var img = it.querySelector('img'); if (img && Ads.lightbox) Ads.lightbox(img.getAttribute('src'), it.getAttribute('title') || '');
          });
        });
        upd();
      },
      onAction: function (act, m) {
        if (act === 'cancel') return Ads.closeModal();
        if (act === 'none') { m.querySelectorAll('.fp-item').forEach(function (it) { it.classList.remove('is-on'); }); var cc = m.querySelector('#ci-count'); if (cc) cc.textContent = '0 of ' + candidates.length + ' will be kept'; return; }
        if (act !== 'keep') return;
        var keepers = []; m.querySelectorAll('.fp-item.is-on').forEach(function (it) { keepers.push(candidates[+it.getAttribute('data-ci')]); });
        Ads.closeModal(); onKeep(keepers);
      }
    });
  }
  function imagesPanel() {
    var kept = genImagesList();
    var busy = gen.genImgBusy && gen.genImgBusy === gen.projectId;
    var real = kept.filter(function (g) { return !g.placeholder; });
    var animatable = real.filter(function (g) { return !g.videoURL && !gen.animBusy[g.id]; });
    var gallery = kept.length
      ? '<div class="gi-grid">' + kept.map(function (g, i) {
          return '<div class="gi-item" title="' + esc(g.prompt || g.label || '') + '">' +
            '<img src="' + g.dataURL + '" alt="">' +
            '<button class="gi-del" data-gi-del="' + i + '" title="Discard this image">✕</button>' +
            (!g.placeholder && !g.videoURL && !gen.animBusy[g.id]
              ? '<button class="gi-anim" data-gi-anim="' + i + '" title="Animate into a real video clip with Veo (~$1–2, billed by Google, takes 1–3 min)">🎬</button>' : '') +
            (gen.animBusy[g.id] ? '<div class="gi-animating"><span class="spinner"></span> filming…</div>' : '') +
            (g.videoURL ? '<a class="gi-clipbadge" href="' + esc(g.videoURL) + '" target="_blank" title="Watch the raw clip">🎬 CLIP</a>' : '') +
            (g.label ? '<div class="gi-label">' + esc(g.label) + '</div>' : '') +
          '</div>';
        }).join('') + '</div>'
      : '<div class="dos-state is-empty">No generated images yet. Choose how many and press Generate — the AI studies your project, market research and images, then designs ad-ready visuals for you to keep.</div>';
    var controls =
      '<div class="gi-bar">' +
        '<label class="gi-count">How many <input type="range" id="gi-range" min="1" max="25" step="1" value="' + gen.imgCount + '"><b id="gi-num">' + gen.imgCount + '</b></label>' +
        '<div class="toolbar-spacer"></div>' +
        (animatable.length ? '<button class="btn is-ghost is-sm" id="gi-animhalf" title="Turn half of your kept images into real 8-second video clips (Veo, ~$1–2 each, billed by Google)">🎬 Animate half</button>' : '') +
        '<button class="btn is-sm" id="gi-go"' + (busy ? ' disabled' : '') + '><span class="btn-ico">' + icons().sparkle + '</span> ' + (busy ? 'Generating…' : 'Generate images') + '</button>' +
      '</div>' +
      '<div class="gh-status" id="gi-status">' + (busy ? '<span class="spinner"></span> Art-directing image concepts from your project…' : '') + '</div>';
    return '<section class="gen-dossier gen-images" id="gen-images">' +
      '<div class="dos-head"><h3>Generate relevant images</h3>' +
        '<span class="u-label">' + (kept.length ? kept.length + ' kept · fed into every Generate' : 'AI ad visuals → kept ones feed Generate') + '</span></div>' +
      controls + giKeyRow() + gallery +
      (kept.length ? '<div class="hint" style="margin-top:1rem"><strong>Double-click</strong> any image to see it full-size. Kept images become input visuals — press <strong>Generate ads</strong> and some ads are built on these.' +
        (kept.some(function (g) { return g.videoURL; }) ? ' Images marked <strong>🎬 CLIP</strong> play as real footage in about half of the video ads built on them.' : '') +
        (kept.some(function (g) { return g.placeholder; }) ? ' Some are placeholder swatches (add a Gemini key above for real photos).' : '') + '</div>' : '') +
    '</section>';
  }
  // Inline Nano Banana (Gemini) key affordance — the key lives right here where
  // you generate images (it's also in Brand Kit). gen.gemStatus is filled in
  // async by syncGemStatus(); we render nothing until it's known to avoid a flash.
  function giKeyRow() {
    var s = gen.gemStatus;
    if (s == null) return '';
    if (s.enabled && s.ok !== false) {
      return '<div class="gi-key is-on">' +
        '<span>✓ Real-photo rendering is <strong>on</strong> — Nano Banana (' + esc(s.model || 'gemini') + ')' +
          (s.source === 'saved' ? ', key saved on this computer' : (s.source === 'env' ? ', from environment' : '')) + '.</span>' +
        (s.source === 'saved' ? '<button class="btn is-ghost is-xs" id="gi-key-forget">Forget key</button>' : '') +
      '</div>';
    }
    if (s.enabled && s.ok === false) {
      // key is saved but Google is refusing it (almost always API restrictions)
      return '<div class="gi-key is-bad">' +
        '<div class="gi-key-msg"><strong>⚠ Google is blocking this key.</strong> ' + esc(s.error || 'The key can’t call the Gemini API.') +
          '<br>This is a restriction on the key itself, not Ads Hub. Fastest fix: at <span class="gi-key-url">aistudio.google.com/apikey</span> click <strong>Create API key</strong> and choose <strong>“in a new project”</strong> — that key is unrestricted. ' +
          '(If you made the key in Google Cloud Console, open the key and set <em>API restrictions</em> → “Don’t restrict key” and <em>Application restrictions</em> → “None”.) Then paste the working key below.</div>' +
        '<div class="gi-key-row">' +
          '<input class="input" type="password" id="gi-key" placeholder="AIza… paste a working key" autocomplete="off" spellcheck="false">' +
          '<button class="btn is-sm is-primary" id="gi-key-save">Save & re-check</button>' +
          '<button class="btn is-ghost is-sm" id="gi-key-recheck">Re-check current key</button>' +
        '</div>' +
      '</div>';
    }
    return '<div class="gi-key is-off">' +
      '<div class="gi-key-msg"><strong>Want real photos instead of concept swatches?</strong> Paste a Google <strong>Gemini</strong> API key — Nano Banana then renders real, ad-ready images. It’s saved on this computer (never in the repo). Free key at <span class="gi-key-url">aistudio.google.com/apikey</span> (choose “in a new project” so it’s unrestricted). Billed by Google (~$0.04/image).</div>' +
      '<div class="gi-key-row">' +
        '<input class="input" type="password" id="gi-key" placeholder="AIza… paste your Gemini key" autocomplete="off" spellcheck="false">' +
        '<button class="btn is-sm is-primary" id="gi-key-save">Save key</button>' +
      '</div>' +
    '</div>';
  }
  // Fetch the current Nano Banana status and, if it changed, re-render the panel.
  function syncGemStatus() {
    ai.geminiStatus().then(function (s) {
      var prev = gen.gemStatus, next = s || { enabled: false };
      var changed = !prev || !!prev.enabled !== !!next.enabled || prev.model !== next.model ||
        prev.source !== next.source || (prev.ok !== false) !== (next.ok !== false) || prev.error !== next.error;
      gen.gemStatus = next;
      if (changed) refreshImagesPanel();
    }).catch(function () {
      if (gen.gemStatus == null) { gen.gemStatus = { enabled: false }; refreshImagesPanel(); }
    });
  }
  function bindImages(el) {
    var range = el.querySelector('#gi-range');
    if (range) range.addEventListener('input', function () { gen.imgCount = +range.value; var n = el.querySelector('#gi-num'); if (n) n.textContent = range.value; });
    var go = el.querySelector('#gi-go');
    if (go) go.addEventListener('click', runGenImages);
    var keySave = el.querySelector('#gi-key-save');
    if (keySave) keySave.addEventListener('click', function () {
      var inp = el.querySelector('#gi-key'); var k = inp ? inp.value.trim() : '';
      if (!k) { Ads.toast('Paste a Google Gemini API key first', true); return; }
      var lbl = keySave.textContent; keySave.disabled = true; keySave.textContent = 'Checking…';
      ai.setGeminiKey(k).then(function (resp) {
        gen.gemStatus = null;
        if (resp && (resp.ok === false || resp.verified === false)) {
          Ads.toast('Key saved, but Google is blocking it: ' + (resp.error || 'restricted key') + '. See the panel for how to fix it.', true);
        } else {
          Ads.toast('Nano Banana key saved and verified — real-photo rendering is on');
        }
        syncGemStatus();   // re-fetch → the row flips to the ✓ / blocked state
      }).catch(function (e) {
        Ads.toast(e && e.message ? e.message : 'Could not save the key', true);
        keySave.disabled = false; keySave.textContent = lbl;
      });
    });
    var keyRecheck = el.querySelector('#gi-key-recheck');
    if (keyRecheck) keyRecheck.addEventListener('click', function () {
      keyRecheck.disabled = true; keyRecheck.textContent = 'Checking…';
      ai.geminiVerify().then(function (r) {
        gen.gemStatus = null;
        Ads.toast(r && r.ok ? 'Key works now — real-photo rendering is on' : ('Still blocked: ' + ((r && r.error) || 'restricted key')), !(r && r.ok));
        syncGemStatus();
      }).catch(function () { keyRecheck.disabled = false; keyRecheck.textContent = 'Re-check current key'; });
    });
    var keyForget = el.querySelector('#gi-key-forget');
    if (keyForget) keyForget.addEventListener('click', function () {
      Ads.confirm ? Ads.confirm({
        title: 'Forget the Nano Banana key?', message: 'Image generation falls back to concept swatches until you paste a key again.',
        danger: true, okLabel: 'Forget key',
        onConfirm: function () { ai.setGeminiKey('').then(function () { Ads.toast('Nano Banana key forgotten'); gen.gemStatus = null; syncGemStatus(); }); }
      }) : ai.setGeminiKey('').then(function () { Ads.toast('Nano Banana key forgotten'); gen.gemStatus = null; syncGemStatus(); });
    });
    el.querySelectorAll('[data-gi-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = +b.getAttribute('data-gi-del'); var p = currentProject(); if (!p) return;
        var next = (p.genImages || []).slice(); next.splice(i, 1);
        store.updateProject(p.id, { genImages: next });
        refreshImagesPanel();
      });
    });
    // 🎬 animate ONE image into real footage
    el.querySelectorAll('[data-gi-anim]').forEach(function (b) {
      b.addEventListener('click', function () {
        var g = genImagesList()[+b.getAttribute('data-gi-anim')];
        if (g) animateImages([g.id]);
      });
    });
    // 🎬 bulk: bring the project to "half the kept images have real clips"
    var animHalf = el.querySelector('#gi-animhalf');
    if (animHalf) animHalf.addEventListener('click', function () {
      var real = genImagesList().filter(function (g) { return !g.placeholder; });
      var animated = real.filter(function (g) { return g.videoURL; }).length;
      var want = Math.max(0, Math.ceil(real.length / 2) - animated);
      var targets = real.filter(function (g) { return !g.videoURL && !gen.animBusy[g.id]; }).slice(0, want);
      if (!targets.length) { Ads.toast('Half of your images already have clips'); return; }
      Ads.confirm({
        title: 'Animate ' + targets.length + ' image' + (targets.length > 1 ? 's' : '') + ' into real clips?',
        message: 'Veo films each one into an 8-second vertical clip that plays as real footage in your video ads. Roughly $1–2 per clip, billed by Google to your Gemini key. Takes a few minutes — you can keep working.',
        okLabel: 'Animate',
        onConfirm: function () { animateImages(targets.map(function (g) { return g.id; })); }
      });
    });
    // double-click a kept image → open it full-size
    el.querySelectorAll('.gi-item').forEach(function (it) {
      it.addEventListener('dblclick', function (e) {
        if (e.target.closest && e.target.closest('.gi-del,.gi-anim')) return;   // not when double-clicking a control
        var img = it.querySelector('img'); if (!img || !Ads.lightbox) return;
        Ads.lightbox(img.getAttribute('src'), it.getAttribute('title') || '');
      });
    });
  }
  function refreshImagesPanel() {
    var elp = viewEl && viewEl.querySelector('#gen-images');
    if (!elp) return;
    var tmp = document.createElement('div'); tmp.innerHTML = imagesPanel();
    elp.replaceWith(tmp.firstChild);
    bindImages(viewEl);
  }
  // Veo-animate kept AI images into real footage, ≤2 filming at once. Success
  // pins a durable /pfiles clip URL onto the project's genImage entry; video
  // ads built on that image then alternate between live footage and designed
  // motion. Failures toast per-image and never block the others.
  function animateImages(ids) {
    var p = ensureProject(), pid = p.id;
    var byId = {};
    genImagesList().forEach(function (g) { byId[g.id] = g; });
    var targets = ids.map(function (id) { return byId[id]; })
      .filter(function (g) { return g && !g.placeholder && !g.videoURL && !gen.animBusy[g.id]; });
    if (!targets.length) return;
    targets.forEach(function (g) { gen.animBusy[g.id] = true; });
    refreshImagesPanel();
    Ads.toast('Filming ' + targets.length + ' clip' + (targets.length > 1 ? 's' : '') + ' with Veo — 1–3 min each, billed by Google');
    var queue = targets.slice(), active = 0, CONC = 2, doneN = 0, fails = 0;
    function pump() {
      if (!queue.length && !active) {
        if (gen.projectId === pid) refreshImagesPanel();
        if (doneN) Ads.toast(doneN + ' clip' + (doneN > 1 ? 's' : '') + ' ready — video ads built on these images now use real footage' + (fails ? ' (' + fails + ' failed)' : ''), false);
        return;
      }
      while (active < CONC && queue.length) {
        (function (g) {
          active++;
          ai.genClip({ project: pid, prompt: g.prompt || g.label || '', image: g.dataURL }).then(function (resp) {
            var proj = store.getProject(pid);
            if (proj && resp && resp.url) {
              var next = (proj.genImages || []).map(function (x) { return x.id === g.id ? Object.assign({}, x, { videoURL: resp.url }) : x; });
              store.updateProject(pid, { genImages: next });
              doneN++;
            }
          }).catch(function (e) {
            fails++;
            Ads.toast('Could not animate “' + (g.label || 'image') + '”: ' + (e && e.message || 'failed'), true);
          }).then(function () {
            delete gen.animBusy[g.id]; active--;
            if (gen.projectId === pid) refreshImagesPanel();
            pump();
          });
        })(queue.shift());
      }
    }
    pump();
  }
  /* ---- Analyze best target audience -------------------------------------
     Assembles EVERYTHING the project knows — dossier, market research, brief
     text/documents, the website, video transcripts, generated imagery, every
     saved ad — hands it to the AI with live web search, and renders WHO the
     ads should target: segments, demographics, regions, platforms + a
     Meta-ready targeting spec. Persisted on the project.                    */
  function audienceContext() {
    var parts = [];
    var d = currentDossier();
    if (d && d.sections) {
      var s = d.sections;
      var dos = [];
      if (s.summary) dos.push(s.summary);
      if (s.product) dos.push('The product: ' + s.product);
      if (s.audience) dos.push('Audience notes so far: ' + s.audience);
      if (Array.isArray(s.benefits) && s.benefits.length) dos.push('Benefits: ' + s.benefits.join('; '));
      if (Array.isArray(s.features) && s.features.length) dos.push('Features: ' + s.features.join('; '));
      if (Array.isArray(s.proof) && s.proof.length) dos.push('Proof: ' + s.proof.join(' | '));
      if (Array.isArray(s.objections) && s.objections.length) dos.push('Objections people raise: ' + s.objections.join(' | '));
      if (s.tone) dos.push('Tone: ' + s.tone);
      if (Array.isArray(s.keywords) && s.keywords.length) dos.push('Keywords: ' + s.keywords.join(', '));
      parts.push('== PROJECT UNDERSTANDING (deep-read dossier) ==\n' + dos.join('\n'));
    }
    var r = currentResearch();
    if (r) {
      var pains = (r.painPoints || []).map(function (x) {
        return '- ' + (x.pain || '') + (x.who ? ' | felt by: ' + x.who : '') + (x.quote ? ' | in their words: "' + x.quote + '"' : '');
      }).join('\n');
      parts.push('== MARKET RESEARCH (real pain points) ==\n' + (r.summary ? r.summary + '\n' : '') + pains);
    }
    var site = gen.brief.site;
    if (site) {
      parts.push('== THE WEBSITE ==\n' + (site.siteName ? site.siteName + ' — ' : '') + (site.description || '') +
        (site.text ? '\nSite copy:\n' + String(site.text).slice(0, 6000) : ''));
    }
    if (gen.brief.text) parts.push('== ADVERTISER NOTES ==\n' + String(gen.brief.text).slice(0, 2500));
    var files = (gen.brief.files || []).slice(0, 6).map(function (f) {
      return '--- ' + (f.name || 'document') + ' ---\n' + String(f.text || '').slice(0, 1500);
    });
    if (files.length) parts.push('== DOCUMENTS ==\n' + files.join('\n'));
    var trans = (gen.brief.videos || []).map(function (v) { return v.transcript; }).filter(Boolean);
    if (trans.length) parts.push('== VIDEO TRANSCRIPT (what the brand film says) ==\n' + String(trans.join('\n')).slice(0, 2500));
    var gi = genImagesList().filter(function (g) { return !g.placeholder; });
    if (gi.length) {
      parts.push('== AD IMAGERY WE GENERATED (what our visuals portray) ==\n' +
        gi.slice(0, 25).map(function (g) { return '- ' + (g.label || '') + ': ' + String(g.prompt || '').slice(0, 180); }).join('\n'));
    }
    var p = currentProject();
    var saved = (p && p.savedAds) || [];
    if (saved.length) {
      parts.push('== EVERY SAVED AD (the ads that will actually run — match segments to these angles) ==\n' +
        saved.slice(0, 60).map(function (a2) {
          return '- [' + (a2.kind === 'video' ? 'video' : 'post') + '] angle: ' + (a2.angle || '—') +
            ' | headline: ' + (((a2.headlineStart || '') + ' ' + (a2.headlineHighlight || '')).trim() || '—') +
            (a2.caption ? ' | caption: ' + String(a2.caption).slice(0, 110) : '');
        }).join('\n'));
    }
    return parts.join('\n\n').slice(0, 41000);
  }
  function audChips(label, list) {
    if (!list || !list.length) return '';
    return '<div class="aud-chiprow"><span class="aud-chiplabel">' + esc(label) + '</span>' +
      list.map(function (x) { return '<span class="aud-chip">' + esc(x) + '</span>'; }).join('') + '</div>';
  }
  function audienceSegCard(s, isPrimary) {
    return '<div class="aud-card' + (isPrimary ? ' is-primary' : '') + '">' +
      '<div class="aud-cardhead">' +
        (isPrimary ? '<span class="aud-star">★ BEST TARGET</span>' : '<span class="aud-pri">#' + s.priority + '</span>') +
        '<h4>' + esc(s.name || 'Segment') + '</h4>' +
      '</div>' +
      '<p class="aud-who">' + esc(s.who || '') + '</p>' +
      '<div class="aud-facts">' +
        (s.age ? '<span class="aud-fact"><b>Age</b> ' + esc(s.age) + '</span>' : '') +
        (s.gender ? '<span class="aud-fact"><b>Gender</b> ' + esc(s.gender) + '</span>' : '') +
        (s.income ? '<span class="aud-fact"><b>Income</b> ' + esc(s.income) + '</span>' : '') +
      '</div>' +
      audChips('Regions', s.regions) +
      audChips('Platforms', s.platforms) +
      (s.why ? '<p class="aud-why">' + esc(s.why) + '</p>' : '') +
      (s.adAngles && s.adAngles.length ? '<div class="aud-angles"><b>Your ads that fit:</b> ' + s.adAngles.map(esc).join(' · ') + '</div>' : '') +
      (s.evidence ? '<div class="aud-evidence">' + esc(s.evidence) + '</div>' : '') +
    '</div>';
  }
  function audiencePanel() {
    var p = currentProject();
    var a = p && p.audience;
    var busy = gen.audienceBusy && gen.audienceBusy === gen.projectId;
    var body;
    if (busy) {
      body = '<div class="gh-status" id="aud-status"><span class="spinner"></span> Reading everything on the project, then researching the live market — this takes a few minutes…</div>';
    } else if (a && a.data) {
      var d = a.data, t = d.targeting || {};
      body =
        '<p class="aud-summary">' + esc(d.summary || '') + '</p>' +
        '<div class="aud-grid">' +
          (d.primary && d.primary.name ? audienceSegCard(d.primary, true) : '') +
          (d.segments || []).filter(function (s) { return !d.primary || s.name !== d.primary.name; }).map(function (s) { return audienceSegCard(s, false); }).join('') +
        '</div>' +
        '<div class="aud-targeting">' +
          '<div class="u-label" style="margin-bottom:0.8rem">Ready-to-use targeting (Meta Ads Manager)</div>' +
          '<div class="aud-facts">' +
            (t.ageRange ? '<span class="aud-fact"><b>Age</b> ' + esc(t.ageRange) + '</span>' : '') +
            (t.genders ? '<span class="aud-fact"><b>Gender</b> ' + esc(t.genders) + '</span>' : '') +
          '</div>' +
          audChips('Locations', t.locations) +
          audChips('Interests', t.interests) +
          audChips('Placements', t.placements) +
          (t.budgetSplit ? '<p class="aud-why"><b>Budget split:</b> ' + esc(t.budgetSplit) + '</p>' : '') +
          (t.notes ? '<p class="aud-why">' + esc(t.notes) + '</p>' : '') +
          (d.avoid ? '<p class="aud-avoid"><b>Don’t spend on:</b> ' + esc(d.avoid) + '</p>' : '') +
        '</div>' +
        '<div class="dos-foot"><span class="u-faint">Analyzed ' + esc(String(a.at || '').slice(0, 10)) + (a.webSearch ? ' · grounded in live web research' : ' · model knowledge (no web search)') + '</span>' +
          '<button class="btn is-ghost is-sm" id="aud-go">Re-analyze</button></div>';
    } else {
      body =
        '<div class="dos-state is-empty">The AI reads <strong>everything</strong> — your project understanding, market research, website, documents, video transcript, generated imagery and every saved ad — then researches the live market to tell you exactly <strong>who to advertise to</strong>: age, gender, regions and platforms, with ready-to-use Meta targeting.</div>' +
        '<div class="gi-bar" style="margin-top:1.2rem"><div class="toolbar-spacer"></div>' +
          '<button class="btn is-sm is-primary" id="aud-go"><span class="btn-ico">' + icons().sparkle + '</span> Analyze best target audience</button></div>' +
        '<div class="gh-status" id="aud-status"></div>';
    }
    return '<section class="gen-dossier gen-audience" id="gen-audience">' +
      '<div class="dos-head"><h3>Analyze best target audience</h3>' +
        '<span class="u-label">' + ((a && a.data) ? 'who to put these ads in front of' : 'the step before you spend a dollar') + '</span></div>' +
      body + '</section>';
  }
  function refreshAudiencePanel() {
    var elp = viewEl && viewEl.querySelector('#gen-audience');
    if (!elp) return;
    var tmp = document.createElement('div'); tmp.innerHTML = audiencePanel();
    elp.replaceWith(tmp.firstChild);
    bindAudience(viewEl);
  }
  function bindAudience(el) {
    var go = el.querySelector('#aud-go');
    if (go) go.addEventListener('click', runAudience);
  }
  function runAudience() {
    if (!Ads._aiEnabled) { Ads.toast('Turn AI on (top-right) so it can analyze the project', true); return; }
    if (gen.audienceBusy) { Ads.toast('The analysis is already running', true); return; }
    var p = ensureProject(), pid = p.id;
    var ctx = audienceContext();
    if (ctx.length < 400) { Ads.toast('Not enough material yet — add a website, notes or run the dossier first', true); return; }
    gen.audienceBusy = pid; refreshAudiencePanel();
    // NOTE: no runSeq guard here — this call runs for MINUTES and the user may
    // legitimately generate ads/images while waiting. The flag always clears,
    // the pid-keyed result always persists; only the UI refresh checks whether
    // this project is still on screen. (Same pattern as runResearch.)
    ai.audience({ context: ctx, brand: (gen.brief.site && gen.brief.site.siteName) || store.getBrand().name })
      .then(function (resp) {
        if (gen.audienceBusy === pid) gen.audienceBusy = false;
        store.updateProject(pid, { audience: { at: util.nowISO(), webSearch: resp.webSearch, data: resp.audience } });
        if (gen.projectId === pid) {
          refreshAudiencePanel();
          Ads.toast('Audience analysis ready — your best target is “' + ((resp.audience.primary && resp.audience.primary.name) || 'see below') + '”');
        }
      })
      .catch(function (e) {
        if (gen.audienceBusy === pid) gen.audienceBusy = false;
        if (gen.projectId === pid) {
          refreshAudiencePanel();
          Ads.toast('Audience analysis failed: ' + (e && e.message || 'unknown'), true);
        }
      });
  }

  // selected pain points → copy variations for the no-AI fallback path
  function researchFallbackCopies(list) {
    var dom = briefLib.domain(gen.brief);
    return list.map(function (r, i) {
      var h = (r.headline || r.hook || '').replace(/[.!]$/, '');
      var words = h.split(/\s+/), cut = Math.ceil(words.length * 0.55);
      var caption = ((r.hook || h) + ' ' + (r.description || '')).trim();
      if (caption.length > 200) caption = caption.slice(0, 198).replace(/\s+\S*$/, '') + '…';
      return {
        angle: 'Pain point: ' + (r.pain || '').slice(0, 40), source: 'research',
        badge: '', headlineStart: words.slice(0, cut).join(' '), headlineHighlight: words.slice(cut).join(' '),
        subtext: r.tagline || '', boldPhrases: [], cta: 'Learn more',
        caption: caption + (dom ? ' → ' + dom : ''), description: (r.tagline || '').slice(0, 30)
      };
    });
  }

  /* ---- frame picker: choose which video frames may appear in ads --------- */
  // opts.thenGenerate → the primary button continues into generation
  function openFramePicker(opts) {
    opts = opts || {};
    var vids = gen.brief.videos.filter(function (v) { return (v.frames || []).length; });
    if (!vids.length) { Ads.toast('No video frames yet — add a video first', true); return; }
    var body = vids.map(function (v, vi) {
      var sel = v.frameSel || null;
      return '<div class="fp-video">' +
        (vids.length > 1 ? '<div class="u-label" style="margin-bottom:0.8rem">' + esc(v.name || ('video ' + (vi + 1))) + '</div>' : '') +
        '<div class="fp-grid">' +
        v.frames.map(function (f, fi) {
          var on = sel ? sel.indexOf(fi) >= 0 : true;
          return '<div class="fp-item' + (on ? ' is-on' : '') + '" data-fp="' + vi + ':' + fi + '" title="Click to include / exclude">' +
            '<img src="' + f + '" alt=""><span class="fp-tick">✓</span></div>';
        }).join('') +
        '</div></div>';
    }).join('');
    Ads.modal({
      title: 'Which video frames can the ads use?', xwide: true,
      body: '<p class="u-muted" style="margin-bottom:1.4rem">These frames were sampled across your video. Ads built on video visuals will only use the ones you keep selected — the rest are ignored (the AI still studies all of them for understanding).</p>' + body +
        '<div class="hint" id="fp-count" style="margin-top:1.2rem"></div>',
      foot: [
        { label: 'Select all', act: 'all', ghost: true },
        { label: 'Cancel', act: 'cancel', ghost: true },
        { label: opts.thenGenerate ? 'Save & generate' : 'Save selection', act: 'save', primary: true }
      ],
      onMount: function (m) {
        function updateCount() {
          var on = m.querySelectorAll('.fp-item.is-on').length, total = m.querySelectorAll('.fp-item').length;
          var c = m.querySelector('#fp-count');
          if (c) c.textContent = on + ' of ' + total + ' frames will be used in ads' + (on === 0 ? ' — none selected: ads will use other images instead' : '');
        }
        m.querySelectorAll('.fp-item').forEach(function (it) {
          it.addEventListener('click', function () { it.classList.toggle('is-on'); updateCount(); });
        });
        updateCount();
      },
      onAction: function (act, m) {
        if (act === 'cancel') return Ads.closeModal();
        if (act === 'all') { m.querySelectorAll('.fp-item').forEach(function (it) { it.classList.add('is-on'); }); m.querySelector('#fp-count').textContent = m.querySelectorAll('.fp-item').length + ' of ' + m.querySelectorAll('.fp-item').length + ' frames will be used in ads'; return; }
        if (act !== 'save') return;
        // persist per-video selections
        vids.forEach(function (v, vi) {
          var picked = [];
          m.querySelectorAll('.fp-item.is-on').forEach(function (it) {
            var parts = it.getAttribute('data-fp').split(':');
            if (+parts[0] === vi) picked.push(+parts[1]);
          });
          v.frameSel = picked;
        });
        ensureProject(); saveProject();
        Ads.closeModal();
        var kept = vids.reduce(function (s, v) { return s + v.frameSel.length; }, 0);
        Ads.toast(kept + ' frame' + (kept === 1 ? '' : 's') + ' approved for ads');
        if (opts.thenGenerate) generate(true);
      }
    });
  }

  // Videos saved before frames/transcription existed contribute almost
  // nothing to the dossier — process them retroactively when a project opens.
  function backfillVideos() {
    var pid = gen.projectId; if (!pid) return;
    gen.brief.videos.forEach(function (v) {
      if (!durableUrl(v.url) || v._backfilling) return;
      var needFrames = !(v.frames && v.frames.length) && !v.framesTried;
      var needTranscript = !v.transcript && !v.transcriptTried;
      if (!needFrames && !needTranscript) return;
      v._backfilling = true;
      var storedName = decodeURIComponent(v.url.split('/').pop());
      var step = Promise.resolve();
      if (needFrames && Ads.clips) {
        step = Ads.clips.frames(v.url, { count: 30 }).then(function (fr) {
          v.frames = (fr && fr.frames) || []; v.framesTried = true;
          if (!v.frames.length && gen.projectId === pid) {
            Ads.toast('"' + (v.name || 'video') + '" can\'t be read (' + ((fr && fr.reason) || 'no frames') + ') — the stored file may be broken. Remove it and re-upload.', true);
          }
          if (gen.projectId === pid) renderSources();
        }).catch(function () { v.framesTried = true; });
      }
      step.then(function () {
        v._backfilling = false;
        if (needTranscript) { v.transcriptTried = true; transcribeVideo(pid, v, storedName); }
        if (gen.projectId === pid) saveProject();
      });
    });
  }

  // Transcribe a stored project video through the LOCAL transcribe-hub
  // (whisper on this machine — nothing leaves it). Background: kicks the job,
  // polls, saves the transcript onto the video + project when it lands.
  function transcribeVideo(pid, v, storedName) {
    v.transcribing = true; renderSources();
    fetch('/api/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ project: pid, name: storedName })
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'transcription unavailable'); return j.jobId; });
    }).then(function (jobId) {
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function poll() {
          if (tries++ > 150) return reject(new Error('transcription timed out'));   // ~10 min
          fetch('/api/transcribe/status?job=' + encodeURIComponent(jobId))
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (j.error) return reject(new Error(j.message || 'transcription failed'));
              if (j.ready) return resolve(j.text || '');
              setTimeout(poll, 4000);
            }).catch(reject);
        })();
      });
    }).then(function (text) {
      v.transcribing = false;
      v.transcript = String(text || '').trim().slice(0, 20000);
      if (gen.projectId === pid) {
        renderSources(); saveProject();
        if (v.transcript) Ads.toast('Transcript ready — the next Generate re-reads the project with it');
      } else {
        // user moved on: still persist onto the owning project
        var proj = store.getProject(pid);
        if (proj) {
          var pv = (proj.brief.videos || []).filter(function (x) { return x.name === v.name; })[0];
          if (pv) { pv.transcript = v.transcript; store.updateProject(pid, { brief: proj.brief }); }
        }
      }
    }).catch(function (e) {
      v.transcribing = false;
      if (gen.projectId === pid) { renderSources(); Ads.toast('No transcript: ' + e.message, true); }
    });
  }

  // store an uploaded file on the server under this project → served URL
  function uploadProjectFile(projectId, file) {
    return fetch('/api/upload?project=' + encodeURIComponent(projectId) + '&name=' + encodeURIComponent(file.name || 'file'), {
      method: 'POST', headers: { 'X-Ads-Hub': '1' }, body: file
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.url) || null; })
      .catch(function () { return null; });
  }
  var liveControllers = [];   // running video loops in the grid, stopped on re-render
  function stopControllers() { liveControllers.forEach(function (c) { try { c.stop(); } catch (e) {} }); liveControllers = []; }
  var VIDEO_MOTIONS = ['showcase', 'kinetic', 'reveal'];
  // kind for variation i under the current mix (both = every 3rd is video → 2:1)
  function kindFor(i) { return gen.mix === 'video' ? 'video' : (gen.mix === 'posts' ? 'post' : (i % 3 === 2 ? 'video' : 'post')); }

  /* ---- video "DNA": per-ad motion/grade/type variety so no two look alike -- */
  var TYPE_MOTIONS = ['lines', 'words', 'punch', 'sweep'];   // headline reveal
  var BG_MOVES = ['drift', 'pushIn', 'pushOut', 'panL', 'panR']; // camera move
  var GRADES = ['none', 'duotone', 'warm', 'noir', 'vivid'];  // colour grade
  var ACCENT_SETS = [[], ['progress'], ['underline'], ['ticks'], ['progress', 'underline']];
  function hashStr(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  // pick a coherent-but-unique DNA per video ad; `seen` de-dups the batch,
  // `scores` biases toward liked / away from disliked treatments.
  // Ads with REAL visuals (footage or an image) never get identity-erasing
  // grades — duotone/noir on dark footage reads as a plain colour wash.
  function videoDNA(i, motion, seen, scores, realVisual) {
    var gradeBase = realVisual ? ['none', 'none', 'warm', 'vivid'] : GRADES;
    var tmP = weightPool(TYPE_MOTIONS, 'typeMotion', scores || {});
    var bmP = weightPool(BG_MOVES, 'bgMove', scores || {});
    var grP = weightPool(gradeBase, 'grade', scores || {});
    var seed = hashStr('v' + i + '|' + (gen.brief.url || '') + '|' + motion);
    var tm = tmP[seed % tmP.length];
    var bm = bmP[(seed >> 3) % bmP.length];
    var gr = grP[(seed >> 6) % grP.length];
    var acc = ACCENT_SETS[(seed >> 9) % ACCENT_SETS.length];
    // nudge within the ALLOWED grade set only — the de-dup walk must not
    // reintroduce excluded grades onto real visuals
    var gradeUniq = gradeBase.filter(function (x, gi, a) { return a.indexOf(x) === gi; });
    var guard = 0, key;
    do {
      key = tm + '|' + bm + '|' + gr;
      if (seen[key]) { gr = gradeUniq[(gradeUniq.indexOf(gr) + 1) % gradeUniq.length]; if (++guard % gradeUniq.length === 0) bm = BG_MOVES[(BG_MOVES.indexOf(bm) + 1) % BG_MOVES.length]; }
    } while (seen[key] && guard < gradeUniq.length * BG_MOVES.length);
    seen[key] = 1;
    return { typeMotion: tm, bgMove: bm, grade: gr, accents: acc, accentMode: ((seed >> 12) & 1) ? 'harmonize' : 'brand' };
  }

  /* ===================== DNA: diverse variation builder ================== */
  var BGS = ['midnight', 'gradient-blue', 'solid-light', 'gradient-purple', 'solid-dark', 'gradient-sunset', 'mesh', 'gradient-emerald', 'dots'];
  var PALETTE = ['#ff7a3c', '#0ea5e9', '#9b6dff', '#39d4a6', '#ff5d8f', '#ffd166'];
  var LAYOUTS = {
    phone: ['auto', 'top'],
    feature: ['auto', 'left'],
    'plain-image': ['auto', 'bottom'],
    overlay: ['bottom', 'center', 'top'],
    statement: ['auto'], comparison: ['auto'], stat: ['auto'], quote: ['auto']
  };
  var DENSITIES = ['standard', 'minimal', 'rich'];
  var FORMATS_BIAS = ['square', 'square', 'portrait']; // feed favours 1:1 with 4:5 mixed in

  /* ---- preference learning ---------------------------------------------- */
  // per-attribute score = (# liked with this value) − (# disliked with this value)
  function prefScores() {
    var p = store.getPrefs(), s = {};
    function add(sig, sign) {
      ['template', 'background', 'accent', 'density', 'layout', 'motion', 'font', 'kind', 'typeMotion', 'bgMove', 'grade', 'format'].forEach(function (k) {
        if (sig[k] == null || sig[k] === '') return;
        (s[k] = s[k] || {})[sig[k]] = (s[k][sig[k]] || 0) + sign;
      });
    }
    (p.liked || []).forEach(function (sig) { add(sig, 1); });
    (p.disliked || []).forEach(function (sig) { add(sig, -1); });
    return s;
  }
  // expand a value list, repeating liked values more and disliked ones less;
  // a value at net −2 or worse is dropped from the pool entirely
  function weightPool(vals, attr, scores) {
    if (!scores[attr]) return vals.slice();
    var out = [];
    vals.forEach(function (v) {
      var w = Math.max(0, Math.min(12, 3 + 2 * ((scores[attr][v]) || 0)));
      for (var i = 0; i < w; i++) out.push(v);
    });
    return out.length ? out : vals.slice();
  }
  // compact liked/disliked examples for the AI copywriter
  function prefsForAI() {
    var p = store.getPrefs();
    function slim(arr) { return arr.slice(-12).map(function (s) { return { headline: s.headline, angle: s.angle }; }); }
    return { liked: slim(p.liked || []), disliked: slim(p.disliked || []) };
  }
  var PREF_ATTR_WORD = { background: 'bg', typeMotion: 'text motion', bgMove: 'camera', template: 'layout' };
  function prefLabel(attr, val) {
    if (attr === 'kind') return val === 'video' ? 'video ads' : 'image ads';
    return String(val).replace(/^gradient-/, '').replace(/-/g, ' ') + ' ' + (PREF_ATTR_WORD[attr] || attr);
  }
  function learnNote() {
    var p = store.getPrefs(), l = (p.liked || []).length, d = (p.disliked || []).length;
    if (!l && !d) return 'Like the good ones and dislike the rest — the next batch learns from your taste.';
    var s = prefScores(), into = [], avoid = [];
    // only attributes the generator actually biases via weightPool are shown:
    // 'kind' is the user's own posts/video toggle and 'font' is a Brand Kit
    // setting — claiming to learn those would be a lie
    ['template', 'background', 'grade', 'typeMotion', 'bgMove', 'density', 'format', 'accent'].forEach(function (attr) {
      if (!s[attr]) return;
      Object.keys(s[attr]).forEach(function (val) {
        var sc = s[attr][val];
        if (sc >= 2) into.push({ t: prefLabel(attr, val), sc: sc });
        else if (sc <= -2) avoid.push({ t: prefLabel(attr, val), sc: sc });
      });
    });
    into.sort(function (a, b) { return b.sc - a.sc; }); avoid.sort(function (a, b) { return a.sc - b.sc; });
    var note = 'Learning from ' + l + ' liked · ' + d + ' disliked.';
    if (into.length) note += ' Leaning into ' + into.slice(0, 3).map(function (x) { return x.t; }).join(', ') + '.';
    if (avoid.length) note += ' Dropping ' + avoid.slice(0, 3).map(function (x) { return x.t; }).join(', ') + '.';
    if (!into.length && !avoid.length) note += ' Verdicts stack — like or dislike the same style twice and the next batch shifts hard.';
    return note;
  }

  function accentPool() {
    var b = store.getBrand();
    var list = [];
    if (gen.brief.site && /^#[0-9a-f]{6}$/i.test(gen.brief.site.themeColor || '')) list.push(gen.brief.site.themeColor);
    if (b.accent) list.push(b.accent);
    PALETTE.forEach(function (c) { if (list.indexOf(c) < 0) list.push(c); });
    return list;
  }
  function imagePool() {
    var pool = (gen.brief.images || []).slice();
    var site = gen.brief.site;
    if (site && site.images && site.images.length) pool = pool.concat(site.images);
    else if (site && site.ogImage) pool.push(site.ogImage);
    // video frames are usable stills too — but ONLY the ones the user picked
    // (framesOf honors v.frameSel). The auto-poster joins the pool only when
    // the user hasn't curated; a curated selection is respected exactly.
    (gen.brief.videos || []).forEach(function (v) {
      framesOf(v).slice(0, 12).forEach(function (f) { pool.push(f); });
      if (!v.frameSel && v.poster) pool.push(v.poster);
    });
    // AI-generated relevant images (kept ones) are input visuals too
    genImagesList().forEach(function (g) { if (g.dataURL) pool.push(g.dataURL); });
    return pool.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  }
  function genImagesList() { var p = currentProject(); return (p && p.genImages) || []; }
  function genImageURLs() { return genImagesList().map(function (g) { return g.dataURL; }).filter(Boolean); }
  // placeholder swatches (no real image model connected yet) — fine as ad
  // inputs, but must NOT appear as a published landing page's hero/gallery
  function placeholderImageURLs() { return genImagesList().filter(function (g) { return g.placeholder; }).map(function (g) { return g.dataURL; }).filter(Boolean); }
  // uploaded footage (object URLs) for use as live video backgrounds
  function videoPool() { return (gen.brief.videos || []).map(function (v) { return v.url; }).filter(Boolean); }
  // the frames of a video that are allowed into ads: the user's picks, or all
  function framesOf(v) {
    var all = v.frames || [];
    if (!v.frameSel) return all;
    return v.frameSel.map(function (i) { return all[i]; }).filter(Boolean);
  }
  // where an ad's visual comes from → 'video' | 'website' | 'image' | 'aiimage' | 'gradient'
  function visualSourceOf(product, isFootage) {
    if (isFootage) return (product && genImageURLs().indexOf(product) >= 0) ? 'aiclip' : 'video';
    if (!product) return 'gradient';
    var b = gen.brief, site = b.site || {};
    if (genImageURLs().indexOf(product) >= 0) return 'aiimage';
    if ((b.images || []).indexOf(product) >= 0) return 'image';
    if ((site.images || []).indexOf(product) >= 0 || product === site.ogImage) return 'website';
    var fromVideo = (b.videos || []).some(function (v) { return v.poster === product || (v.clips || []).some(function (c) { return c.poster === product; }); });
    return fromVideo ? 'video' : 'image';
  }
  function groundedBullets() {
    var site = gen.brief.site || {};
    var out = (site.headings || []).filter(function (h) { return h.length >= 8 && h.length <= 42; }).slice(0, 4);
    return out;
  }
  function templatesFor(copy, hasImg, hasBullets) {
    var t = ['statement', 'phone', 'comparison', 'plain-image'];
    if (hasBullets) t.splice(1, 0, 'feature');
    if (hasImg) t.push('overlay');
    if (copy.stat && copy.stat.value) t.push('stat');
    if (copy.quote && copy.quote.text) t.push('quote');
    return t;
  }

  // Deterministic co-prime strides walk the combination space so consecutive
  // variations differ on several axes at once — radical but repeatable.
  function buildVariations(n, copies) {
    var brand = store.getBrand();
    var site = gen.brief.site || {};
    var pool = imagePool();
    var vids = gen.brief.videos || [];        // uploaded footage for video-ad backgrounds
    var bullets = groundedBullets();
    var accents = accentPool();
    var dom = briefLib.domain(gen.brief);
    var brandName = site.siteName || brand.name;
    var seen = {};
    var videoSeen = {};    // de-dup video DNA across the batch
    var clipCursor = 0;    // cycles through the analyzed clips so each clip ad differs
    // AI images the user ANIMATED (Veo) → their real footage URLs. Half of the
    // qualifying video ads use the live clip, half stay designed motion.
    var aiClips = {};
    genImagesList().forEach(function (g) { if (g.videoURL && g.dataURL && !g.placeholder) aiClips[g.dataURL] = g.videoURL; });
    var aiClipToggle = 0;
    var specs = [];
    // bias creative choices toward liked / away from disliked attribute values
    var scores = prefScores();
    var wBGS = weightPool(BGS, 'background', scores);
    var wAccents = weightPool(accents, 'accent', scores);
    var wDensities = weightPool(DENSITIES, 'density', scores);
    var wFormats = weightPool(FORMATS_BIAS, 'format', scores);

    for (var i = 0; i < n; i++) {
      var copy = copies[i % copies.length];
      var tpls = weightPool(templatesFor(copy, pool.length > 0, bullets.length > 0), 'template', scores);
      var tpl = tpls[(i * 5 + Math.floor(i / tpls.length)) % tpls.length];
      var bg = wBGS[(i * 7 + Math.floor(i / wBGS.length)) % wBGS.length];
      var accent = wAccents[(i * 3) % wAccents.length];
      var lays = LAYOUTS[tpl] || ['auto'];
      var layout = lays[(i * 2 + 1) % lays.length];
      var densityOpts = (tpl === 'statement' || tpl === 'overlay') ? ['minimal', 'standard', 'minimal'] : wDensities;
      var density = densityOpts[(i * 4 + 1) % densityOpts.length];
      var align = (tpl === 'statement' || tpl === 'stat' || tpl === 'quote')
        ? ((i % 3 === 0) ? 'left' : 'center')
        : ((i % 4 === 3) ? 'center' : 'left');
      var format = wFormats[(i * 5 + 2) % wFormats.length];
      var img = pool.length ? pool[(i * 5 + Math.floor(i / pool.length)) % pool.length] : null;

      // de-dup guard: nudge background until the combo is unique
      var key, guard = 0;
      do {
        key = [tpl, bg, accent, layout, density, align, format, i % copies.length, pool.length ? pool.indexOf(img) : -1].join('|');
        if (seen[key]) bg = BGS[(BGS.indexOf(bg) + 1) % BGS.length];
      } while (seen[key] && ++guard < BGS.length);
      seen[key] = 1;

      var caption = copy.caption || ((copy.subtext || copy.headlineStart || '') + (dom ? ' → ' + dom : ''));
      var headline = ((copy.headlineStart || '') + ' ' + (copy.headlineHighlight || '')).trim();

      var kind = kindFor(i);
      var motion = 'auto', bgVideo = null, videoPoster = null, clip = null, dna = null;
      if (kind === 'video') {
        var videoIdx = 0; for (var j = 0; j < i; j++) if (kindFor(j) === 'video') videoIdx++;
        var ve = vids.length ? vids[videoIdx % vids.length] : null;
        var hasClips = ve && ve.clips && ve.clips.length;
        var aiKeys = Object.keys(aiClips);
        // Priority: when the user has ANIMATED AI images, HALF of all video ads
        // ride those real Veo clips — picked directly (not left to the rotating
        // image cursor), or an uploaded video's clips would crowd them out.
        // The other half mixes uploaded clips + designed motion as before.
        if (aiKeys.length && videoIdx % 2 === 0) {
          var ak = aiKeys[aiClipToggle++ % aiKeys.length];
          bgVideo = aiClips[ak]; videoPoster = ak; img = ak; motion = 'footage';
        } else if (hasClips && videoIdx % 3 !== 2) {
          var cl = ve.clips[clipCursor++ % ve.clips.length];
          bgVideo = ve.url; clip = { start: cl.start, end: cl.end };
          // still fallback chain: clip poster → video poster → an extracted
          // frame — footage ads must always carry a real still underneath
          videoPoster = cl.poster || ve.poster || framesOf(ve)[0] || null; motion = 'footage';
        } else if (ve && !hasClips) {              // analysis failed → whole video as background
          bgVideo = ve.url; videoPoster = ve.poster || framesOf(ve)[0] || null; motion = 'footage';
        } else if (img) {                          // composed: a site image, animated
          motion = (videoIdx % 2) ? 'reveal' : 'showcase';
        } else {                                   // composed: kinetic gradient-mesh
          motion = 'kinetic';
        }
        dna = videoDNA(i, motion, videoSeen, scores, !!(bgVideo || img));
      }
      // footage/clip ads prefer the footage still; fall back to a site image so
      // a cell is never blank if the still-grab failed (footage still plays live)
      var product = (kind === 'video' && bgVideo) ? (videoPoster || img) : img;

      specs.push(Object.assign(store.blankSpec(), {
        // grounded content only — wipe demo defaults
        bullets: bullets.length ? bullets : [],
        stat: copy.stat && copy.stat.value ? copy.stat : { value: '', label: '' },
        quote: copy.quote && copy.quote.text ? copy.quote : { text: '', author: '', role: '' },
        captions: { before: 'Before', after: 'After' },
        brand: brandName, logo: (site.favicon || brand.logo), font: brand.font
      }, copy, {
        template: tpl, format: format, background: bg, theme: T.bgById(bg).theme,
        accent: accent, layout: layout, density: density, align: align,
        caption: caption,
        images: { before: null, after: null, product: product },
        adKey: util.uid('ad'),   // stable tracked-link identity (/a/<adKey>)
        kind: kind, motion: motion, videoFormat: 'story', bgVideo: bgVideo, clip: clip, dna: dna,
        visualSource: visualSourceOf(product, kind === 'video' && !!bgVideo),
        copySource: copy.source || 'original',   // original (AI-written) | verbatim | content
        name: (headline || brandName || 'Ad') + ' · ' + (kind === 'video' ? (clip ? 'Clip' : 'Video') : T.tplById(tpl).label) + ' #' + (i + 1),
        angle: copy.angle || ('Variation ' + (i + 1))
      }));
    }
    return specs;
  }

  /* ===================== generation ====================================== */
  function hasAnyInput() {
    return !!(gen.brief.url.trim() || gen.brief.text.trim() || gen.brief.files.length || gen.brief.images.length || (gen.brief.videos && gen.brief.videos.length));
  }
  // representative still frames from uploaded videos → fed to Claude vision so
  // it can "watch" the footage and write copy grounded in what it sees
  function videoFrames() {
    var out = [];
    (gen.brief.videos || []).forEach(function (v) {
      (v.clips || []).forEach(function (c) { if (c.poster) out.push(c.poster); });
      if (v.poster) out.push(v.poster);
    });
    return out.filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, 4);
  }

  function setStatus(msg) {
    gen.statusMsg = msg;
    var el = viewEl && viewEl.querySelector('#gen-status');
    if (el) el.innerHTML = msg ? '<span class="spinner"></span> ' + esc(msg) : '';
  }

  function generate(skipPick) {
    if (gen.generating) return;
    if (!hasAnyInput()) { Ads.toast('Give it something to work with — a URL, text, files, images or a video', true); return; }
    // first Generate after frames arrive: let the user pick which frames may
    // appear in ads before anything is built (strict check — click events
    // arrive as the first argument and must not skip the picker)
    if (skipPick !== true && gen.brief.videos.some(function (v) { return (v.frames || []).length && !v.frameSel; })) {
      openFramePicker({ thenGenerate: true });
      return;
    }
    var frames = videoFrames();
    if (frames.length && !Ads._aiEnabled) Ads.toast('Tip: turn AI on so it can watch your video and write copy from it', false);
    // provenance of the copy (shown in the results summary)
    var inParts = [];
    if (gen.brief.url.trim() || gen.brief.site) inParts.push('website');
    if (gen.brief.text.trim()) inParts.push('your notes');
    if (gen.brief.files.length) inParts.push(gen.brief.files.length + (gen.brief.files.length > 1 ? ' documents' : ' document'));
    if (gen.brief.images.length) inParts.push(gen.brief.images.length + (gen.brief.images.length > 1 ? ' images' : ' image'));
    if (frames.length) inParts.push('your video' + (Ads._aiEnabled ? ' (AI watched it)' : ''));
    gen.copyInputs = inParts;
    gen.copyEngine = Ads._aiEnabled ? 'AI' : 'On-page copy';
    gen.generating = true;
    var btn = viewEl.querySelector('#gen-go');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Working…'; }

    // this run is tied to the project open NOW — if the user switches projects
    // mid-flight, every later step bails instead of writing into the wrong one
    var run = ++gen.runSeq;
    function stale() { return run !== gen.runSeq; }

    var url = gen.brief.url.trim();
    var needScrape = url && (!gen.brief.site || gen.brief.site.url !== url);
    var pre = needScrape
      ? (setStatus('Reading ' + url + '…'), ai.scrape(url).then(function (site) { if (stale()) return; gen.brief.site = site; gen.brief.site.url = url; renderSources(); }))
      : Promise.resolve();

    pre.then(function () {
      if (stale()) throw new Error('__stale__');
      // deep-read first: if the AI hasn't understood this material yet (or the
      // material changed since it last did), build the dossier before writing
      if (Ads._aiEnabled && !dossierFresh()) {
        setStatus('Reading everything you provided — building the project dossier…');
        ensureProject();
        return analyzeProject();
      }
      return null;
    }).then(function () {
      if (stale()) throw new Error('__stale__');
      var dos = dossierFresh() ? currentDossier() : null;
      var pains = researchSelection();
      // Brief assembly, budgeted against the server's 30000-char cap so nothing
      // is silently truncated. Priority: notes (verbatim) → research → dossier.
      // The budget comfortably fits 20+ pain points AND a full dossier; entries
      // are still added WHOLE, never cut mid-sentence.
      var BRIEF_MAX = 28000, DOSSIER_FLOOR = 3000;
      var notesBlock = gen.brief.text ? 'ADVERTISER NOTES (verbatim, follow these):\n' + gen.brief.text.slice(0, 1500) + '\n\n' : '';
      var researchBudget = BRIEF_MAX - notesBlock.length - (dos ? DOSSIER_FLOOR : 0);
      var researchBlock = '', includedPains = 0;
      if (pains.length) {
        var rb = 'MARKET RESEARCH — PAIN POINTS TO ATTACK (each ad targets ONE of these; use or sharpen their hooks/headlines):\n';
        for (var pi = 0; pi < pains.length; pi++) {
          var rp = pains[pi];
          var entry = (pi + 1) + '. PAIN: ' + rp.pain + (rp.who ? ' (who: ' + rp.who + ')' : '') +
            (rp.quote ? '\n   MARKET LANGUAGE: "' + rp.quote + '"' : '') +
            '\n   HOOK: ' + rp.hook + '\n   HEADLINE: ' + rp.headline +
            (rp.tagline ? '\n   TAGLINE: ' + rp.tagline : '') +
            (rp.description ? '\n   DESCRIPTION: ' + rp.description : '') + '\n';
          if (rb.length + entry.length > researchBudget) break;
          rb += entry; includedPains++;
        }
        if (includedPains) researchBlock = rb + '\n';
      }
      var composed = dos
        ? (notesBlock + researchBlock + dos.text.slice(0, Math.max(DOSSIER_FLOOR, BRIEF_MAX - notesBlock.length - researchBlock.length)))
        : (notesBlock + researchBlock + briefLib.compose(gen.brief)).slice(0, BRIEF_MAX);
      if (dos) { gen.copyEngine = 'AI + project dossier'; if (gen.copyInputs.indexOf('project dossier') < 0) gen.copyInputs.unshift('project dossier'); }
      if (includedPains) {
        var rLabel = 'market research (' + includedPains + (includedPains < pains.length ? ' of ' + pains.length : '') + ' pain points)';
        if (gen.copyInputs.join('|').indexOf('market research') < 0) gen.copyInputs.push(rLabel);
        if (includedPains < pains.length) Ads.toast('Brief is full — ' + includedPains + ' of ' + pains.length + ' pain points made it in', true);
      }
      if (Ads._aiEnabled) {
        return generateCopyBatched(composed, frames).then(function (vars) {
          var mapped = vars.map(ai.variationToSpec).filter(function (v) { return v.headlineStart || v.headlineHighlight; });
          if (!mapped.length) gen.copyEngine = 'On-page copy (AI returned nothing)';
          return mapped.length ? mapped : briefLib.fallbackCopies(gen.brief, gen.count);
        });
      }
      // no-AI fallback: researched pain points become real copy variations,
      // interleaved ahead of the content-mined lines
      var fb = briefLib.fallbackCopies(gen.brief, gen.count);
      return pains.length ? researchFallbackCopies(pains).concat(fb) : fb;
    }).then(function (copies) {
      if (stale()) throw new Error('__stale__');
      setStatus('Composing ' + gen.count + ' creatives…');
      gen.results = buildVariations(gen.count, copies);
      gen.selected = {}; gen.liked = {}; gen.disliked = {}; gen.removed = {};
      gen.generating = false;
      setStatus('');
      // persist the brief to the project (auto-created if needed). Generated
      // batches stay session-only — results: [] also clears legacy stored
      // batches so the store slims down. Liked ads persist via savedAds.
      ensureProject();
      saveProject({ results: [], copyEngine: gen.copyEngine || '', copyInputs: gen.copyInputs || [] });
      renderView(viewEl);
      var res = viewEl.querySelector('#gen-results');
      if (res) res.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) {
      gen.generating = false;
      setStatus('');
      if (e && e.message === '__stale__') return;  // project switched mid-run — dropped on purpose
      if (btn) { btn.disabled = false; btn.innerHTML = generateLabel(); }
      Ads.toast(e.message, true);
    });
  }
  // Write ONE distinct AI copy per requested ad — with no practical ceiling.
  // A single request can only return so many tokens before the model runs out,
  // so we split the ask into batches (≤ CHUNK each, safely under that limit) and
  // run a few at a time, then combine. 100 ads → ~7 batches → ~100 distinct copies.
  function generateCopyBatched(brief, frames) {
    var want = Math.max(4, gen.count);
    var CHUNK = 15, CONCURRENCY = 3;
    var sizes = [];
    for (var c = 0; c < want; c += CHUNK) sizes.push(Math.min(CHUNK, want - c));
    var brand = { name: (gen.brief.site && gen.brief.site.siteName) || store.getBrand().name, voice: store.getBrand().voice };
    var prefs = prefsForAI();
    var out = new Array(sizes.length), doneN = 0, nextI = 0, active = 0;
    function status() {
      var head = frames.length ? 'Watching your video & writing ' : 'Writing ';
      setStatus(head + want + ' copy angles with AI…' + (sizes.length > 1 ? ' (' + doneN + '/' + sizes.length + ' batches)' : ''));
    }
    status();
    return new Promise(function (resolve) {
      function pump() {
        while (active < CONCURRENCY && nextI < sizes.length) {
          (function (idx) {
            active++;
            ai.generateCopy({
              brief: brief, count: sizes[idx], brand: brand, preferences: prefs,
              frames: idx === 0 ? frames : [],            // vision context once; the brief carries the rest
              batch: sizes.length > 1 ? { i: idx + 1, n: sizes.length } : null
            }).then(function (v) { out[idx] = v || []; }, function () { out[idx] = []; })  // a failed batch never sinks the others
              .then(function () {
                active--; doneN++; status();
                if (doneN === sizes.length) resolve([].concat.apply([], out));
                else pump();
              });
          })(nextI++);
        }
      }
      pump();
    });
  }
  function generateLabel() {
    return '<span class="btn-ico">' + icons().sparkle + '</span> Generate ' + gen.count + ' ad' + (gen.count === 1 ? '' : 's');
  }
  // how many of gen.count are video vs post under the current mix
  function splitCounts() {
    var v = 0; for (var i = 0; i < gen.count; i++) if (kindFor(i) === 'video') v++;
    return { video: v, posts: gen.count - v };
  }
  function mixNote() {
    var s = splitCounts();
    if (gen.mix === 'posts') return 'All static image posts.';
    if (gen.mix === 'video') return 'All short motion videos (9:16, for Reels & TikTok).';
    return '≈ 2 posts : 1 video → ' + s.posts + ' post' + (s.posts === 1 ? '' : 's') + ' + ' + s.video + ' video' + (s.video === 1 ? '' : 's') + '.';
  }

  /* ===================== view: brief panel ================================ */
  function sourceChips() {
    var chips = [];
    var b = gen.brief;
    if (b.site) chips.push({ kind: 'site', label: b.site.siteName || b.site.title || 'website', ico: icons().globe });
    b.files.forEach(function (f, i) { chips.push({ kind: 'file', i: i, label: f.name, ico: icons().importd }); });
    b.images.forEach(function (img, i) { chips.push({ kind: 'img', i: i, label: 'image ' + (i + 1), thumb: img }); });
    (b.videos || []).forEach(function (v, i) {
      var extra = v.analyzing ? ' · finding clips…' : ((v.clips && v.clips.length) ? ' · ' + v.clips.length + ' clips' : '');
      if ((v.frames || []).length) extra += ' · ' + v.frames.length + ' frames';
      if (v.transcribing) extra += ' · transcribing…';
      else if (v.transcript) extra += ' · transcribed';
      chips.push({ kind: 'video', i: i, label: (v.name || ('video ' + (i + 1))) + extra, thumb: v.poster, ico: icons().video, film: true });
    });
    if (!chips.length) return '';
    return '<div class="src-chips">' + chips.map(function (c, idx) {
      return '<span class="src-chip' + (c.film ? ' is-film' : '') + '">' +
        (c.thumb ? '<img src="' + c.thumb + '">' : '<i class="sc-ico">' + c.ico + '</i>') +
        (c.film ? '<span class="sc-film">▶</span>' : '') +
        '<span class="sc-label">' + esc(c.label) + '</span>' +
        '<button class="sc-x" data-chip-kind="' + c.kind + '" data-chip-i="' + (c.i != null ? c.i : '') + '" title="Remove">×</button>' +
      '</span>';
    }).join('') + '</div>';
  }

  function briefPanel() {
    var b = gen.brief;
    return '<section class="gen-hero">' +
      '<div class="gh-head"><h2>What are we advertising?</h2>' +
        '<span class="u-label">' + (Ads._aiEnabled ? 'AI copywriter ready' : 'AI off — using on-page copy') + '</span></div>' +
      '<div class="gh-projectbar">' +
        '<span class="ghp-chip' + (gen.projectId ? '' : ' is-new') + '" title="' + (gen.projectId ? 'Everything here is saved to this project' : 'A project is created automatically on first upload or generate') + '">' +
          icons().archive + ' <span id="gb-projname">' + esc(gen.projectId ? (gen.projectName || 'Project') : 'New project') + '</span>' +
        '</span>' +
        '<button class="btn is-ghost is-sm" id="gb-newproj">New project</button>' +
        '<button class="btn is-ghost is-sm" id="gb-myproj">My projects</button>' +
      '</div>' +
      '<div class="gh-grid">' +
        '<div class="field"><label>Website URL</label>' +
          '<input class="input" id="gb-url" placeholder="https://yourproduct.com" value="' + esc(b.url) + '">' +
          '<div class="hint">We read the page — copy, brand colour, logo, imagery.</div></div>' +
        '<div class="field"><label>Additional details (optional)</label>' +
          '<textarea class="textarea" id="gb-text" placeholder="Audience, offer, promo, key benefits, tone — anything the ads should know.">' + esc(b.text) + '</textarea></div>' +
      '</div>' +
      '<div class="gh-files">' +
        '<button class="btn is-ghost is-sm" id="gb-files"><span class="btn-ico">' + icons().importd + '</span> Add documents (PDF, TXT…)</button>' +
        '<button class="btn is-ghost is-sm" id="gb-imgs"><span class="btn-ico">' + icons().image + '</span> Add images</button>' +
        '<button class="btn is-ghost is-sm" id="gb-video"><span class="btn-ico">' + icons().video + '</span> Add video (footage)</button>' +
        (gen.brief.videos.some(function (v) { return (v.frames || []).length; })
          ? '<button class="btn is-ghost is-sm" id="gb-frames"><span class="btn-ico">' + icons().image + '</span> Pick video frames' +
            (function () { var k = 0, t = 0; gen.brief.videos.forEach(function (v) { t += (v.frames || []).length; k += framesOf(v).length; }); return t ? ' (' + k + '/' + t + ')' : ''; })() + '</button>'
          : '') +
        '<span class="u-faint" style="font-size:1.1rem">Images &amp; video become the creatives; documents feed the copywriter. Video ads use your footage (or the website\'s images) as the moving background.</span>' +
      '</div>' +
      '<div id="gb-chips">' + sourceChips() + '</div>' +
      '<div class="gh-mix">' +
        '<span class="u-label">Creative type</span>' +
        '<div class="segmented" id="gb-mix">' +
          '<button data-mix="both" class="' + (gen.mix === 'both' ? 'is-active' : '') + '">Posts + video</button>' +
          '<button data-mix="posts" class="' + (gen.mix === 'posts' ? 'is-active' : '') + '">Posts only</button>' +
          '<button data-mix="video" class="' + (gen.mix === 'video' ? 'is-active' : '') + '">Video only</button>' +
        '</div>' +
        '<span class="u-faint gh-mix-note" id="gb-mixnote">' + mixNote() + '</span>' +
      '</div>' +
      '<div class="gh-slider">' +
        '<div class="ghs-info"><span class="ghs-num" id="gb-num">' + gen.count + '</span><span class="u-label">variations</span></div>' +
        '<input type="range" id="gb-range" min="1" max="100" step="1" value="' + gen.count + '">' +
        '<button class="btn is-primary is-lg" id="gen-go" ' + (gen.generating ? 'disabled' : '') + '>' +
          (gen.generating ? '<span class="spinner"></span> Working…' : generateLabel()) + '</button>' +
      '</div>' +
      '<div class="gh-learn"><span class="gh-learn-ico">' + icons().like + '</span><span id="gb-learn">' + esc(learnNote()) + '</span>' +
        ((store.getPrefs().liked.length || store.getPrefs().disliked.length) ? ' <button class="gh-learn-reset" id="gb-learn-reset">reset learning</button>' : '') + '</div>' +
      '<div class="gh-status" id="gen-status">' + (gen.statusMsg ? '<span class="spinner"></span> ' + esc(gen.statusMsg) : '') + '</div>' +
    '</section>';
  }

  function bindBrief(el) {
    var url = el.querySelector('#gb-url');
    url.addEventListener('input', function () { gen.brief.url = url.value; saveProjectSoon(); });
    url.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); generate(); } });
    var txt = el.querySelector('#gb-text');
    txt.addEventListener('input', function () { gen.brief.text = txt.value; saveProjectSoon(); });
    var pf = el.querySelector('#gb-frames');
    if (pf) pf.addEventListener('click', function () { openFramePicker({}); });
    var np = el.querySelector('#gb-newproj');
    if (np) np.addEventListener('click', startNewProject);
    var mp = el.querySelector('#gb-myproj');
    if (mp) mp.addEventListener('click', function () { Ads.go('projects'); });

    el.querySelector('#gb-files').addEventListener('click', function () { pickFiles('.pdf,.txt,.md,.csv,.json,text/plain,application/pdf', false); });
    el.querySelector('#gb-imgs').addEventListener('click', function () { pickFiles('image/*', true); });
    el.querySelector('#gb-video').addEventListener('click', pickVideo);

    var range = el.querySelector('#gb-range'), num = el.querySelector('#gb-num'), go = el.querySelector('#gen-go');
    function syncMeta() { if (go && !gen.generating) go.innerHTML = generateLabel(); var n = el.querySelector('#gb-mixnote'); if (n) n.textContent = mixNote(); }
    range.addEventListener('input', function () { gen.count = +range.value; num.textContent = gen.count; syncMeta(); });
    go.addEventListener('click', generate);
    el.querySelectorAll('#gb-mix [data-mix]').forEach(function (b) {
      b.addEventListener('click', function () {
        gen.mix = b.getAttribute('data-mix');
        el.querySelectorAll('#gb-mix [data-mix]').forEach(function (x) { x.classList.toggle('is-active', x === b); });
        syncMeta(); saveProjectSoon();
      });
    });
    var lr = el.querySelector('#gb-learn-reset');
    if (lr) lr.addEventListener('click', function () {
      Ads.confirm({ title: 'Reset ad learning?', message: 'Forget every liked and disliked ad. Future batches won\'t be biased by past taste.', danger: true, okLabel: 'Reset', onConfirm: function () { store.clearPrefs(); Ads.toast('Learning reset'); renderView(viewEl); } });
    });

    bindChips(el);
  }
  // chip removers live in #gb-chips, which is re-rendered on every add/remove —
  // bind ONLY those here so the persistent brief controls never stack handlers
  function bindChips(el) {
    var box = el && el.querySelector('#gb-chips');
    if (!box) return;
    box.querySelectorAll('.sc-x').forEach(function (x) {
      x.addEventListener('click', function () {
        var kind = x.getAttribute('data-chip-kind'), i = +x.getAttribute('data-chip-i');
        if (kind === 'site') { gen.brief.site = null; }
        if (kind === 'file') gen.brief.files.splice(i, 1);
        if (kind === 'img') gen.brief.images.splice(i, 1);
        if (kind === 'video') { try { URL.revokeObjectURL(gen.brief.videos[i].url); } catch (e) {} gen.brief.videos.splice(i, 1); }
        renderSources();
        if (gen.projectId) saveProject();
      });
    });
  }
  function renderSources() {
    var box = viewEl && viewEl.querySelector('#gb-chips');
    if (!box) return;
    box.innerHTML = sourceChips();
    bindChips(viewEl);
  }
  function pickFiles(accept, imagesOnly) {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept; inp.multiple = true;
    inp.onchange = function () {
      if (!inp.files.length) return;
      Ads.toast('Reading ' + inp.files.length + ' file' + (inp.files.length > 1 ? 's' : '') + '…');
      briefLib.ingest(inp.files).then(function (out) {
        gen.brief.files = gen.brief.files.concat(out.texts);
        gen.brief.images = gen.brief.images.concat(out.images);
        if (out.skipped.length) Ads.toast('Skipped: ' + out.skipped.join(', '), true);
        renderSources();
        ensureProject(); saveProject();   // uploads are saved to the project immediately
      });
    };
    inp.click();
  }
  function addVideoFiles(files) {
    Ads.toast('Reading video…');
    // bind this whole batch to the project open NOW — a mid-upload project
    // switch must not push someone else's footage into the new project
    var p0 = ensureProject(), pid = p0.id, run = gen.runSeq;
    function stale() { return gen.projectId !== pid || gen.runSeq !== run; }
    var chain = Promise.resolve();
    [].slice.call(files || []).forEach(function (f) {
      chain = chain.then(function () {
        if (stale()) return;
        return briefLib.ingestVideo(f).then(function (v) {
          if (stale()) return;
          gen.brief.videos.push(v);
          v.analyzing = true; renderSources();
          // persist the raw file server-side so the project survives reload;
          // swap the temporary object URL for the durable served URL
          return uploadProjectFile(pid, f).then(function (servedUrl) {
            if (stale()) return;
            var storedName = null;
            if (servedUrl) {
              var oldUrl = v.url;
              try { URL.revokeObjectURL(oldUrl); } catch (e) {}
              v.url = servedUrl;
              // any already-generated specs referencing the temporary URL would
              // be dead after reload — repoint them at the durable one
              gen.results.forEach(function (s) { if (s.bgVideo === oldUrl) s.bgVideo = servedUrl; });
              storedName = decodeURIComponent(servedUrl.split('/').pop());
            } else {
              Ads.toast('Could not save the video to the project — it will work this session only', true);
            }
            // hear the video: transcribe through the local whisper tool in the
            // background (can take a while — never blocks anything)
            if (storedName) transcribeVideo(pid, v, storedName);
            // find the best short clips, then sample frames across every scene
            var analyzeStep = Ads.clips
              ? Ads.clips.analyze(v.url, { topN: 6 }).then(function (r) {
                  if (stale()) return;
                  v.clips = (r && r.clips) || []; renderSources();
                  Ads.toast(v.clips.length ? ('Found ' + v.clips.length + ' clips in ' + (v.name || 'video')) : ('Using ' + (v.name || 'video') + ' as footage'));
                }).catch(function () { v.clips = []; })
              : Promise.resolve();
            return analyzeStep.then(function () {
              if (stale() || !Ads.clips) { v.analyzing = false; return; }
              return Ads.clips.frames(v.url, { count: 30 }).then(function (fr) {
                if (stale()) return;
                v.frames = (fr && fr.frames) || []; v.framesTried = true;
                v.analyzing = false; renderSources();
              }).catch(function () { v.framesTried = true; v.analyzing = false; if (!stale()) renderSources(); });
            });
          });
        });
      });
    });
    return chain.then(function () { if (!stale()) { renderSources(); saveProject(); } });
  }
  function pickVideo() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'video/*'; inp.multiple = true;
    inp.onchange = function () { if (inp.files.length) addVideoFiles(inp.files); };
    inp.click();
  }

  /* ===================== view: results grid =============================== */
  function selectedIdx() { return Object.keys(gen.selected).filter(function (k) { return gen.selected[k] && !gen.removed[k]; }).map(Number); }

  var SRC_LABEL = { video: '🎬 from video', website: '🌐 from website', image: '🖼 your image', aiimage: '✨ AI image', aiclip: '🎬 AI clip', gradient: '◆ generated' };
  function srcChip(s) {
    var v = s.visualSource; if (!v) return '';
    return '<span class="vc-src is-' + v + '" title="Where this ad’s visual came from">' + SRC_LABEL[v] + '</span>';
  }
  var COPY_LABEL = { original: '✍ AI-written', verbatim: '❝ your content', content: '❝ your content', research: '🔎 from research' };
  function copyChip(s) {
    var v = s.copySource; if (!v || !COPY_LABEL[v]) return '';
    var title = v === 'original' ? 'The AI wrote this copy itself from its understanding of the project'
      : (v === 'research' ? 'Built from a researched market pain point'
        : 'This headline is a real line taken from your material');
    return '<span class="vc-src vc-copysrc is-' + (v === 'original' ? 'ai' : (v === 'research' ? 'research' : 'quote')) + '" title="' + title + '">' + COPY_LABEL[v] + '</span>';
  }

  function cellHTML(i) {
    var s = gen.results[i], isVideo = s.kind === 'video';
    return '<div class="var-cell' + (gen.selected[i] ? ' is-selected' : '') + (isVideo ? ' is-video' : '') + (gen.liked[i] ? ' is-liked' : '') +
      '" data-vi="' + i + '" title="Click to select · double-click to enlarge">' +
      '<div class="vc-check">' + icons().check + '</div>' +
      (isVideo ? '<div class="vc-playbadge' + (s.clip ? ' is-clip' : '') + '">▶ ' + (s.clip ? 'CLIP' : 'VIDEO') + '</div>' : '') +
      '<div class="vc-shell">' + devices.shell(gen.view, gen.platform, s, { domain: briefLib.domain(gen.brief) }) + '</div>' +
      '<div class="vc-meta">' +
        '<div class="vc-metatop">' +
          '<span class="vc-angle u-truncate">' + esc(s.angle || ('Variation ' + (i + 1))) + '</span>' +
          '<span class="vc-tag' + (isVideo ? ' is-video' : '') + '">' + (isVideo ? (s.clip ? '9:16 CLIP' : '9:16 VIDEO') : esc(T.tplById(s.template).label)) + '</span>' +
          srcChip(s) + copyChip(s) +
        '</div>' +
        '<span class="vc-actions">' +
          '<button class="icon-btn vc-like" data-like="' + i + '" data-stop="1" title="Like — make more like this">' + icons().like + '</button>' +
          '<button class="icon-btn vc-dislike" data-dislike="' + i + '" data-stop="1" title="Dislike &amp; remove">' + icons().dislike + '</button>' +
          '<button class="btn is-ghost is-sm" data-edit="' + i + '" data-stop="1">Edit</button>' +
          '<button class="icon-btn" data-dl="' + i + '" data-stop="1" title="Download ' + (isVideo ? 'video' : 'PNG') + '">' + icons().download + '</button>' +
        '</span>' +
      '</div>' +
    '</div>';
  }

  function resultsSection() {
    if (!gen.results.length) {
      return '<section id="gen-results"><div class="empty"><div class="empty-title">No ads yet</div>' +
        '<div>Point it at a website or drop in a brief, choose a count, and hit Generate.</div></div></section>';
    }
    // platform buttons only mean something in a mockup view — dimmed in plain
    var platBtns = devices.PLATFORMS.map(function (p) {
      return '<button class="' + (gen.view !== 'plain' && gen.platform === p.id ? 'is-active' : '') + '" data-plat="' + p.id + '">' + esc(p.label) + '</button>';
    }).join('');
    var viewBtns = devices.VIEWS.map(function (v) {
      var dis = v.id !== 'plain' && gen.platform === 'tiktok' && v.id !== 'phone' ? ' disabled' : '';
      return '<button class="' + (gen.view === v.id ? 'is-active' : '') + '" data-devview="' + v.id + '"' + dis + '>' + esc(v.label) + '</button>';
    }).join('');
    var cards = gen.results.map(function (s, i) { return gen.removed[i] ? '' : cellHTML(i); }).join('');

    // batch provenance summary (visuals across the grid + what fed the copy)
    var VS = { video: 'your video', website: 'website', image: 'your images', gradient: 'generated gradient' };
    var seenV = {}, vlist = [];
    gen.results.forEach(function (s, i) { if (!gen.removed[i] && s.visualSource && !seenV[s.visualSource]) { seenV[s.visualSource] = 1; vlist.push(VS[s.visualSource] || s.visualSource); } });
    var nAI = 0, nQuote = 0, nRes = 0;
    gen.results.forEach(function (s, i) { if (!gen.removed[i]) { if (s.copySource === 'original') nAI++; else if (s.copySource === 'research') nRes++; else if (s.copySource === 'verbatim' || s.copySource === 'content') nQuote++; } });
    var mixBits = []; if (nAI) mixBits.push(nAI + ' AI-written'); if (nRes) mixBits.push(nRes + ' from research'); if (nQuote) mixBits.push(nQuote + ' from your content');
    var copyLine = (gen.copyEngine || 'On-page copy') + (mixBits.length ? ' — ' + mixBits.join(' · ') : '') + ((gen.copyInputs && gen.copyInputs.length) ? ' — from ' + gen.copyInputs.join(', ') : '');
    var sourcesBar = '<div class="gen-sources">' +
      '<span class="gs-ico">' + icons().globe + '</span>' +
      '<span><b>Visuals:</b> ' + esc(vlist.join(', ') || '—') + '</span>' +
      '<span class="gs-dot">·</span>' +
      '<span><b>Copy:</b> ' + esc(copyLine) + '</span>' +
    '</div>';

    return '<section id="gen-results">' +
      sourcesBar +
      '<div class="gen-toolbar">' +
        '<div class="segmented plat-switch">' + platBtns + '</div>' +
        '<div class="segmented">' + viewBtns + '</div>' +
        '<span class="u-label">' + gen.results.length + ' variations</span>' +
        '<div class="toolbar-spacer"></div>' +
        '<div class="ai-bar">' +
          '<input class="gen-ai-input" id="gv-ai" placeholder="Tell the AI what to change on selected ads…">' +
          '<button class="btn is-sm" id="gv-ai-go"><span class="btn-ico">' + icons().sparkle + '</span> Apply</button>' +
        '</div>' +
      '</div>' +
      '<div class="gen-toolbar is-secondary">' +
        '<button class="btn is-ghost is-sm" id="gv-all">Select all</button>' +
        '<button class="btn is-ghost is-sm" id="gv-none">Clear</button>' +
        '<span class="u-muted" id="gv-count" style="font-size:1.2rem">0 selected</span>' +
        '<div class="toolbar-spacer"></div>' +
        '<button class="btn is-sm" id="gv-landing"><span class="btn-ico">' + icons().ext + '</span> Landing pages' +
          ((currentProject() && (currentProject().landings || []).length) ? ' (' + currentProject().landings.length + ')' : '') + '</button>' +
        '<button class="btn is-sm" id="gv-zip" disabled><span class="btn-ico">' + icons().download + '</span> Download ZIP + captions</button>' +
        '<button class="btn is-primary is-sm" id="gv-approve" disabled><span class="btn-ico">' + icons().check + '</span> Approve selected</button>' +
      '</div>' +
      '<div class="var-grid view--' + gen.view + '">' + cards + '</div>' +
    '</section>';
  }

  function bindResults(el) {
    if (!gen.results.length) return;
    el.querySelectorAll('[data-plat]').forEach(function (b) {
      b.addEventListener('click', function () {
        gen.platform = b.getAttribute('data-plat');
        if (gen.view === 'plain') gen.view = 'phone';   // a platform implies a mockup
        refreshResults();
      });
    });
    el.querySelectorAll('[data-devview]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        gen.view = b.getAttribute('data-devview');
        refreshResults();
      });
    });
    el.querySelectorAll('.var-cell').forEach(bindCell);
    el.querySelector('#gv-all').addEventListener('click', function () {
      el.querySelectorAll('.var-cell[data-vi]').forEach(function (c) { gen.selected[+c.getAttribute('data-vi')] = true; c.classList.add('is-selected'); });
      updateBar(el);
    });
    el.querySelector('#gv-none').addEventListener('click', function () {
      gen.selected = {};
      el.querySelectorAll('.var-cell').forEach(function (c) { c.classList.remove('is-selected'); });
      updateBar(el);
    });
    var lb = el.querySelector('#gv-landing');
    if (lb) lb.addEventListener('click', openLandingModal);
    el.querySelector('#gv-zip').addEventListener('click', function () { downloadZip(this); });
    el.querySelector('#gv-approve').addEventListener('click', approveSelected);
    var aiInput = el.querySelector('#gv-ai');
    el.querySelector('#gv-ai-go').addEventListener('click', function () { applyAiToSelection(aiInput.value, this); });
    aiInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); applyAiToSelection(aiInput.value, el.querySelector('#gv-ai-go')); } });
    updateBar(el);
    mountCells(el);
  }

  function refreshResults() {
    stopControllers();
    var sec = viewEl.querySelector('#gen-results');
    if (!sec) return;
    var html = resultsSection();
    var tmp = document.createElement('div'); tmp.innerHTML = html;
    sec.replaceWith(tmp.firstChild);
    bindResults(viewEl);
  }

  function updateBar(el) {
    var sel = selectedIdx().length;
    var c = el.querySelector('#gv-count'); if (c) c.textContent = sel + ' selected';
    var z = el.querySelector('#gv-zip'); if (z) z.disabled = !sel;
    var a = el.querySelector('#gv-approve'); if (a) a.disabled = !sel;
  }

  // Mount creatives in small batches so 100 cells never freeze the UI.
  // Video cells show a static poster and play on hover (one at a time).
  function mountCells(el) {
    stopControllers();
    var cells = [].slice.call(el.querySelectorAll('.var-cell[data-vi]'));
    var i = 0;
    (function step() {
      var end = Math.min(i + 6, cells.length);
      for (; i < end; i++) mountCell(cells[i]);
      if (i < cells.length) setTimeout(step, 16);
    })();
  }
  function mountCell(cell) {
    var spec = gen.results[+cell.getAttribute('data-vi')];
    // Static poster (the video engine seeks + captures a real footage frame),
    // full motion on hover. Autoplaying every cell is unreliable (frames drawn
    // mid-seek come out blank) and heavy, so we don't.
    var ctrl = devices.mountCreative(cell, spec, { animate: false });
    if (ctrl) liveControllers.push(ctrl);
    if (spec.kind === 'video') {
      cell.addEventListener('mouseenter', function () {
        if (cell._vc) return;
        cell._vc = devices.mountCreative(cell, spec, { animate: true });
        if (cell._vc) liveControllers.push(cell._vc);
      });
      cell.addEventListener('mouseleave', function () {
        if (cell._vc) { try { cell._vc.poster(); } catch (e) {} cell._vc = null; }
      });
    }
  }

  /* ===================== per-cell events + like / dislike ================ */
  function bindCell(cell) {
    var i = +cell.getAttribute('data-vi');
    cell.addEventListener('click', function (e) {
      if (e.target.closest('[data-stop]')) return;
      gen.selected[i] = !gen.selected[i];
      cell.classList.toggle('is-selected', !!gen.selected[i]);
      updateBar(viewEl);
    });
    cell.addEventListener('dblclick', function (e) { if (e.target.closest('[data-stop]')) return; openAdLightbox(gen.results[i], i); });
    var edit = cell.querySelector('[data-edit]');
    if (edit) edit.addEventListener('click', function () {
      editModal(gen.results[i], { title: 'Edit ad — ' + (gen.results[i].angle || ('Variation ' + (i + 1))), onSave: function (u) { gen.results[i] = u; refreshResults(); } });
    });
    var dl = cell.querySelector('[data-dl]');
    if (dl) dl.addEventListener('click', function () {
      var s = gen.results[i], old = dl.innerHTML;
      if (s.kind === 'video') { dl.innerHTML = '<span class="spinner"></span>'; Ads.toast('Rendering video…'); }
      render.downloadAuto(s).then(function (r) { Ads.toast((r && r.ext ? r.ext.toUpperCase() : 'File') + ' downloaded'); })
        .catch(function (e) { Ads.toast(e.message, true); }).then(function () { dl.innerHTML = old; });
    });
    var like = cell.querySelector('[data-like]');
    if (like) like.addEventListener('click', function () { toggleLike(i, cell); });
    var dis = cell.querySelector('[data-dislike]');
    if (dis) dis.addEventListener('click', function () { dislikeCell(i, cell); });
  }

  // a like does two things: teaches the AI AND pins the ad into the project's
  // saved-ads shelf (the only ads that survive a reload). Unlike unpins it.
  function unsaveAd(savedId) {
    var p = currentProject(); if (!p || !savedId) return;
    var next = (p.savedAds || []).filter(function (a) { return a.savedId !== savedId; });
    if (next.length !== (p.savedAds || []).length) store.updateProject(p.id, { savedAds: next });
  }
  function toggleLike(i, cell) {
    if (gen.disliked[i]) return;
    if (gen.liked[i]) {
      store.removeVerdict(gen.liked[i].verdict);
      unsaveAd(gen.liked[i].savedId);
      delete gen.liked[i]; cell.classList.remove('is-liked');
    } else {
      var p = ensureProject();
      var saved = Object.assign(clone(gen.results[i]), { savedId: util.uid('sv'), savedAt: util.nowISO() });
      if (saved.bgVideo && !durableUrl(saved.bgVideo)) { saved.bgVideo = null; saved.clip = null; if (saved.motion === 'footage') saved.motion = 'auto'; }
      var list = (p.savedAds || []).slice(); list.unshift(saved);
      store.updateProject(p.id, { savedAds: list });
      gen.liked[i] = { verdict: store.recordVerdict(gen.results[i], 'like'), savedId: saved.savedId };
      cell.classList.add('is-liked');
      Ads.toast('Saved — this ad now lives in Saved ads and survives reloads');
    }
    refreshSaved(); refreshLearnNote();
  }
  function dislikeCell(i, cell) {
    if (gen.disliked[i]) return;
    if (gen.liked[i]) {
      store.removeVerdict(gen.liked[i].verdict);
      unsaveAd(gen.liked[i].savedId);
      delete gen.liked[i]; cell.classList.remove('is-liked'); refreshSaved();
    }
    var id = store.recordVerdict(gen.results[i], 'dislike');
    gen.selected[i] = false;
    if (cell._vc) { try { cell._vc.stop(); } catch (e) {} cell._vc = null; }
    cell.classList.add('is-removing');
    cell.innerHTML = '<div class="vc-undo"><span class="vc-undo-txt">Removed — the AI will learn from this</span>' +
      '<button class="btn is-sm" data-undo="' + i + '">Undo</button></div>';
    var t = setTimeout(function () { finalizeRemove(i, cell); }, 5000);
    gen.disliked[i] = { id: id, timer: t };
    cell.querySelector('[data-undo]').addEventListener('click', function () { undoDislike(i, cell); });
    updateBar(viewEl); refreshLearnNote();
  }
  function undoDislike(i, cell) {
    var d = gen.disliked[i]; if (!d) return;
    clearTimeout(d.timer); store.removeVerdict(d.id); delete gen.disliked[i];
    var tmp = document.createElement('div'); tmp.innerHTML = cellHTML(i);
    var fresh = tmp.firstChild; cell.replaceWith(fresh); bindCell(fresh); mountCell(fresh);
    updateBar(viewEl); refreshLearnNote();
  }
  function finalizeRemove(i, cell) {
    delete gen.disliked[i]; gen.removed[i] = true;
    cell.classList.add('is-gone');
    setTimeout(function () { if (cell.parentNode) cell.parentNode.removeChild(cell); }, 340);
    updateBar(viewEl);
  }
  function refreshLearnNote() {
    var n = viewEl && viewEl.querySelector('#gb-learn');
    if (n) n.textContent = learnNote();
  }

  /* ===================== saved ads (liked → persistent shelf) ============ */
  function savedSection() {
    var p = currentProject(); var list = (p && p.savedAds) || [];
    if (!list.length) return '<section id="gen-saved"></section>';
    var cards = list.map(function (s, i) {
      var isVideo = s.kind === 'video';
      return '<div class="var-cell saved-cell' + (isVideo ? ' is-video' : '') + '" data-sv="' + i + '" title="Double-click to enlarge">' +
        (isVideo ? '<div class="vc-playbadge' + (s.clip ? ' is-clip' : '') + '">▶ ' + (s.clip ? 'CLIP' : 'VIDEO') + '</div>' : '') +
        '<div class="vc-shell">' + devices.shell('plain', gen.platform, s, { domain: briefLib.domain(gen.brief) }) + '</div>' +
        '<div class="vc-meta">' +
          '<div class="vc-metatop">' +
            '<span class="vc-angle u-truncate">' + esc(s.angle || 'Saved ad') + '</span>' +
            srcChip(s) + copyChip(s) +
          '</div>' +
          '<span class="vc-actions">' +
            '<button class="btn is-ghost is-sm" data-sv-edit="' + i + '" data-stop="1">Edit</button>' +
            '<button class="icon-btn" data-sv-dl="' + i + '" data-stop="1" title="Download ' + (isVideo ? 'video' : 'PNG') + '">' + icons().download + '</button>' +
            '<button class="icon-btn vc-dislike" data-sv-rm="' + i + '" data-stop="1" title="Remove from saved">' + icons().trash + '</button>' +
          '</span>' +
        '</div>' +
      '</div>';
    }).join('');
    return '<section id="gen-saved" class="gen-saved">' +
      '<div class="saved-head"><h3>❤ Saved ads <span class="saved-count">' + list.length + '</span></h3>' +
      '<span class="u-label">liked ads live here permanently — generated batches reset on reload</span>' +
      '<button class="btn is-sm" id="sv-landing" style="margin-left:auto"><span class="btn-ico">' + icons().ext + '</span> Landing pages</button></div>' +
      '<div class="var-grid view--plain">' + cards + '</div>' +
    '</section>';
  }
  function bindSaved(el) {
    var p = currentProject(); var list = (p && p.savedAds) || [];
    var slb = el.querySelector('#sv-landing');
    if (slb) slb.addEventListener('click', openLandingModal);
    el.querySelectorAll('.saved-cell').forEach(function (cell) {
      var i = +cell.getAttribute('data-sv'); var s = list[i]; if (!s) return;
      var ctrl = devices.mountCreative(cell, s, { animate: false });
      if (ctrl) liveControllers.push(ctrl);
      if (s.kind === 'video') {
        cell.addEventListener('mouseenter', function () {
          if (cell._vc) return;
          cell._vc = devices.mountCreative(cell, s, { animate: true });
          if (cell._vc) liveControllers.push(cell._vc);
        });
        cell.addEventListener('mouseleave', function () {
          if (cell._vc) { try { cell._vc.poster(); } catch (e) {} cell._vc = null; }
        });
      }
      cell.addEventListener('dblclick', function (e) { if (e.target.closest('[data-stop]')) return; openAdLightbox(s, null); });
      var dl = cell.querySelector('[data-sv-dl]');
      if (dl) dl.addEventListener('click', function () {
        var old = dl.innerHTML;
        if (s.kind === 'video') { dl.innerHTML = '<span class="spinner"></span>'; Ads.toast('Rendering video…'); }
        render.downloadAuto(s).then(function (r) { Ads.toast((r && r.ext ? r.ext.toUpperCase() : 'File') + ' downloaded'); })
          .catch(function (e) { Ads.toast(e.message, true); }).then(function () { dl.innerHTML = old; });
      });
      var rm = cell.querySelector('[data-sv-rm]');
      if (rm) rm.addEventListener('click', function () {
        unsaveAd(s.savedId);
        // if it's still on screen in this batch, un-heart it there too
        Object.keys(gen.liked).forEach(function (k) {
          if (gen.liked[k] && gen.liked[k].savedId === s.savedId) {
            store.removeVerdict(gen.liked[k].verdict); delete gen.liked[k];
            var c = viewEl.querySelector('.var-cell[data-vi="' + k + '"]'); if (c) c.classList.remove('is-liked');
          }
        });
        refreshSaved(); refreshLearnNote();
      });
      var ed = cell.querySelector('[data-sv-edit]');
      if (ed) ed.addEventListener('click', function () {
        editModal(clone(s), { title: 'Edit saved ad', onSave: function (u) {
          var proj = currentProject(); if (!proj) return;
          var next = (proj.savedAds || []).slice();
          next[i] = Object.assign(u, { savedId: s.savedId, savedAt: s.savedAt });
          store.updateProject(proj.id, { savedAds: next });
          refreshSaved();
        } });
      });
    });
  }
  function refreshSaved() {
    var sec = viewEl && viewEl.querySelector('#gen-saved');
    if (!sec) return;
    var tmp = document.createElement('div'); tmp.innerHTML = savedSection();
    sec.replaceWith(tmp.firstChild);
    bindSaved(viewEl);
  }
  // Re-mount any creative that mounted while its cell had no real layout —
  // e.g. the DAM iframe still sizing when the app first rendered. The width
  // clamps in devices/render keep such mounts visible; this pass restores
  // exact cell-fitted sizing once layout settles, and again on resizes.
  function healMounts() {
    if (!viewEl) return;
    var p = currentProject(); var saved = (p && p.savedAds) || [];
    viewEl.querySelectorAll('.saved-cell[data-sv], .var-cell[data-vi]').forEach(function (cell) {
      var slot = cell.querySelector('[data-ad-slot]');
      if (!slot || slot.clientWidth < 40) return;
      var vis = slot.firstChild;
      if (!vis || !vis.getBoundingClientRect) return;
      var r = vis.getBoundingClientRect();
      if (r.width >= 10 && r.width >= slot.clientWidth * 0.5) return;   // healthy
      var spec = null;
      if (cell.hasAttribute('data-sv')) spec = saved[+cell.getAttribute('data-sv')];
      else if (cell.hasAttribute('data-vi')) spec = gen.results[+cell.getAttribute('data-vi')];
      if (!spec) return;
      if (cell._vc) { try { cell._vc.stop(); } catch (e) {} cell._vc = null; }
      var ctrl = devices.mountCreative(cell, spec, { animate: false });
      if (ctrl) liveControllers.push(ctrl);
    });
  }
  var healT = null, healCount = 0;
  function scheduleHeal() { clearTimeout(healT); healT = setTimeout(function () { healCount++; healMounts(); }, 250); }
  window.addEventListener('resize', scheduleHeal);
  // resize never fires for display:none → visible flips (e.g. an embedding
  // page revealing the app after boot) — heal when cells actually appear
  document.addEventListener('visibilitychange', scheduleHeal);
  var healIO = (typeof IntersectionObserver !== 'undefined')
    ? new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) { scheduleHeal(); return; }
      })
    : null;
  function watchShelfVisibility() {
    if (!healIO || !viewEl) return;
    healIO.disconnect();
    var sec = viewEl.querySelector('#gen-saved'); if (sec) healIO.observe(sec);
    var grid = viewEl.querySelector('#gv-grid, .var-grid'); if (grid) healIO.observe(grid);
  }

  /* ===================== bulk actions ==================================== */
  // adKeys that actually have a published, resolvable landing page (a tracked
  // link only works once its page exists on the collector). Built from the
  // project's saved landings so the CSV never hands out a link that 404s.
  function publishedKeySet() {
    var p = currentProject(); var set = {};
    ((p && p.landings) || []).forEach(function (l) {
      if (l.tracked && l.adKeys) l.adKeys.forEach(function (k) { set[k] = 1; });
    });
    return set;
  }
  function downloadZip(btn) {
    var idx = selectedIdx();
    var specs = idx.map(function (i) { return gen.results[i]; });
    var nVid = specs.filter(function (s) { return s.kind === 'video'; }).length;
    if (nVid) Ads.toast(nVid + ' video' + (nVid === 1 ? '' : 's') + ' record in real time (~5s each) — hang tight');
    var old = btn.innerHTML; btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 0/' + specs.length;
    var pubKeys = publishedKeySet();
    var missing = specs.filter(function (s) { return s.adKey && !pubKeys[s.adKey]; }).length;
    var csv = util.toCSV(specs, [
      { label: 'File', get: function (s) { return util.slug(s.name || s.headlineStart) + (s.kind === 'video' ? '.mp4' : '.png'); } },
      { label: 'Type', get: function (s) { return s.kind === 'video' ? 'video 9:16' : 'post'; } },
      { label: 'Headline', get: function (s) { return ((s.headlineStart || '') + ' ' + (s.headlineHighlight || '')).trim(); } },
      { label: 'Primary text (caption)', key: 'caption' },
      { label: 'Description', key: 'description' },
      { label: 'CTA', key: 'cta' },
      { label: 'Angle', key: 'angle' },
      // the link to put ON the ad — clicks route through the collector, which
      // logs them and forwards to the ad's landing page. Append ?s=fb / ?s=ig
      // per platform to split the numbers by source. Emitted ONLY for ads whose
      // landing page is published — an unpublished /a/ link would 404, sending
      // paid clicks nowhere. Un-published ads get a clear placeholder instead.
      { label: 'Tracked link', get: function (s) {
          if (!s.adKey) return '';
          return pubKeys[s.adKey] ? trackBase() + '/a/' + s.adKey : '(generate landing pages first)';
        } }
    ]);
    render.zip(specs, null, function (done, total) { btn.innerHTML = '<span class="spinner"></span> ' + done + '/' + total; },
      [{ name: 'captions.csv', text: csv }])
      .then(function (blob) {
        util.downloadBlob(blob, 'ads-' + util.todayISO() + '.zip');
        if (missing) Ads.toast(missing + ' of these ' + specs.length + ' ads have no landing page yet — click “Landing pages” to publish them, or their tracked links won\'t work', true);
        else Ads.toast('Downloaded ' + specs.length + ' ads + captions.csv');
      })
      .catch(function (e) { Ads.toast(e.message, true); })
      .then(function () { btn.disabled = false; btn.innerHTML = old; });
  }

  function approveSelected() {
    var idx = selectedIdx();
    var specs = idx.map(function (i) { return clone(gen.results[i]); });
    Ads.confirm({
      title: 'Approve ' + specs.length + ' ads?',
      message: 'They move to Ad Performance as “approved”, with their captions, ready to post and track.',
      okLabel: 'Approve ' + specs.length,
      onConfirm: function () {
        store.addAds(specs, { status: 'approved', approvedAt: util.nowISO() });
        Ads.toast('Approved ' + specs.length + ' ads');
        Ads.go('dashboard');
      }
    });
  }

  function applyAiToSelection(instruction, btn) {
    instruction = (instruction || '').trim();
    if (!instruction) { Ads.toast('Type what to change first', true); return; }
    if (!Ads._aiEnabled) { Ads.toast('AI is off — set ANTHROPIC_API_KEY on the server', true); return; }
    var idx = selectedIdx();
    if (!idx.length) { Ads.toast('Select the ads to change first', true); return; }
    if (idx.length > 20) { Ads.toast('Max 20 ads per AI edit — select fewer', true); return; }
    var old = btn.innerHTML; btn.disabled = true;
    var done = 0;
    var chain = Promise.resolve();
    idx.forEach(function (i) {
      chain = chain.then(function () {
        btn.innerHTML = '<span class="spinner"></span> ' + (++done) + '/' + idx.length;
        return ai.editSpec({ instruction: instruction, spec: gen.results[i], brand: store.getBrand() })
          .then(function (res) { applyChanges(gen.results[i], res.changes); });
      });
    });
    chain.then(function () {
      btn.disabled = false; btn.innerHTML = old;
      refreshResults();
      Ads.toast('Updated ' + idx.length + ' ad' + (idx.length > 1 ? 's' : ''));
    }).catch(function (e) {
      btn.disabled = false; btn.innerHTML = old;
      refreshResults();
      Ads.toast(e.message, true);
    });
  }

  /* ===================== validated AI patch ============================== */
  var EDIT_ENUMS = {
    template: ['comparison', 'phone', 'statement', 'stat', 'quote', 'feature', 'plain-image', 'overlay'],
    format: ['square', 'portrait', 'story'], theme: ['dark', 'light'], font: ['clean', 'brand'],
    layout: ['auto', 'top', 'bottom', 'left', 'right', 'center'],
    density: ['minimal', 'standard', 'rich'], align: ['left', 'center']
  };
  function applyChanges(s, ch) {
    var bgIds = T.BACKGROUNDS.map(function (b) { return b.id; });
    Object.keys(ch || {}).forEach(function (k) {
      var v = ch[k];
      if (k === 'background') { if (bgIds.indexOf(v) >= 0) { s.background = v; if (ch.theme == null) s.theme = T.bgById(v).theme; } return; }
      if (EDIT_ENUMS[k]) { if (EDIT_ENUMS[k].indexOf(v) >= 0) s[k] = v; return; }
      if (k === 'accent') { if (/^#[0-9a-f]{6}$/i.test(v)) s.accent = v; return; }
      if (k === 'boldPhrases' || k === 'bullets') { s[k] = Array.isArray(v) ? v : (v ? String(v).split(',').map(function (x) { return x.trim(); }).filter(Boolean) : []); return; }
      if (k === 'captions' || k === 'stat' || k === 'quote') { if (v && typeof v === 'object') s[k] = Object.assign({}, s[k], v); return; }
      if (['badge', 'headlineStart', 'headlineHighlight', 'subtext', 'cta', 'brand', 'name', 'caption', 'description'].indexOf(k) >= 0) { s[k] = String(v); return; }
    });
  }

  /* ===================== Edit modal (ALL options) ======================== */
  function opt(list, sel) {
    return list.map(function (o) {
      var v = typeof o === 'string' ? o : o.value, l = typeof o === 'string' ? o : o.label;
      return '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
  }
  // Veo needs an inline image — same-origin URLs (e.g. /pfiles stills) convert on the fly
  function imageToDataURL(src) {
    if (/^data:/i.test(src)) return Promise.resolve(src);
    return fetch(src).then(function (r) { if (!r.ok) throw new Error('image unavailable'); return r.blob(); }).then(function (b) {
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res(String(fr.result)); };
        fr.onerror = function () { rej(new Error('could not read the image')); };
        fr.readAsDataURL(b);
      });
    });
  }
  function editModal(srcSpec, opts) {
    opts = opts || {};
    var s = clone(srcSpec); // work on a copy until Save
    var pool = imagePool();
    var prevCtrl = null;    // live video preview controller — stopped on every remount
    var remount = util.debounce(function (m) {
      var prev = m.querySelector('#em-preview');
      if (prev) {
        if (prevCtrl) { try { prevCtrl.stop(); } catch (e) {} prevCtrl = null; }
        var w = (prev.parentElement.clientWidth - 24) || 320;
        // video ads preview LIVE here — this is where you check a real clip
        if (s.kind === 'video' && Ads.video) { w = Math.min(w, 300); prev.style.width = w + 'px'; prevCtrl = Ads.video.mount(prev, s, true); }
        else { prev.style.width = ''; render.mount(prev, s, w); }
      }
      var cap = m.querySelector('#em-cap-prev');
      if (cap) cap.textContent = s.caption || '—';
    }, 120);

    function f(label, html) { return '<div class="field"><label>' + esc(label) + '</label>' + html + '</div>'; }
    function inp(key, val, ph) { return '<input class="input" data-ek="' + key + '" value="' + esc(val == null ? '' : val) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>'; }
    function ta(key, val, h) { return '<textarea class="textarea" data-ek="' + key + '" style="min-height:' + (h || 6) + 'rem">' + esc(val == null ? '' : val) + '</textarea>'; }

    function imgRow(slot, label) {
      var cur = s.images && s.images[slot];
      var poolBtns = pool.map(function (p, i) {
        return '<button class="em-pool' + (cur === p ? ' is-active' : '') + '" data-epool="' + slot + ':' + i + '" title="Use this image"><img src="' + p + '"></button>';
      }).join('');
      return '<div class="field"><label>' + esc(label) + '</label>' +
        '<div class="em-imgrow">' +
          (cur ? '<img class="em-cur" src="' + cur + '">' : '<span class="em-noimg">none</span>') +
          '<button class="btn is-ghost is-sm" data-eup="' + slot + '">Upload</button>' +
          (cur ? '<button class="btn is-ghost is-sm" data-eclear="' + slot + '">Remove</button>' : '') +
          (poolBtns ? '<span class="em-poolwrap">' + poolBtns + '</span>' : '') +
        '</div></div>';
    }

    var bgOptions = T.BACKGROUNDS.filter(function (b) { return b.id !== 'image'; }).map(function (b) { return { value: b.id, label: b.label }; });
    var tplOptions = T.LIST.map(function (t) { return { value: t.id, label: t.label }; });
    var fmtOptions = Object.keys(T.FORMATS).map(function (k) { return { value: k, label: T.FORMATS[k].label }; });
    var fontOptions = Object.keys(T.FONTS).map(function (k) { return { value: k, label: T.FONTS[k].label }; });

    var body =
      '<div class="em-grid">' +
        '<div class="em-fields">' +
          (Ads._aiEnabled ?
            '<div class="em-ai"><input class="gen-ai-input" id="em-ai" placeholder="Tell the AI what to change on this ad…">' +
            '<button class="btn is-sm" id="em-ai-go"><span class="btn-ico">' + icons().sparkle + '</span> Apply</button></div>' : '') +
          f('Ad name', inp('name', s.name)) +
          '<div class="field-row">' +
            f('Creative type', '<select class="select" data-ek="kind">' + opt([{ value: 'post', label: 'Static post' }, { value: 'video', label: 'Motion video (9:16)' }], s.kind || 'post') + '</select>') +
            f('Motion style', '<select class="select" data-ek="motion">' + opt([{ value: 'auto', label: 'Auto' }, { value: 'showcase', label: 'Showcase (image)' }, { value: 'kinetic', label: 'Kinetic (text)' }, { value: 'reveal', label: 'Reveal' }, { value: 'footage', label: 'Footage (uploaded video)' }], s.motion || 'auto') + '</select>') +
          '</div>' +
          (s.kind === 'video' ?
          '<div class="field-row">' +
            f('Headline motion', '<select class="select" data-ek="dna.typeMotion">' + opt([{ value: 'lines', label: 'Lines' }, { value: 'words', label: 'Words' }, { value: 'punch', label: 'Punch' }, { value: 'sweep', label: 'Sweep' }], (s.dna && s.dna.typeMotion) || 'lines') + '</select>') +
            f('Camera move', '<select class="select" data-ek="dna.bgMove">' + opt([{ value: 'drift', label: 'Drift' }, { value: 'pushIn', label: 'Push in' }, { value: 'pushOut', label: 'Push out' }, { value: 'panL', label: 'Pan left' }, { value: 'panR', label: 'Pan right' }], (s.dna && s.dna.bgMove) || 'drift') + '</select>') +
            f('Colour grade', '<select class="select" data-ek="dna.grade">' + opt([{ value: 'none', label: 'None' }, { value: 'duotone', label: 'Duotone' }, { value: 'warm', label: 'Warm' }, { value: 'noir', label: 'Noir' }, { value: 'vivid', label: 'Vivid' }], (s.dna && s.dna.grade) || 'none') + '</select>') +
          '</div>' : '') +
          (s.kind === 'video' && s.images && s.images.product ?
            (function () {
              if (!s.bgVideo) {
                var existing = genImagesList().filter(function (g) { return g.videoURL && g.dataURL === s.images.product; })[0];
                return '<div class="field"><label>Real footage</label>' +
                  '<button class="btn is-sm" id="em-film">🎬 ' + (existing ? 'Use your AI clip — free' : 'Film this still into a real clip (Veo)') + '</button>' +
                  '<div class="hint" style="margin-top:0.6rem">' + (existing
                    ? 'You already animated this exact image — apply its real footage to this ad instantly.'
                    : 'Veo brings the ad’s image to life as an 8-second vertical clip that loops under the copy (~$1–2, billed by Google, takes 1–3 min — keep this window open).') + '</div></div>';
              }
              var isAiClip = /-aiclip\.mp4$/i.test(s.bgVideo) || genImagesList().some(function (g) { return g.videoURL === s.bgVideo; });
              if (isAiClip) {
                return '<div class="field"><label>Real footage — AI clip</label>' +
                  '<div class="btn-row">' +
                    '<button class="btn is-sm" id="em-refilm">🎬 Re-film this clip (Veo)</button>' +
                    '<button class="btn is-ghost is-sm" id="em-declip">Remove clip</button>' +
                  '</div>' +
                  '<div class="hint" style="margin-top:0.6rem">The preview on the right plays the current clip live. Re-film for a fresh take from the same image (~$1–2, billed by Google, 1–3 min), or remove it to fall back to designed motion.</div></div>';
              }
              return '';
            })() : '') +
          '<div class="field-row">' +
            f('Template', '<select class="select" data-ek="template">' + opt(tplOptions, s.template) + '</select>') +
            f('Format', '<select class="select" data-ek="format">' + opt(fmtOptions, s.format) + '</select>') +
          '</div>' +
          '<div class="field-row">' +
            f('Layout', '<select class="select" data-ek="layout">' + opt(EDIT_ENUMS.layout, s.layout || 'auto') + '</select>') +
            f('Copy density', '<select class="select" data-ek="density">' + opt(EDIT_ENUMS.density, s.density || 'standard') + '</select>') +
            f('Alignment', '<select class="select" data-ek="align">' + opt(EDIT_ENUMS.align, s.align || 'left') + '</select>') +
          '</div>' +
          '<div class="field-row">' +
            f('Background', '<select class="select" data-ek="background">' + opt(bgOptions, s.background) + '</select>') +
            f('Text theme', '<select class="select" data-ek="theme">' + opt(EDIT_ENUMS.theme, s.theme) + '</select>') +
            f('Font', '<select class="select" data-ek="font">' + opt(fontOptions, s.font) + '</select>') +
          '</div>' +
          f('Accent colour', '<div class="color-field"><input type="color" id="em-accent" value="' + esc(s.accent) + '"><input class="input" id="em-accent-hex" value="' + esc(s.accent) + '"></div>') +
          '<hr class="em-rule">' +
          f('Badge / eyebrow', inp('badge', s.badge)) +
          '<div class="field-row">' +
            f('Headline start', inp('headlineStart', s.headlineStart)) +
            f('Highlight (accent)', inp('headlineHighlight', s.headlineHighlight)) +
          '</div>' +
          f('On-image subtext', ta('subtext', s.subtext, 5)) +
          '<div class="field-row">' +
            f('Bold phrases (comma-sep)', inp('boldPhrases', (s.boldPhrases || []).join(', '))) +
            f('CTA button', inp('cta', s.cta)) +
          '</div>' +
          f('Caption — Facebook primary text', ta('caption', s.caption, 7)) +
          f('Link description (≤30 chars)', inp('description', s.description)) +
          '<hr class="em-rule">' +
          f('Feature bullets (one per line)', ta('bullets', (s.bullets || []).join('\n'), 5)) +
          '<div class="field-row">' +
            f('Stat value', inp('stat.value', (s.stat || {}).value)) +
            f('Stat label', inp('stat.label', (s.stat || {}).label)) +
          '</div>' +
          f('Quote', ta('quote.text', (s.quote || {}).text, 4)) +
          '<div class="field-row">' +
            f('Quote author', inp('quote.author', (s.quote || {}).author)) +
            f('Author role', inp('quote.role', (s.quote || {}).role)) +
          '</div>' +
          '<div class="field-row">' +
            f('“Before” caption', inp('captions.before', (s.captions || {}).before)) +
            f('“After” caption', inp('captions.after', (s.captions || {}).after)) +
          '</div>' +
          '<hr class="em-rule">' +
          imgRow('product', 'Product / main image') +
          imgRow('before', 'Comparison “before” image') +
          imgRow('after', 'Comparison “after” image') +
        '</div>' +
        '<div class="em-side">' +
          '<div class="em-prevwrap"><div class="ad-stage-scaler" id="em-preview"></div></div>' +
          '<div class="em-capbox"><div class="u-label" style="margin-bottom:.5rem">Caption preview</div><div id="em-cap-prev" class="em-cap"></div></div>' +
        '</div>' +
      '</div>';

    Ads.modal({
      title: opts.title || 'Edit ad', xwide: true,
      body: body,
      foot: [
        { label: 'Cancel', act: 'cancel', ghost: true },
        { label: 'Download PNG', act: 'dl', ghost: true },
        { label: opts.submitLabel || 'Save changes', act: 'save', primary: true }
      ],
      onAction: function (act, m) {
        if (act === 'cancel') return Ads.closeModal();
        if (act === 'dl') return render.download(s).then(function () { Ads.toast('Downloaded'); }).catch(function (e) { Ads.toast(e.message, true); });
        if (act === 'save') { Ads.closeModal(); if (opts.onSave) opts.onSave(s); }
      },
      onMount: function (m) {
        remount(m);
        m.querySelectorAll('[data-ek]').forEach(function (node) {
          var ev = node.tagName === 'SELECT' ? 'change' : 'input';
          node.addEventListener(ev, function () {
            setField(s, node.getAttribute('data-ek'), node.value);
            if (node.getAttribute('data-ek') === 'background') s.theme = T.bgById(s.background).theme;
            remount(m);
          });
        });
        var ac = m.querySelector('#em-accent'), ah = m.querySelector('#em-accent-hex');
        ac.addEventListener('input', function () { ah.value = ac.value; s.accent = ac.value; remount(m); });
        ah.addEventListener('input', function () { if (/^#[0-9a-f]{6}$/i.test(ah.value)) { ac.value = ah.value; s.accent = ah.value; remount(m); } });
        // 🎬 convert this still video ad into REAL footage (existing clip = free)
        var film = m.querySelector('#em-film');
        if (film) film.addEventListener('click', function () {
          var pid0 = ensureProject().id;
          function applyClip(url) {
            s.bgVideo = url; s.clip = null; s.motion = 'footage'; s.visualSource = 'aiclip';
            film.disabled = true; film.textContent = '🎬 Real clip applied — press Save';
            remount(m);
            Ads.toast('This ad now plays real footage — press Save to keep it');
          }
          var existing = genImagesList().filter(function (g) { return g.videoURL && g.dataURL === s.images.product; })[0];
          if (existing) return applyClip(existing.videoURL);
          Ads.confirm({
            title: 'Film this still into a real clip?',
            message: 'Veo animates the ad’s image into an 8-second vertical clip (~$1–2, billed by Google to your Gemini key). Takes 1–3 minutes — keep this window open.',
            okLabel: 'Film it',
            onConfirm: function () {
              film.disabled = true; film.innerHTML = '<span class="spinner"></span> Filming… (1–3 min)';
              imageToDataURL(s.images.product).then(function (durl) {
                var gi = genImagesList().filter(function (g) { return g.dataURL === durl; })[0];
                var prompt = (gi && gi.prompt) || [s.angle, ((s.headlineStart || '') + ' ' + (s.headlineHighlight || '')).trim(), s.subtext].filter(Boolean).join('. ');
                return ai.genClip({ project: pid0, prompt: prompt, image: durl }).then(function (resp) {
                  // remember the clip on the source image too — every future use is free
                  if (gi) {
                    var proj = store.getProject(pid0);
                    if (proj) store.updateProject(pid0, { genImages: (proj.genImages || []).map(function (x) { return x.id === gi.id ? Object.assign({}, x, { videoURL: resp.url }) : x; }) });
                  }
                  applyClip(resp.url);
                });
              }).catch(function (e) {
                film.disabled = false; film.textContent = '🎬 Film this still into a real clip (Veo)';
                Ads.toast('Could not film the clip: ' + (e && e.message || 'failed'), true);
              });
            }
          });
        });
        // 🎬 AI-clip ads: fresh take from the same image, or back to designed motion
        var refilm = m.querySelector('#em-refilm');
        if (refilm) refilm.addEventListener('click', function () {
          var pid1 = ensureProject().id;
          Ads.confirm({
            title: 'Re-film this clip?',
            message: 'Veo films a fresh 8-second take from the same image (~$1–2, billed by Google). The new clip replaces this ad’s footage — and updates the source image, so other ads using it pick up the new take too. Takes 1–3 minutes.',
            okLabel: 'Re-film',
            onConfirm: function () {
              refilm.disabled = true; refilm.innerHTML = '<span class="spinner"></span> Filming… (1–3 min)';
              imageToDataURL(s.images.product).then(function (durl) {
                var gi = genImagesList().filter(function (g) { return g.dataURL === durl || g.videoURL === s.bgVideo; })[0];
                var prompt = (gi && gi.prompt) || [s.angle, ((s.headlineStart || '') + ' ' + (s.headlineHighlight || '')).trim(), s.subtext].filter(Boolean).join('. ');
                return ai.genClip({ project: pid1, prompt: prompt, image: durl }).then(function (resp) {
                  if (gi) {
                    var proj = store.getProject(pid1);
                    if (proj) store.updateProject(pid1, { genImages: (proj.genImages || []).map(function (x) { return x.id === gi.id ? Object.assign({}, x, { videoURL: resp.url }) : x; }) });
                  }
                  s.bgVideo = resp.url; s.clip = null; s.motion = 'footage'; s.visualSource = 'aiclip';
                  refilm.disabled = false; refilm.textContent = '🎬 Re-film this clip (Veo)';
                  remount(m);
                  Ads.toast('Fresh take applied — the preview is playing it. Press Save to keep it.');
                });
              }).catch(function (e) {
                refilm.disabled = false; refilm.textContent = '🎬 Re-film this clip (Veo)';
                Ads.toast('Could not re-film: ' + (e && e.message || 'failed'), true);
              });
            }
          });
        });
        var declip = m.querySelector('#em-declip');
        if (declip) declip.addEventListener('click', function () {
          s.bgVideo = null; s.clip = null; s.motion = 'showcase'; s.visualSource = 'aiimage';
          Ads.toast('Clip removed — back to designed motion. Press Save to keep it.');
          rerenderModal();
        });
        m.querySelectorAll('[data-eup]').forEach(function (b) {
          b.addEventListener('click', function () {
            Ads.pickImage(function (durl) { s.images[b.getAttribute('data-eup')] = durl; rerenderModal(); });
          });
        });
        m.querySelectorAll('[data-eclear]').forEach(function (b) {
          b.addEventListener('click', function () { s.images[b.getAttribute('data-eclear')] = null; rerenderModal(); });
        });
        m.querySelectorAll('[data-epool]').forEach(function (b) {
          b.addEventListener('click', function () {
            var parts = b.getAttribute('data-epool').split(':');
            s.images[parts[0]] = pool[+parts[1]]; rerenderModal();
          });
        });
        if (m.querySelector('#em-ai-go')) {
          var aiIn = m.querySelector('#em-ai'), aiGo = m.querySelector('#em-ai-go');
          function run() {
            var ins = aiIn.value.trim(); if (!ins) return;
            var old = aiGo.innerHTML; aiGo.disabled = true; aiGo.innerHTML = '<span class="spinner"></span>';
            ai.editSpec({ instruction: ins, spec: s, brand: store.getBrand() }).then(function (res) {
              applyChanges(s, res.changes); rerenderModal(); Ads.toast(res.note || 'Updated');
            }).catch(function (e) { Ads.toast(e.message, true); })
              .then(function () { aiGo.disabled = false; aiGo.innerHTML = old; });
          }
          aiGo.addEventListener('click', run);
          aiIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); run(); } });
        }
        function rerenderModal() {
          Ads.closeModal();
          editModal(s, opts);
        }
      }
    });
  }
  // dotted-path setter for data-ek fields ("stat.value", "bullets", …)
  function setField(s, key, val) {
    if (key === 'boldPhrases') { s.boldPhrases = val.split(',').map(function (x) { return x.trim(); }).filter(Boolean); return; }
    if (key === 'bullets') { s.bullets = val.split('\n').map(function (x) { return x.trim(); }).filter(Boolean); return; }
    var parts = key.split('.');
    if (parts.length === 2) { s[parts[0]] = s[parts[0]] || {}; s[parts[0]][parts[1]] = val; return; }
    s[key] = val;
  }

  /* ===================== landing pages =================================== */
  // One page per distinct hook: same headline + creative as the ad, then the
  // full product story from the dossier. index.html + Landing.jsx + ad.png,
  // hosted live under /pfiles and offered as a ZIP.
  function landingListHTML(landings) {
    if (!landings || !landings.length) return '';
    return '<div class="lp-list">' + landings.map(function (l, li) {
      var live = l.publicPath ? trackBase() + l.publicPath : '';
      return '<div class="lp-row">' +
        '<div class="lp-name u-truncate" title="' + esc(l.headline) + '">' + esc(l.headline) + '</div>' +
        '<span class="u-faint">' + l.adCount + ' ad' + (l.adCount > 1 ? 's' : '') + '</span>' +
        '<span class="lp-links">' +
          (live ? '<a class="btn is-sm" href="' + esc(live) + '" target="_blank" rel="noopener">Live page</a>'
                : (l.files.html ? '<a class="btn is-sm" href="' + esc(l.files.html) + '" target="_blank" rel="noopener">Open page</a>' : '')) +
          ((l.adKeys && l.adKeys.length)
            ? '<button class="btn is-ghost is-sm" data-lp-copy="' + li + '" title="Copy this page\'s tracked ad links — put these ON the ads">Copy ' + l.adKeys.length + ' ad link' + (l.adKeys.length > 1 ? 's' : '') + '</button>'
            : '') +
          (l.files.jsx ? '<a class="btn is-ghost is-sm" href="' + esc(l.files.jsx) + '" target="_blank" rel="noopener">JSX</a>' : '') +
          (l.files.png ? '<a class="btn is-ghost is-sm" href="' + esc(l.files.png) + '" target="_blank" rel="noopener">PNG</a>' : '') +
        '</span>' +
      '</div>';
    }).join('') + '</div>';
  }
  function bindLandingCopies(m, landings) {
    m.querySelectorAll('[data-lp-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var l = landings[+b.getAttribute('data-lp-copy')];
        if (!l || !l.adKeys) return;
        var links = l.adKeys.map(function (k) { return trackBase() + '/a/' + k; }).join('\n');
        try { navigator.clipboard.writeText(links); Ads.toast('Tracked ad links copied — use them as the ads\' destination'); }
        catch (e) { Ads.toast('Could not copy', true); }
      });
    });
  }
  // saved ads liked before tracking existed have no adKey. Mint stable keys
  // once (and persist) so their landing pages + tracked links never shift.
  function ensureSavedAdKeys() {
    var p = currentProject(); if (!p || !(p.savedAds || []).length) return;
    var minted = false;
    p.savedAds.forEach(function (a) { if (!a.adKey) { a.adKey = util.uid('ad'); minted = true; } });
    if (minted) store.updateProject(p.id, { savedAds: p.savedAds });
  }
  // ads that get a landing page: the current batch (minus removed) PLUS the
  // project's saved (liked) ads — deduped by adKey — so saved ads are covered
  // even after a reload when the working batch is empty.
  function landingAdSpecs() {
    var specs = [], seen = {};
    (gen.results || []).forEach(function (s, i) { if (gen.removed[i]) return; if (s.adKey) seen[s.adKey] = 1; specs.push(s); });
    var p = currentProject();
    ((p && p.savedAds) || []).forEach(function (s) { if (s.adKey && seen[s.adKey]) return; specs.push(s); });
    return specs;
  }
  // one landing page PER AD (each ad is tracked separately through its page).
  // Ads with no headline are skipped; each gets a stable slug keyed by its adKey.
  function landingItems(specs) {
    var items = [], usedSlug = {};
    (specs || landingAdSpecs()).forEach(function (s) {
      var headline = ((s.headlineStart || '') + ' ' + (s.headlineHighlight || '')).trim();
      if (!headline) return;
      if (!s.adKey) s.adKey = util.uid('ad');            // ensure every page is trackable
      var sfx = String(s.adKey).replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase() || 'ad';
      var slug = (util.slug(headline).slice(0, 40) + '-' + sfx).replace(/^-+|-+$/g, '').slice(0, 48);
      while (usedSlug[slug]) slug = (slug + 'x').slice(0, 48);
      usedSlug[slug] = 1;
      items.push({ spec: s, adKey: s.adKey, headline: headline, hook: s.caption || s.subtext || '', slug: slug });
    });
    return items;
  }
  // rich, first-person-ready context for the AI copywriter (understand, not quote)
  function landingContext(d) {
    var parts = [];
    if (d && d.sections) {
      var s = d.sections;
      if (s.summary) parts.push(s.summary);
      if (s.product) parts.push(s.product);
      if (s.audience) parts.push('Who we serve: ' + s.audience);
      if (Array.isArray(s.benefits) && s.benefits.length) parts.push('What people gain: ' + s.benefits.join('; '));
      if (Array.isArray(s.features) && s.features.length) parts.push('What we offer: ' + s.features.join('; '));
      if (Array.isArray(s.proof) && s.proof.length) parts.push('Proof: ' + s.proof.join(' | '));
      if (Array.isArray(s.objections) && s.objections.length) parts.push('Doubts people have (answer these honestly): ' + s.objections.join(' | '));
      if (s.tone) parts.push('Our tone: ' + s.tone);
      if (Array.isArray(s.keywords) && s.keywords.length) parts.push('Words that matter to us: ' + s.keywords.join(', '));
    }
    // market research: real pain points in the market's own words — the raw
    // material for sections that answer what the reader is actually feeling.
    // Honors the research panel's "use in ads" checkboxes, same as Generate.
    var research = currentResearch();
    if (research) {
      if (research.summary) parts.push('What we know about the market: ' + String(research.summary).slice(0, 1500));
      var chosen = researchSelection();
      if (chosen.length) {
        var pains = chosen.slice(0, 8).map(function (r) {
          return '- ' + (r.pain || '') + (r.who ? ' (felt by: ' + r.who + ')' : '') + (r.quote ? ' — in their words: "' + r.quote + '"' : '');
        }).join('\n');
        parts.push('Real pain points people told us about:\n' + pains);
      }
    }
    var siteText = gen.brief.site && gen.brief.site.text;
    if (siteText) parts.push('In our own words on the site: ' + String(siteText).slice(0, 3500));
    var joined = parts.join('\n\n');
    return joined ? joined.slice(0, 23000) : briefLib.compose(gen.brief).slice(0, 23000);
  }
  function openLandingModal() {
    var p = currentProject();
    ensureSavedAdKeys();
    var adSpecs = landingAdSpecs();
    var items = landingItems(adSpecs);
    var hooks = Ads.landing.distinctHooks(adSpecs, null);
    var existing = (p && p.landings) || [];
    var n = items.length;
    // how many of these pages come from saved (liked) ads vs the current batch
    var batchKeys = {};
    (gen.results || []).forEach(function (s, i) { if (!gen.removed[i] && s.adKey) batchKeys[s.adKey] = 1; });
    var savedN = items.filter(function (it) { return !batchKeys[it.adKey]; }).length;
    var savedNote = savedN ? ' (including ' + savedN + ' saved ad' + (savedN > 1 ? 's' : '') + ')' : '';
    var body =
      (existing.length
        ? '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.8rem">' +
            '<span class="u-label">Saved landing pages (' + existing.length + ')</span>' +
            '<button class="btn is-ghost is-sm" id="lp-clear">Clear saved pages</button>' +
          '</div>' + landingListHTML(existing) + '<hr class="em-rule">'
        : '') +
      (n
        ? '<p class="u-muted"><strong>One landing page per ad</strong> — ' + n + ' page' + (n > 1 ? 's' : '') + ' for your ' + n + ' ad' + (n > 1 ? 's' : '') + savedNote +
          ', so every ad is tracked separately. Each opens with the same headline and creative as its ad, then continues in your brand’s own voice' +
          (currentDossier() ? '' : ' (run “Read &amp; understand everything” first for the richest copy)') + '.' +
          (Ads._aiEnabled ? ' The AI writes each page <strong>as you</strong> — first person, from what it understands about you' + (hooks.length < n ? ', reusing a story across ads that share a hook' : '') + '.' : ' Turn AI on for first-person written copy.') +
          ((gen.brief.site && gen.brief.site.design) ? ' Pages wear your site’s fonts and colour scheme.' : '') + '</p>' +
          '<div class="gh-status" id="lp-status"></div>'
        : '<p class="u-muted">Generate a batch of ads first — landing pages are built from them.</p>');
    Ads.modal({
      title: 'Landing pages', wide: true,
      body: body,
      foot: n
        ? [{ label: 'Close', act: 'cancel', ghost: true }, { label: 'Generate ' + n + ' page' + (n > 1 ? 's' : ''), act: 'gen', primary: true }]
        : [{ label: 'Close', act: 'cancel', ghost: true }],
      onMount: function (m) {
        bindLandingCopies(m, existing);
        var clr = m.querySelector('#lp-clear');
        if (clr) clr.addEventListener('click', function () {
          Ads.confirm({
            title: 'Clear ' + existing.length + ' saved landing page' + (existing.length > 1 ? 's' : '') + '?',
            message: 'Removes them from this project (older pages built before the redesign). Your ads are untouched — regenerate to build fresh per-ad pages.',
            danger: true, okLabel: 'Clear',
            onConfirm: function () {
              if (p) store.updateProject(p.id, { landings: [] });
              Ads.closeModal(); if (gen.projectId === (p && p.id)) { renderView(viewEl); openLandingModal(); }
              Ads.toast('Cleared saved landing pages');
            }
          });
        });
      },
      onAction: function (act, m) {
        if (act === 'cancel') return Ads.closeModal();
        if (act !== 'gen') return;
        if (gen.landingBuilding) { Ads.toast('A landing-page build is already running', true); return; }
        gen.landingBuilding = true;
        var btn = m.querySelector('[data-mact="gen"]');
        btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Building…';
        var statusEl = m.querySelector('#lp-status');
        function prog(done, total, headline) {
          if (statusEl) statusEl.innerHTML = '<span class="spinner"></span> Page ' + done + ' of ' + total + ' — ' + esc(String(headline).slice(0, 60));
        }
        var proj = ensureProject(), pid = proj.id;
        var d = currentDossier();
        var brand = (gen.brief.site && gen.brief.site.siteName) || store.getBrand().name;
        // Older projects were scraped before we learned a site's fonts + colour
        // scheme — re-read the site so their landing pages actually wear it,
        // instead of falling back to the plain default. Best-effort + persisted.
        var siteUrl = gen.brief.url || (gen.brief.site && gen.brief.site.finalUrl) || '';
        var designStep = (gen.brief.site && !gen.brief.site.design && siteUrl)
          ? (function () {
              if (statusEl) statusEl.innerHTML = '<span class="spinner"></span> Reading the site’s fonts &amp; colours…';
              return ai.scrape(siteUrl).then(function (fresh) {
                if (fresh && fresh.design && gen.brief.site) { gen.brief.site.design = fresh.design; saveProject(); }
              }).catch(function () {});
            })()
          : Promise.resolve();
        // Every page = a unique per-ad OPENING (subhead + story continuing that
        // ad's promise) + ONE shared long-form "about us" body identical across
        // pages. The first call writes the shared body (about:true); openings
        // then stream in batches of 8, ≤3 in flight, so one failed batch only
        // costs its own hooks their opening (they degrade to fallback).
        function norm(h) { return String(h).toLowerCase().replace(/\s+/g, ' '); }
        var ctx = landingContext(d), voice = store.getBrand().voice || '';
        var sharedAbout = null;
        var contentStep = designStep.then(function () {
          if (!Ads._aiEnabled) return;
          var batches = [];
          for (var bi = 0; bi < hooks.length; bi += 8) batches.push(hooks.slice(bi, bi + 8));
          var doneB = 0;
          if (statusEl) statusEl.innerHTML = '<span class="spinner"></span> Writing your landing copy…';
          function runBatch(ch, wantAbout) {
            return ai.landingContent({
              pages: ch.map(function (g) { return { headline: g.headline, hook: g.hook }; }),
              context: ctx, brand: brand, voice: voice, about: wantAbout
            }).then(function (resp) {
              // only adopt an about that actually carries sections — an empty
              // one would silently disable the ask-again fallback below
              if (resp && resp.about && Array.isArray(resp.about.sections) && resp.about.sections.length && !sharedAbout) sharedAbout = resp.about;
              var arr = (resp && resp.pages) || [];
              ch.forEach(function (g, i) { if (arr[i]) g.content = arr[i]; });
            }).catch(function () {}).then(function () {
              doneB++;
              if (statusEl && batches.length > 1) statusEl.innerHTML = '<span class="spinner"></span> Writing your landing copy… (' + doneB + '/' + batches.length + ')';
            });
          }
          // the shared body must exist before anything renders, so batch 0 runs
          // alone; the rest pump ≤3 at a time (openings are small responses)
          return runBatch(batches[0], true).then(function () {
            var rest = batches.slice(1);
            if (!rest.length) return;
            return new Promise(function (resolve) {
              var next = 0, active = 0, CONC = 3, aboutPending = false;
              function pump() {
                if (next >= rest.length && active === 0) return resolve();
                while (active < CONC && next < rest.length) {
                  // if the shared body is still missing, exactly ONE in-flight
                  // batch asks for it again — never several at once (cost)
                  (function () {
                    var ask = !sharedAbout && !aboutPending;
                    if (ask) aboutPending = true;
                    runBatch(rest[next++], ask).then(function () {
                      if (ask) aboutPending = false;
                      active--; pump();
                    });
                  })();
                  active++;
                }
              }
              pump();
            });
          });
        });
        contentStep.then(function () {
          // stitch each ad's opening onto the shared about body
          var byHook = {};
          hooks.forEach(function (g) {
            if (!g.content && !sharedAbout) return;
            var o = g.content || {};
            byHook[norm(g.headline)] = {
              subhead: o.subhead || '',
              intro: o.story || '',
              sections: (sharedAbout && sharedAbout.sections) || [],
              closer: (sharedAbout && sharedAbout.closer) || null,
              cta: (sharedAbout && sharedAbout.closer && sharedAbout.closer.cta) || ''
            };
          });
          items.forEach(function (it) { it.content = byHook[norm(it.headline)] || null; });
          return Ads.landing.generate({
            items: items, projectId: pid,
            url: gen.brief.url || (gen.brief.site && gen.brief.site.finalUrl) || '',
            site: gen.brief.site, dossier: d, brandName: brand,
            images: imagePool().filter(function (u) { return placeholderImageURLs().indexOf(u) < 0; }),  // gallery + scheme source; NOT placeholder swatches
            placeholders: placeholderImageURLs(),   // never use these as a published page's hero/gallery
            track: { url: (store.getSettings().tracking || {}).url || '' },
            onProgress: prog
          });
        }).then(function (out) {
          gen.landingBuilding = false;
          if (!out.pages.length) throw new Error('No pages could be built — check that the ads have headlines');
          // merge: a rebuild replaces a page matched by slug OR by adKey. The
          // adKey is stable per ad but the slug tracks the headline, so an edited
          // headline yields a new slug — matching by adKey too drops the old
          // record (and its now-orphaned page row) instead of leaving a dead dup.
          var newKeys = {};
          out.pages.forEach(function (np) { (np.adKeys || []).forEach(function (k) { newKeys[k] = 1; }); });
          var prev = ((store.getProject(pid) || {}).landings || []).filter(function (l) {
            if (out.pages.some(function (np) { return np.slug === l.slug; })) return false;
            var lk = l.adKey ? [l.adKey] : (l.adKeys || []);
            return !lk.some(function (k) { return newKeys[k]; });
          });
          store.updateProject(pid, { landings: prev.concat(out.pages) });
          util.downloadBlob(out.zipBlob, 'landing-pages-' + util.todayISO() + '.zip');
          Ads.toast(out.pages.length + ' landing pages built — ZIP downloaded, pages saved to the project' +
            (out.failed && out.failed.length ? ' (' + out.failed.length + ' failed: ' + out.failed.join(', ').slice(0, 80) + ')' : ''), !!(out.failed && out.failed.length));
          if (gen.projectId === pid) {           // still on the same project → refresh UI
            Ads.closeModal();
            renderView(viewEl);
            openLandingModal();                  // re-open showing the saved list with live links
          }
        }).catch(function (e) {
          gen.landingBuilding = false;
          btn.disabled = false; btn.innerHTML = 'Generate ' + n + ' page' + (n > 1 ? 's' : '');
          if (statusEl) statusEl.innerHTML = '';
          Ads.toast(e.message, true);
        });
      }
    });
  }

  /* ===================== lightbox ======================================== */
  function openAdLightbox(s, idx) {
    var dom = briefLib.domain(gen.brief);
    var isVideo = s.kind === 'video';
    var typeRow = isVideo
      ? '<dt>Type</dt><dd>Motion video · 9:16 · ' + esc((s.motion || 'auto')) + '</dd>'
      : '<dt>Template</dt><dd>' + esc(T.tplById(s.template).label + ' · ' + (T.FORMATS[s.format] || {}).label) + '</dd>';
    var foot = [{ label: 'Edit ad', act: 'edit', ghost: true }, { label: 'Copy caption', act: 'cap', ghost: true }];
    if (isVideo) { foot.push({ label: 'Download video', act: 'dl', primary: true }); foot.push({ label: 'Frame', act: 'frame', ghost: true }); }
    else foot.push({ label: 'Download PNG', act: 'dl', primary: true });
    foot.push({ label: 'Close', act: 'close' });
    var lbCtrl = null;

    Ads.modal({
      title: s.name || 'Ad preview', xwide: true,
      body: '<div class="lb-grid">' +
          '<div class="lb-shell">' + devices.shell(gen.view, gen.platform, s, { domain: dom }) + '</div>' +
          '<div class="lb-side">' +
            '<div class="u-label" style="margin-bottom:.6rem">Caption (primary text)</div>' +
            '<div class="em-cap">' + esc(s.caption || '—') + '</div>' +
            '<div class="dl" style="margin-top:1.6rem">' +
              '<dt>Headline</dt><dd>' + esc(((s.headlineStart || '') + ' ' + (s.headlineHighlight || '')).trim()) + '</dd>' +
              '<dt>Description</dt><dd>' + esc(s.description || '—') + '</dd>' +
              '<dt>CTA</dt><dd>' + esc(s.cta || '—') + '</dd>' + typeRow +
              '<dt>Angle</dt><dd>' + esc(s.angle || '—') + '</dd>' +
            '</div>' +
            (isVideo ? '<div class="hint" style="margin-top:1.2rem">Short motion ad, made from your brand colour, image and copy. Records to ' + (Ads.video && Ads.video.supported() ? 'mp4/webm' : 'a still (recording unsupported here)') + '.</div>' : '') +
          '</div>' +
        '</div>',
      foot: foot,
      onAction: function (act) {
        if (act === 'close') { if (lbCtrl) lbCtrl.stop(); Ads.closeModal(); }
        else if (act === 'dl') render.downloadAuto(s).then(function (r) { Ads.toast((r && r.ext ? r.ext.toUpperCase() : '') + ' downloaded'); }).catch(function (e) { Ads.toast(e.message, true); });
        else if (act === 'frame') Ads.video.posterBlob(s).then(function (b) { util.downloadBlob(b, util.slug(s.name) + '-frame.png'); Ads.toast('Frame downloaded'); }).catch(function (e) { Ads.toast(e.message, true); });
        else if (act === 'cap') { try { navigator.clipboard.writeText(s.caption || ''); Ads.toast('Caption copied'); } catch (e) { Ads.toast('Could not copy', true); } }
        else if (act === 'edit') {
          if (lbCtrl) lbCtrl.stop();
          Ads.closeModal();
          editModal(s, { title: 'Edit ad', onSave: function (updated) {
            if (idx != null && gen.results[idx]) { gen.results[idx] = updated; refreshResults(); return; }
            // a SAVED ad opened via double-click: persist by savedId — this path
            // used to silently drop the edit (incl. applied clips) on the floor
            if (updated.savedId) {
              var p = currentProject(); if (!p) return;
              var found = false;
              var next = (p.savedAds || []).map(function (a) { if (a.savedId === updated.savedId) { found = true; return updated; } return a; });
              if (found) { store.updateProject(p.id, { savedAds: next }); refreshSaved(); Ads.toast('Saved ad updated'); }
            }
          } });
        }
      },
      onMount: function (m) {
        lbCtrl = devices.mountCreative(m.querySelector('.lb-shell'), s, { animate: true });
        if (lbCtrl) liveControllers.push(lbCtrl);
      }
    });
  }
  Ads.openAdLightbox = openAdLightbox;

  /* ===================== main view ======================================= */
  var autoOpened = false;   // reload → jump straight back into the last project
  function renderView(el) {
    viewEl = el;
    if (!autoOpened) {
      autoOpened = true;
      var last = lastProjectId();
      if (!gen.projectId && last && store.getProject(last)) { openProject(last); return; }
    }
    el.innerHTML = briefPanel() + dossierPanel() + researchPanel() + imagesPanel() + audiencePanel() + resultsSection() + savedSection();
    bindBrief(el);
    bindDossier(el);
    bindResearch(el);
    bindImages(el);
    bindAudience(el);
    bindResults(el);
    bindSaved(el);
    watchShelfVisibility();   // heal degenerate mounts the moment cells become visible
    syncGemStatus();   // fills in the inline Nano Banana key row once status is known
  }

  Ads.registerView('generator', {
    title: 'Ad Generator', mode: 'generator',
    // The AI on/off toggle is rendered globally in the topbar by app.js.
    render: renderView
  });

  Ads.gen = {
    editModal: editModal,
    openProject: openProject,
    newProject: startNewProject,
    addVideoFiles: addVideoFiles,       // programmatic upload (also used by tests)
    currentProjectId: function () { return gen.projectId; },
    // Back-compat: other modules "load a spec into the generator" → open the editor.
    load: function (spec) { editModal(clone(spec), { title: 'Edit ad', onSave: function () {} }); }
  };
})();
