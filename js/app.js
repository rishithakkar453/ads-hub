/* ============================================================================
   ADS HUB — app shell, routing, modals, shared chrome
   Two top-level modes (Ad Generator / Ad Performance); each view module
   registers itself via Ads.registerView(id, def). Exposes window.Ads.app.
   ========================================================================== */
window.Ads = window.Ads || {};
Ads.views = Ads.views || {};
Ads.registerView = function (id, def) { Ads.views[id] = def; };

(function () {
  'use strict';
  var store = Ads.store, util = Ads.util, ai = Ads.ai;
  var esc = util.escapeHtml;

  /* ---- Icons ------------------------------------------------------------- */
  function ico(p, sw) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.6) + '" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
  var icons = {
    generator: ico('<path d="M12 3l2.1 5.5L20 9l-4.5 3.6L17 19l-5-3.2L7 19l1.5-6.4L4 9l5.9-.5z"/>'),
    performance: ico('<line x1="4" y1="20" x2="20" y2="20"/><rect x="5" y="11" width="3" height="7"/><rect x="11" y="6" width="3" height="12"/><rect x="17" y="13" width="3" height="5"/>'),
    single: ico('<rect x="4" y="4" width="16" height="16" rx="1"/>'),
    bulk: ico('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'),
    brand: ico('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/>'),
    settings: ico('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2l-.3-2.5H9l-.3 2.5a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.3 2.5h4l.3-2.5a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/>'),
    dashboard: ico('<rect x="3" y="3" width="8" height="10"/><rect x="13" y="3" width="8" height="6"/><rect x="13" y="12" width="8" height="9"/><rect x="3" y="16" width="8" height="5"/>'),
    ads: ico('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>'),
    compare: ico('<rect x="3" y="4" width="7" height="16"/><rect x="14" y="4" width="7" height="16"/>'),
    importd: ico('<path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M4 20h16"/>'),
    video: ico('<rect x="2.5" y="6" width="13.5" height="12" rx="1.6"/><path d="M16 10.5l5-2.6v8.2l-5-2.6z"/>'),
    image: ico('<rect x="3" y="4" width="18" height="14" rx="1"/><circle cx="8.5" cy="9" r="1.6"/><polyline points="4 17 9 12 13 15 17 11 20 14"/>'),
    sparkle: ico('<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/><path d="M18 15l.7 1.8L20.5 17.5l-1.8.7L18 20l-.7-1.8L15.5 17.5l1.8-.7z"/>'),
    globe: ico('<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"/>'),
    like: ico('<path d="M7 10v10H4V10h3zm0 0l4-7a2 2 0 0 1 3.8 1.2L14 9h4.5a2 2 0 0 1 2 2.5l-1.6 6.2A2.5 2.5 0 0 1 16.5 20H7"/>'),
    dislike: ico('<path d="M17 14V4h3v10h-3zm0 0l-4 7a2 2 0 0 1-3.8-1.2L10 15H5.5a2 2 0 0 1-2-2.5l1.6-6.2A2.5 2.5 0 0 1 7.5 4H17"/>'),
    download: ico('<path d="M12 4v11"/><polyline points="7 11 12 16 17 11"/><path d="M4 20h16"/>'),
    copy: ico('<rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
    trash: ico('<polyline points="4 7 20 7"/><path d="M7 7v12h10V7"/><path d="M10 7V4h4v3"/>'),
    edit: ico('<path d="M4 20h4L19 9l-4-4L4 16z"/><line x1="14" y1="6" x2="18" y2="10"/>'),
    check: ico('<polyline points="5 12 10 17 19 6"/>', 2),
    plus: ico('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', 1.8),
    close: ico('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>', 1.8),
    menu: ico('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>', 1.8),
    search: ico('<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>'),
    play: ico('<polygon points="7 5 19 12 7 19"/>'),
    pause: ico('<rect x="7" y="5" width="3.5" height="14"/><rect x="13.5" y="5" width="3.5" height="14"/>'),
    archive: ico('<rect x="3" y="4" width="18" height="5"/><path d="M5 9v11h14V9"/><line x1="10" y1="13" x2="14" y2="13"/>'),
    rocket: ico('<path d="M5 15c-1 1-1.5 4-1.5 4s3-.5 4-1.5"/><path d="M14 4c4 0 6 2 6 6 0 4-5 9-9 11l-4-4C9 13 14 8 14 4z"/><circle cx="14.5" cy="9.5" r="1.6"/>'),
    ext: ico('<path d="M14 4h6v6"/><line x1="20" y1="4" x2="11" y2="13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    info: ico('<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="7.6" r="0.6" fill="currentColor"/>')
  };
  Ads.icons = icons;

  var PARTISANS_LOGO =
    '<svg class="logo" viewBox="0 0 304.66 40.4" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="PARTISANS"><title>PARTISANS</title>' +
    '<path fill="currentColor" d="M184,389.87v-.22c0-8.33-5-13.1-15.73-13.1H153.38v39.2h11.18V402.53h4.22C178.49,402.53,184,398.09,184,389.87Zm-10.69.05c0,3.24-1.92,4.94-5.53,4.94h-3.24V385h3.29c3.51,0,5.48,1.37,5.48,4.72Z" transform="translate(-153.38 -376)"/>' +
    '<path fill="currentColor" d="M192.43,376.55l-12.56,39.2h10.48l2.08-7.3h13l2.09,7.3H219.4L207,376.55Zm2.19,24.17L199,385.65l4.28,15.07Z" transform="translate(-153.38 -376)"/>' +
    '<path fill="currentColor" d="M253.22,389.21V389c0-8.28-5.7-12.44-15.95-12.44H221.92v39.2H233.1v-14h2.63l8,14h11.84l-9.37-16.23C250.26,397.93,253.22,394.8,253.22,389.21Zm-10.85.44c0,3.18-1.87,4.77-5.65,4.77H233.1V385h3.67c3.62,0,5.6,1.26,5.6,4.44Z" transform="translate(-153.38 -376)"/>' +
    '<polygon fill="currentColor" points="101.68 9.21 111.82 9.21 111.82 39.75 123.11 39.75 123.11 9.21 141.7 9.21 141.7 31.21 135.6 31.21 135.6 39.83 157.6 39.83 157.6 31.21 151.46 31.21 151.46 9.21 157.6 9.21 157.6 0.55 101.68 0.55 101.68 9.21"/>' +
    '<path fill="currentColor" d="M330.67,391.19c-4.87-.66-6.08-1.65-6.08-3.84,0-2,1.53-3.35,4.55-3.35s4.66,1.43,5,4.23H344.6c-.71-8.28-6-12.23-15.46-12.23S314,381.15,314,388.23c0,7.89,3.73,11.18,14.81,12.49,4.71.72,6.19,1.38,6.19,3.79s-1.81,3.89-5,3.89c-4.66,0-5.92-2.3-6.2-5.1H313c.33,8.5,5.92,13.1,16.89,13.1,10.08,0,15.79-5.86,15.79-13C345.7,394.86,340.6,392.28,330.67,391.19Z" transform="translate(-153.38 -376)"/>' +
    '<path fill="currentColor" d="M357.44,376.55l-12.56,39.2h10.47l2.09-7.3h13l2.08,7.3h11.9L372,376.55Zm2.19,24.17L364,385.65l4.28,15.07Z" transform="translate(-153.38 -376)"/>' +
    '<polygon fill="currentColor" points="258.86 22.64 246.3 0.55 233.64 0.55 233.64 39.75 243.5 39.75 243.5 15.13 257.81 39.75 268.67 39.75 268.67 0.55 258.86 0.55 258.86 22.64"/>' +
    '<path fill="currentColor" d="M443,391.19c-4.88-.66-6.09-1.65-6.09-3.84,0-2,1.54-3.35,4.55-3.35s4.66,1.43,5,4.23h10.42c-.71-8.28-6-12.23-15.46-12.23s-15.18,5.15-15.18,12.23c0,7.89,3.72,11.18,14.8,12.49,4.71.72,6.19,1.38,6.19,3.79s-1.81,3.89-5,3.89c-4.66,0-5.92-2.3-6.2-5.1H425.36c.33,8.5,5.92,13.1,16.89,13.1,10.09,0,15.79-5.86,15.79-13C458,394.86,452.94,392.28,443,391.19Z" transform="translate(-153.38 -376)"/>' +
    '</svg>';

  /* ---- Modes / nav ------------------------------------------------------- */
  var MODES = [
    { id: 'generator', label: 'Ad Generator', short: 'Generator', sub: 'Create at scale', icon: icons.generator, views: [
      { id: 'generator', label: 'Generator', icon: icons.sparkle },
      { id: 'projects', label: 'My Projects', icon: icons.archive },
      { id: 'brand', label: 'Brand Kit', icon: icons.brand }
    ] },
    { id: 'performance', label: 'Ad Performance', short: 'Performance', sub: 'Track + optimize', icon: icons.performance, views: [
      { id: 'dashboard', label: 'Dashboard', icon: icons.dashboard },
      { id: 'rounds', label: 'Campaign Rounds', icon: icons.archive },
      { id: 'instagram', label: 'Instagram', icon: icons.rocket },
      { id: 'tracking', label: 'Live Tracking', icon: icons.globe },
      { id: 'ads', label: 'All Ads', icon: icons.ads },
      { id: 'compare', label: 'Compare', icon: icons.compare },
      { id: 'import', label: 'Import Data', icon: icons.importd },
      { id: 'settings', label: 'Targets', icon: icons.settings }
    ] }
  ];
  var VIEW_MODE = {};
  MODES.forEach(function (m) { m.views.forEach(function (v) { VIEW_MODE[v.id] = m.id; }); });

  var ui = { view: 'generator', sidebarOpen: false };
  // hasKey = server has a usable key (env or session); useAI = the user's toggle.
  var aiState = { hasKey: false, useAI: true, model: null, source: 'none' };
  function recomputeAI() { Ads._aiEnabled = aiState.hasKey && aiState.useAI; }
  function aiToggleHTML() {
    var on = aiState.hasKey && aiState.useAI;
    var title = on ? 'AI copywriter is ON — click to turn it off'
      : (aiState.hasKey ? 'AI is off — click to turn it on' : 'Click to add an API key and turn AI on');
    return '<button class="ai-toggle ' + (on ? 'is-on' : '') + '" data-action="ai:toggle" title="' + esc(title) + '" aria-pressed="' + on + '">' +
      '<span class="ait-track"><span class="ait-knob"></span></span>' +
      '<span class="ait-label">' + (on ? 'AI on' : 'AI off') + '</span>' +
    '</button>';
  }
  Ads.aiToggleHTML = aiToggleHTML;

  function currentMode() { return VIEW_MODE[ui.view] || 'generator'; }

  /* ---- Sidebar / topbar -------------------------------------------------- */
  function renderSidebar() {
    var mode = currentMode();
    var modeBtns = MODES.map(function (m) {
      return '<button class="mode-btn ' + (mode === m.id ? 'is-active' : '') + '" data-action="mode" data-mode="' + m.id + '">' + esc(m.short) + '</button>';
    }).join('');

    var activeMode = MODES.filter(function (m) { return m.id === mode; })[0];
    var counts = { ads: store.allAds().length, projects: (store.listProjects ? store.listProjects().length : 0) };
    var nav = activeMode.views.map(function (v) {
      var count = v.id === 'ads' ? counts.ads : (v.id === 'projects' && counts.projects ? counts.projects : '');
      return '<div class="nav-link ' + (ui.view === v.id ? 'is-active' : '') + '" data-action="nav" data-view="' + v.id + '">' +
        (v.icon || '') + '<span>' + esc(v.label) + '</span>' + (count !== '' ? '<span class="nav-count">' + count + '</span>' : '') + '</div>';
    }).join('');

    return '<aside class="sidebar ' + (ui.sidebarOpen ? 'is-open' : '') + '" id="sidebar">' +
      '<div class="sidebar-brand">' +
        '<a class="brand-logo" href="#/generator" data-action="nav" data-view="generator" aria-label="PARTISANS Ads Hub">' + PARTISANS_LOGO + '</a>' +
        '<span class="brand-sub">Ads Hub</span>' +
      '</div>' +
      '<div class="mode-switch">' + modeBtns + '</div>' +
      '<nav class="nav">' + nav + '</nav>' +
      '<div class="sidebar-foot">' +
        aiToggleHTML() +
        '<div class="btn-row">' +
          '<button class="btn is-ghost is-sm" data-action="data:export">Export</button>' +
          '<button class="btn is-ghost is-sm" data-action="data:import">Import</button>' +
        '</div>' +
        '<span class="meta">Saved in this browser + backed up to disk</span>' +
      '</div>' +
    '</aside>';
  }

  function renderTopbar() {
    var def = Ads.views[ui.view] || {};
    var title = typeof def.title === 'function' ? def.title() : (def.title || ui.view);
    var actions = typeof def.actions === 'function' ? def.actions() : '';
    return '<div class="topbar">' +
      '<button class="icon-btn menu-toggle" data-action="sidebar:toggle" aria-label="Menu">' + icons.menu + '</button>' +
      '<div><div class="breadcrumb">' + esc(MODES.filter(function (m) { return m.id === currentMode(); })[0].label) + '</div>' +
        '<div class="page-title">' + esc(title) + '</div></div>' +
      '<div class="topbar-spacer"></div>' +
      '<div class="topbar-actions">' + actions + aiToggleHTML() + '</div>' +
    '</div>';
  }

  /* ---- Main render ------------------------------------------------------- */
  function render() {
    var def = Ads.views[ui.view];
    if (!def) { ui.view = 'generator'; def = Ads.views.generator; }
    var app = document.getElementById('app');
    app.innerHTML = renderSidebar() +
      '<main class="main">' + renderTopbar() +
        '<div class="' + (def.flush ? 'view is-flush' : 'view') + '" id="view-body"></div>' +
      '</main>';
    var body = document.getElementById('view-body');
    try { def.render(body); } catch (e) { body.innerHTML = '<div class="notice warn"><strong>Render error:</strong> ' + esc(e.message) + '</div>'; console.error(e); }
  }

  function go(view) {
    if (!Ads.views[view]) return;
    ui.view = view; ui.sidebarOpen = false;
    if (location.hash !== '#/' + view) { history.replaceState(null, '', '#/' + view); }
    render();
  }
  Ads.go = go;
  // Editing is modal-first now: "open in generator" = open the full Edit modal.
  Ads.openInGenerator = function (spec) { Ads.gen.load(spec); };

  /* ---- Shell events ------------------------------------------------------ */
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action]');
    if (!t) return;
    var action = t.getAttribute('data-action');
    // Only handle shell-level actions here; views bind their own.
    if (action === 'mode') {
      var m = MODES.filter(function (x) { return x.id === t.getAttribute('data-mode'); })[0];
      if (m) go(m.views[0].id);
      e.preventDefault();
    } else if (action === 'nav') {
      go(t.getAttribute('data-view')); e.preventDefault();
    } else if (action === 'sidebar:toggle') {
      ui.sidebarOpen = !ui.sidebarOpen; render();
    } else if (action === 'data:export') {
      util.downloadText(store.exportJSON(), 'ads-hub-export-' + util.todayISO() + '.json', 'application/json');
      toast('Exported');
    } else if (action === 'data:import') {
      importData();
    } else if (action === 'ai:toggle') {
      toggleAI();
    } else if (action === 'modal:close') {
      closeModal();
    }
  });

  /* ---- AI on/off toggle -------------------------------------------------- */
  function toggleAI() {
    if (aiState.hasKey) {
      // key is present → just flip whether we use it (preference persists)
      aiState.useAI = !aiState.useAI;
      store.updateSettings({ useAI: aiState.useAI });
      recomputeAI();
      render();
      toast(aiState.useAI ? 'AI copywriter on' : 'AI copywriter off — using on-page copy');
    } else {
      openKeyModal();
    }
  }
  function openKeyModal() {
    modal({
      title: 'Turn on AI copywriter',
      body: '<p class="u-muted" style="margin-bottom:1.4rem">Paste your Anthropic API key once — it’s <strong>saved on this computer</strong> (ads-hub/data, never in the repo, never sent anywhere but Anthropic) and reloaded automatically every time the tool starts. You can forget it anytime from the Brand Kit page.</p>' +
        '<div class="field"><label>Anthropic API key</label>' +
        '<input class="input" type="password" id="ai-key" placeholder="sk-ant-..." autocomplete="off" spellcheck="false"></div>' +
        '<div class="hint">Create one at console.anthropic.com → Settings → API keys.</div>',
      foot: [{ label: 'Cancel', act: 'cancel', ghost: true }, { label: 'Turn on AI', act: 'save', primary: true }],
      onAction: function (act, el) {
        if (act === 'cancel') return closeModal();
        if (act === 'save') submitKey(el);
      },
      onMount: function (el) {
        var i = el.querySelector('#ai-key');
        if (i) { i.focus(); i.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitKey(el); } }); }
      }
    });
    function submitKey(el) {
      var key = el.querySelector('#ai-key').value.trim();
      if (!key) { toast('Paste a key first', true); return; }
      var btn = el.querySelector('[data-mact="save"]'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Enabling';
      ai.setKey(key).then(function (r) {
        if (r && r.enabled) {
          aiState.hasKey = true; aiState.source = r.source || 'session'; aiState.useAI = true;
          store.updateSettings({ useAI: true });
          recomputeAI(); closeModal(); render(); toast('AI copywriter on');
        } else { toast('Key not accepted', true); btn.disabled = false; btn.innerHTML = 'Turn on AI'; }
      }).catch(function (e) { toast(e.message, true); btn.disabled = false; btn.innerHTML = 'Turn on AI'; });
    }
  }

  /* ---- Toast ------------------------------------------------------------- */
  function toast(msg, isErr) {
    var root = document.getElementById('toast-root');
    var el = document.createElement('div'); el.className = 'toast' + (isErr ? ' is-err' : ''); el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () { el.style.transition = 'opacity 300ms'; el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 320); }, isErr ? 3600 : 2200);
  }
  Ads.toast = toast;

  /* ---- Modal ------------------------------------------------------------- */
  function closeModal() { var r = document.getElementById('modal-root'); r.innerHTML = ''; }
  Ads.closeModal = closeModal;

  // Generic content modal. opts: { title, wide|xwide, body(html), foot([{label,act,primary,ghost,danger}]), onMount(el), onAction(act, el) }
  function modal(opts) {
    var root = document.getElementById('modal-root');
    var foot = (opts.foot || []).map(function (b) {
      return '<button class="btn ' + (b.primary ? 'is-primary' : (b.ghost ? 'is-ghost' : '')) + (b.danger ? ' is-danger' : '') + '" data-mact="' + esc(b.act) + '">' + esc(b.label) + '</button>';
    }).join('');
    root.innerHTML = '<div class="modal-backdrop" data-mclose="1">' +
      '<div class="modal ' + (opts.xwide ? 'is-xwide' : (opts.wide ? 'is-wide' : '')) + '" role="dialog">' +
        '<div class="modal-head"><h3>' + esc(opts.title || '') + '</h3><button class="icon-btn" data-mclose="1">' + icons.close + '</button></div>' +
        '<div class="modal-body">' + (opts.body || '') + '</div>' +
        (foot ? '<div class="modal-foot">' + foot + '</div>' : '') +
      '</div></div>';
    var el = root.querySelector('.modal');
    root.querySelector('.modal-backdrop').addEventListener('click', function (e) { if (e.target.getAttribute('data-mclose')) closeModal(); });
    el.querySelectorAll('[data-mclose]').forEach(function (b) { b.addEventListener('click', closeModal); });
    if (opts.onAction) el.querySelectorAll('[data-mact]').forEach(function (b) {
      b.addEventListener('click', function () { opts.onAction(b.getAttribute('data-mact'), el); });
    });
    if (opts.onMount) opts.onMount(el);
    return el;
  }
  Ads.modal = modal;

  /* ---- Lightbox (open an image full-size) -------------------------------- */
  // Scroll to zoom (toward the cursor, up to 12×), drag to pan when zoomed,
  // double-click to zoom in / reset. Close: backdrop, ✕, or Esc.
  function lightbox(src, caption) {
    if (!src) return;
    var prev = document.getElementById('lightbox-root'); if (prev) prev.remove();
    var root = document.createElement('div');
    root.id = 'lightbox-root'; root.className = 'lightbox-backdrop';
    root.innerHTML = '<div class="lightbox">' +
      '<button class="lightbox-x" aria-label="Close">' + icons.close + '</button>' +
      '<img class="lightbox-img" src="' + src + '" alt="" draggable="false">' +
      (caption ? '<div class="lightbox-cap">' + esc(caption) + '</div>' : '') +
      '<div class="lightbox-hint">scroll to zoom · drag to pan · double-click to reset</div>' +
    '</div>';
    document.body.appendChild(root);
    var img = root.querySelector('.lightbox-img');
    img.style.transformOrigin = '0 0';
    var sc = 1, tx = 0, ty = 0, dragging = false, moved = false, lx = 0, ly = 0;
    function apply() {
      img.style.transform = (sc === 1 && !tx && !ty) ? '' : 'translate(' + tx + 'px,' + ty + 'px) scale(' + sc + ')';
      img.style.cursor = sc > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in';
    }
    // zoom about the cursor: keep the pixel under the pointer fixed in place
    function zoomAt(cx, cy, factor) {
      var ns = Math.min(12, Math.max(1, sc * factor));
      factor = ns / sc;
      if (factor !== 1) {
        var r = img.getBoundingClientRect();
        tx -= (cx - r.left) * (factor - 1);
        ty -= (cy - r.top) * (factor - 1);
        sc = ns;
      }
      if (sc === 1) { tx = 0; ty = 0; }
      apply();
    }
    root.addEventListener('wheel', function (e) { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
    img.addEventListener('dblclick', function (e) {
      if (sc > 1) { sc = 1; tx = ty = 0; apply(); } else zoomAt(e.clientX, e.clientY, 2.5);
    });
    img.addEventListener('mousedown', function (e) {
      if (sc <= 1) return;
      e.preventDefault(); dragging = true; moved = false; lx = e.clientX; ly = e.clientY; apply();
    });
    function onMove(e) {
      if (!dragging) return;
      tx += e.clientX - lx; ty += e.clientY - ly;
      if (Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly) > 2) moved = true;
      lx = e.clientX; ly = e.clientY; apply();
    }
    // `moved` also guards the click that lands right after a drag ends, so
    // releasing a pan over the backdrop can't accidentally close the viewer
    function onUp() { if (dragging) { dragging = false; apply(); setTimeout(function () { moved = false; }, 0); } }
    function close() {
      root.remove();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    root.addEventListener('click', function (e) {
      if (moved) return;
      if (e.target === root || (e.target.closest && e.target.closest('.lightbox-x'))) close();
    });
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    apply();
    return root;
  }
  Ads.lightbox = lightbox;

  // Form modal built on top of modal(). fields: [{name,label,type,options,default,min,max,step,hint,full}]
  function form(opts) {
    var fields = opts.fields || [], vals = opts.values || {};
    function fieldHtml(f) {
      var v = vals[f.name] != null ? vals[f.name] : (f.default != null ? f.default : '');
      var hint = f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '';
      var inner;
      if (f.type === 'textarea') inner = '<textarea class="textarea" name="' + f.name + '"' + (f.rows ? ' style="min-height:' + (f.rows * 2.2) + 'rem"' : '') + '>' + esc(v) + '</textarea>';
      else if (f.type === 'select') inner = '<select class="select" name="' + f.name + '">' + (f.options || []).map(function (o) { return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(v) ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select>';
      else if (f.type === 'color') inner = '<div class="color-field"><input type="color" name="' + f.name + '" value="' + esc(v || '#ff7a3c') + '"><input class="input" name="' + f.name + '_hex" value="' + esc(v || '#ff7a3c') + '"></div>';
      else inner = '<input class="input" type="' + (f.type || 'text') + '" name="' + f.name + '"' + (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + (f.step != null ? ' step="' + f.step + '"' : '') + ' value="' + esc(v) + '">';
      return '<div class="field">' + (f.label ? '<label>' + esc(f.label) + '</label>' : '') + inner + hint + '</div>';
    }
    var rows = fields.map(function (f) { return Array.isArray(f) ? '<div class="field-row">' + f.map(fieldHtml).join('') + '</div>' : fieldHtml(f); }).join('');
    return modal({
      title: opts.title, wide: opts.wide,
      body: '<form id="modal-form">' + rows + (opts.note ? '<div class="hint" style="margin-top:1rem">' + esc(opts.note) + '</div>' : '') + '</form>',
      foot: [{ label: 'Cancel', act: 'cancel', ghost: true }, { label: opts.submitLabel || 'Save', act: 'save', primary: true }],
      onMount: function (el) {
        // keep color picker + hex field in sync
        el.querySelectorAll('input[type=color]').forEach(function (ci) {
          var hx = el.querySelector('input[name="' + ci.name + '_hex"]');
          ci.addEventListener('input', function () { if (hx) hx.value = ci.value; });
          if (hx) hx.addEventListener('input', function () { if (/^#[0-9a-f]{6}$/i.test(hx.value)) ci.value = hx.value; });
        });
        var first = el.querySelector('input,textarea,select'); if (first) first.focus();
        el.querySelector('#modal-form').addEventListener('submit', function (e) { e.preventDefault(); submit(el); });
      },
      onAction: function (act, el) { if (act === 'cancel') closeModal(); else if (act === 'save') submit(el); }
    });
    function submit(el) {
      var data = {};
      fields.forEach(function (f) { (Array.isArray(f) ? f : [f]).forEach(function (ff) {
        var node = el.querySelector('[name="' + ff.name + '"]');
        if (node) data[ff.name] = ff.type === 'number' ? util.num(node.value) : node.value;
      }); });
      if (opts.onSubmit) opts.onSubmit(data, el);
    }
  }
  Ads.form = form;

  function confirm(opts) {
    modal({
      title: opts.title || 'Are you sure?',
      body: '<p class="u-muted">' + esc(opts.message || '') + '</p>',
      foot: [{ label: opts.cancelLabel || 'Cancel', act: 'cancel', ghost: true }, { label: opts.okLabel || 'Confirm', act: 'ok', primary: !opts.danger, danger: opts.danger }],
      onAction: function (act) { closeModal(); if (act === 'ok' && opts.onConfirm) opts.onConfirm(); }
    });
  }
  Ads.confirm = confirm;

  function importData() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = function () {
      var f = inp.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () { try { store.importJSON(r.result); toast('Imported'); render(); } catch (e) { toast(e.message, true); } };
      r.readAsText(f);
    };
    inp.click();
  }

  /* ---- Brand Kit + Targets views (registered here) ----------------------- */
  Ads.registerView('brand', {
    title: 'Brand Kit', mode: 'generator',
    render: function (el) {
      var b = store.getBrand();
      var fontOpts = Object.keys(Ads.templates.FONTS).map(function (k) { return '<option value="' + k + '"' + (b.font === k ? ' selected' : '') + '>' + esc(Ads.templates.FONTS[k].label) + '</option>'; }).join('');
      var bgOpts = Ads.templates.BACKGROUNDS.map(function (x) { return '<option value="' + x.id + '"' + (b.defaultBackground === x.id ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('');
      el.innerHTML =
        '<div class="grid cols-2" style="align-items:start">' +
          '<div class="card"><div class="card-head"><h3>Brand defaults</h3></div>' +
            '<div class="field"><label>Brand / product name</label><input class="input" id="b-name" value="' + esc(b.name) + '"></div>' +
            '<div class="field"><label>Accent colour</label><div class="color-field"><input type="color" id="b-accent" value="' + esc(b.accent) + '"><input class="input" id="b-accent-hex" value="' + esc(b.accent) + '"></div></div>' +
            '<div class="field-row">' +
              '<div class="field"><label>Default font</label><select class="select" id="b-font">' + fontOpts + '</select></div>' +
              '<div class="field"><label>Default background</label><select class="select" id="b-bg">' + bgOpts + '</select></div>' +
            '</div>' +
            '<div class="field"><label>Brand voice (used by AI copy)</label><textarea class="textarea" id="b-voice" placeholder="e.g. confident, plain-spoken, slightly playful; speaks to busy growth marketers">' + esc(b.voice || '') + '</textarea></div>' +
            '<div class="field"><label>Logo (optional)</label><div class="uploader-row"><div class="uploader" id="b-logo-up">' + icons.image + ' <span>' + (b.logo ? 'Replace logo' : 'Upload logo (PNG/SVG)') + '</span></div>' + (b.logo ? '<img class="thumb" src="' + b.logo + '">' : '') + '</div></div>' +
            '<div class="btn-row" style="margin-top:1rem"><button class="btn is-primary" id="b-save">Save brand kit</button>' + (b.logo ? '<button class="btn is-ghost" id="b-logo-clear">Remove logo</button>' : '') + '</div>' +
          '</div>' +
          '<div class="card"><div class="card-head"><h3>How it\'s used</h3></div>' +
            '<p class="u-muted">These defaults pre-fill every new ad and the bulk generator. The accent colour drives highlights, buttons and chart fills in your creatives. Brand voice is fed to the AI copywriter so generated headlines sound like you.</p>' +
            '<div class="notice" style="margin-top:1.4rem">' + (aiState.hasKey
              ? ('AI copy is <strong>available</strong> (' + esc(aiState.model || '') +
                 (aiState.source === 'saved' ? ', key saved on this computer' : (aiState.source === 'session' ? ', session key' : '')) + '). ' +
                 'Use the <strong>AI</strong> toggle, top-right, to switch it on/off.' +
                 (aiState.source === 'saved' ? ' <button class="btn is-ghost is-sm" id="b-key-forget" style="margin-left:0.8rem">Forget saved key</button>' : ''))
              : 'AI copy is <strong>off</strong>. Click the <strong>AI</strong> toggle (top-right) to paste a key — it\'s saved on this computer and survives restarts. Everything else works without it.') + '</div>' +
            '<div class="card-head" style="margin-top:2.4rem"><h3>Ad tracking</h3></div>' +
            '<p class="u-muted">Every downloaded ad gets a <strong>tracked link</strong> and every landing page carries a tiny beacon — clicks, time on page and click-throughs to your site land in <strong>Performance → Live Tracking</strong>. ' +
              'This runs right here on this computer; nothing to set up. Leave the URL below <strong>empty</strong> and it just works.</p>' +
            '<details style="margin-top:1rem"><summary class="u-faint" style="cursor:pointer">Advanced: point tracking at another address</summary>' +
              '<p class="u-muted" style="margin:0.8rem 0">Only needed if you serve the tracker somewhere other than this app (e.g. a tunnel or another machine). Enter its address, then regenerate landing pages.</p>' +
              '<div class="field"><label>Tracking URL</label>' +
                '<input class="input" id="b-track-url" placeholder="https://example.com" value="' + esc((store.getSettings().tracking || {}).url || '') + '"></div>' +
              '<div class="btn-row"><button class="btn is-sm" id="b-track-save">Save</button>' +
                '<button class="btn is-ghost is-sm" id="b-track-test">Test collector</button></div>' +
              '<div class="hint" id="b-track-state" style="margin-top:0.8rem"></div>' +
            '</details>' +
            '<div class="card-head" style="margin-top:2.4rem"><h3>Image generation — Nano Banana</h3></div>' +
            '<p class="u-muted">The <strong>Generate relevant images</strong> panel can render real photos with Google’s <strong>Nano Banana</strong> (Gemini 2.5 Flash Image). Paste a Google AI Studio API key — it’s saved on this computer (never in the repo), same as your Anthropic key. Get one free at <strong>aistudio.google.com/apikey</strong>. Without it you still get concept previews. Billed by Google (~$0.04/image).</p>' +
            '<div class="field" style="margin-top:1rem"><label>Google Gemini API key</label>' +
              '<input class="input" type="password" id="b-gem-key" placeholder="AIza… (paste to enable, leave blank to keep current)" autocomplete="off" spellcheck="false"></div>' +
            '<div class="btn-row"><button class="btn is-sm" id="b-gem-save">Save key</button>' +
              '<button class="btn is-ghost is-sm" id="b-gem-forget">Forget key</button></div>' +
            '<div class="hint" id="b-gem-state" style="margin-top:0.8rem"></div>' +
            // Instagram connection lives on its own page: Performance → Instagram
            '<p class="u-muted" style="margin-top:2.4rem">Instagram direct posting moved to <strong>Performance → Instagram</strong>.</p>' +
          '</div>' +
        '</div>';
      var accent = el.querySelector('#b-accent'), accentHex = el.querySelector('#b-accent-hex');
      accent.addEventListener('input', function () { accentHex.value = accent.value; });
      accentHex.addEventListener('input', function () { if (/^#[0-9a-f]{6}$/i.test(accentHex.value)) accent.value = accentHex.value; });
      el.querySelector('#b-logo-up').addEventListener('click', function () { pickImage(function (durl) { store.updateBrand({ logo: durl }); render(); }); });
      if (el.querySelector('#b-logo-clear')) el.querySelector('#b-logo-clear').addEventListener('click', function () { store.updateBrand({ logo: null }); render(); });
      el.querySelector('#b-save').addEventListener('click', function () {
        store.updateBrand({ name: el.querySelector('#b-name').value, accent: accent.value, font: el.querySelector('#b-font').value, defaultBackground: el.querySelector('#b-bg').value, voice: el.querySelector('#b-voice').value });
        toast('Brand kit saved');
      });
      el.querySelector('#b-track-save').addEventListener('click', function () {
        var u = el.querySelector('#b-track-url').value.trim().replace(/\/+$/, '');
        if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return toast('That doesn\'t look like a URL (needs http:// or https://)', true);
        store.updateSettings({ tracking: { url: u } });
        toast(u ? 'Tracking URL saved — regenerate landing pages so they report to it' : 'Tracking URL cleared — links stay local to this computer');
      });
      el.querySelector('#b-track-test').addEventListener('click', function () {
        var st = el.querySelector('#b-track-state');
        var base = (el.querySelector('#b-track-url').value.trim() || window.location.origin).replace(/\/+$/, '');
        st.innerHTML = '<span class="spinner"></span> Checking ' + esc(base) + '…';
        fetch(base + '/api/track/health').then(function (r) { return r.json(); }).then(function (j) {
          st.textContent = j && j.ok
            ? '✓ Collector reachable at ' + base + ' — ' + (j.ads || 0) + ' tracked ad' + (j.ads === 1 ? '' : 's') + ' registered' + (j.publicMode ? ' (public mode)' : '')
            : '✗ Unexpected reply from ' + base;
        }).catch(function () { st.textContent = '✗ No collector answering at ' + base; });
      });
      // Nano Banana (Gemini) image key
      var gemState = el.querySelector('#b-gem-state');
      function refreshGemState() {
        if (!gemState) return;
        ai.geminiStatus().then(function (g) {
          if (g && g.enabled && g.ok === false) {
            gemState.innerHTML = '<strong style="color:var(--danger,#e5484d)">⚠ Google is blocking this key.</strong> ' + esc(g.error || 'It can’t call the Gemini API.') +
              ' This is a restriction on the key, not Ads Hub — create a fresh key at aistudio.google.com/apikey (choose “in a new project”), or set the key’s API restrictions to “Don’t restrict key” and Application restrictions to “None”.';
          } else if (g && g.enabled) {
            gemState.textContent = '✓ Nano Banana is on (' + (g.model || 'gemini') + (g.source === 'saved' ? ', key saved on this computer' : g.source === 'env' ? ', from environment' : '') + '). The Generate images panel will render real photos.';
          } else {
            gemState.textContent = 'Nano Banana is off — the Generate images panel makes concept previews. Paste a key to render real photos.';
          }
        });
      }
      refreshGemState();
      var gemSave = el.querySelector('#b-gem-save');
      if (gemSave) gemSave.addEventListener('click', function () {
        var k = el.querySelector('#b-gem-key').value.trim();
        if (!k) { toast('Paste a Google Gemini API key first', true); return; }
        gemState.innerHTML = '<span class="spinner"></span> Saving & checking with Google…';
        ai.setGeminiKey(k).then(function (resp) {
          el.querySelector('#b-gem-key').value = '';
          if (resp && (resp.ok === false || resp.verified === false)) toast('Key saved, but Google is blocking it: ' + (resp.error || 'restricted key'), true);
          else toast('Nano Banana key saved and verified — image generation is on');
          refreshGemState();
        }).catch(function (e) { toast(e.message, true); refreshGemState(); });
      });
      var gemForget = el.querySelector('#b-gem-forget');
      if (gemForget) gemForget.addEventListener('click', function () {
        confirm({
          title: 'Forget the Nano Banana key?', message: 'Image generation falls back to concept previews until you paste a key again.',
          danger: true, okLabel: 'Forget key',
          onConfirm: function () { ai.setGeminiKey('').then(function () { toast('Nano Banana key forgotten'); refreshGemState(); }).catch(function (e) { toast(e.message, true); }); }
        });
      });
      var kf = el.querySelector('#b-key-forget');
      if (kf) kf.addEventListener('click', function () {
        confirm({
          title: 'Forget the saved API key?', message: 'AI copy will turn off until you paste a key again.',
          danger: true, okLabel: 'Forget key',
          onConfirm: function () {
            ai.setKey('').then(function () { aiState.hasKey = false; aiState.source = 'none'; recomputeAI(); render(); toast('Saved key forgotten'); })
              .catch(function (e) { toast(e.message, true); });
          }
        });
      });
    }
  });

  Ads.registerView('settings', {
    title: 'Performance Targets', mode: 'performance',
    render: function (el) {
      var s = store.getSettings();
      el.innerHTML = '<div class="grid cols-2" style="align-items:start">' +
        '<div class="card"><div class="card-head"><h3>Targets &amp; benchmarks</h3></div>' +
          '<p class="u-muted" style="margin-bottom:1.6rem">These drive the optimisation insights on every ad — “scale”, “pause”, “weak hook”, etc.</p>' +
          '<div class="field"><label>Currency symbol</label><input class="input" id="s-cur" value="' + esc(s.currency) + '" style="max-width:8rem"></div>' +
          '<div class="field-row">' +
            '<div class="field"><label>CTR target (%)</label><input class="input" type="number" step="0.1" id="s-ctr" value="' + esc(s.ctrTarget) + '"></div>' +
            '<div class="field"><label>CPA target</label><input class="input" type="number" step="1" id="s-cpa" value="' + esc(s.cpaTarget) + '"></div>' +
            '<div class="field"><label>ROAS target (×)</label><input class="input" type="number" step="0.1" id="s-roas" value="' + esc(s.roasTarget) + '"></div>' +
          '</div>' +
          '<div class="btn-row"><button class="btn is-primary" id="s-save">Save targets</button></div>' +
        '</div>' +
        '<div class="card"><div class="card-head"><h3>Data</h3></div>' +
          '<p class="u-muted">All ads + metrics live in this browser and are auto-backed-up to <strong>ads-hub/data/store.json</strong> on the server. Export a JSON file to move it elsewhere.</p>' +
          '<div class="btn-row" style="margin-top:1.4rem">' +
            '<button class="btn is-sm" data-action="data:export">Export JSON</button>' +
            '<button class="btn is-ghost is-sm" data-action="data:import">Import JSON</button>' +
            '<button class="btn is-ghost is-sm" id="s-reset">Reset to sample</button>' +
          '</div>' +
        '</div>' +
      '</div>';
      el.querySelector('#s-save').addEventListener('click', function () {
        store.updateSettings({ currency: el.querySelector('#s-cur').value || '$', ctrTarget: util.num(el.querySelector('#s-ctr').value), cpaTarget: util.num(el.querySelector('#s-cpa').value), roasTarget: util.num(el.querySelector('#s-roas').value) });
        toast('Targets saved'); render();
      });
      el.querySelector('#s-reset').addEventListener('click', function () {
        confirm({ title: 'Reset everything?', message: 'This replaces all ads + metrics with the sample portfolio.', danger: true, okLabel: 'Reset', onConfirm: function () { store.reset(); toast('Reset'); render(); } });
      });
    }
  });

  // Shared image picker helper for views.
  function pickImage(cb) {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = function () { var f = inp.files[0]; if (!f) return; util.fileToDataURL(f).then(cb); };
    inp.click();
  }
  Ads.pickImage = pickImage;

  /* ---- Boot -------------------------------------------------------------- */
  function boot() {
    var hash = (location.hash || '').replace(/^#\//, '');
    if (Ads.views[hash]) ui.view = hash;
    aiState.useAI = store.getSettings().useAI !== false; // default on
    recomputeAI();
    render();
    ai.status().then(function (s) {
      aiState.hasKey = !!s.enabled; aiState.model = s.model; aiState.source = s.source || (s.enabled ? 'env' : 'none');
      recomputeAI();
      render();
    });
  }

  window.addEventListener('hashchange', function () {
    var hash = (location.hash || '').replace(/^#\//, '');
    if (Ads.views[hash] && hash !== ui.view) { ui.view = hash; render(); }
  });

  store.init().then(boot).catch(function (e) {
    document.getElementById('app').innerHTML = '<div class="view"><div class="notice warn"><strong>Failed to start:</strong> ' + esc(e.message) + '</div></div>';
  });

  Ads.app = { render: render, go: go };
})();
