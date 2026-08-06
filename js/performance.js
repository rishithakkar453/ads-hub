/* ============================================================================
   ADS HUB — performance views
   Dashboard (KPIs + leaderboards + optimisation insights), All Ads table,
   ad detail (metric editor + status + insights), Compare, CSV import.
   Exposes window.Ads.perf.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var store = Ads.store, util = Ads.util, C = Ads.compute, charts = Ads.charts, render = Ads.render, T = Ads.templates;
  // resolved lazily: ai.js may load after this file
  function ai() { return Ads.ai; }
  var esc = util.escapeHtml;
  var icons = function () { return Ads.icons; };
  function sym() { return store.getSettings().currency || '$'; }
  function fm(key, v) { return C.fmtMetric(key, v, sym()); }
  // Static thumbnail for posts; a motion-video poster frame for video ads.
  function thumbFor(el, ad, w, h) {
    if (ad.kind === 'video' && Ads.video) Ads.video.mount(el, ad, false);
    else render.thumb(el, ad, w, h);
  }
  // Mount a thumb so it FITS a maxW×maxH box: tall formats (9:16 video) get a
  // second, narrower pass instead of blowing the card open.
  function mountThumbFitted(el, ad, maxW, maxH) {
    el.style.width = maxW + 'px';
    thumbFor(el, ad, maxW, null);
    var h = el.offsetHeight || (el.firstChild && el.firstChild.offsetHeight) || 0;
    if (h > maxH && h > 0) {
      var w2 = Math.max(80, Math.floor(maxW * maxH / h));
      el.style.width = w2 + 'px';
      thumbFor(el, ad, w2, null);
    }
  }

  var STATUS = [
    { id: 'draft', label: 'Draft' }, { id: 'approved', label: 'Approved' }, { id: 'active', label: 'Active' },
    { id: 'paused', label: 'Paused' }, { id: 'archived', label: 'Archived' }
  ];
  function statusPill(s) { return '<span class="status-pill pill s-' + s + '"><span class="dot s-' + s + '"></span>' + (STATUS.filter(function (x) { return x.id === s; })[0] || { label: s }).label + '</span>'; }

  /* ===================== DASHBOARD ====================================== */
  Ads.registerView('dashboard', {
    title: 'Performance Dashboard', mode: 'performance',
    actions: function () { return '<button class="btn is-sm" data-action="nav" data-view="generator"><span class="btn-ico">' + icons().plus + '</span> New ad</button>'; },
    render: function (el) {
      var ads = store.allAds();
      if (!ads.length) return empty(el, 'No ads yet', 'Approve ads from the generator to start tracking performance.');
      var pf = C.portfolio(ads), b = pf.bench, s = store.getSettings(), t = pf.totals;
      var withData = ads.filter(C.hasData);
      var byStatus = {}; ads.forEach(function (a) { byStatus[a.status] = (byStatus[a.status] || 0) + 1; });
      var pins = C.portfolioInsights(ads, b, s);

      var kpis = '<div class="grid cols-4 view-section">' +
        kpi('Total spend', fm('spend', t.spend), withData.length + ' ads with data', true) +
        kpi('Conversions', util.fmtNum(t.conversions, 0), 'CPA ' + fm('cpa', t.cpa)) +
        kpi('Blended ROAS', t.roas != null ? t.roas.toFixed(2) + '×' : '—', 'Target ' + s.roasTarget + '×') +
        kpi('Avg CTR', fm('ctr', t.ctr), 'CPC ' + fm('cpc', t.cpc)) +
        '</div>';

      // leaderboards
      var rated = withData.map(function (a) { return { a: a, d: C.derive(a) }; });
      var byRoas = rated.slice().filter(function (x) { return x.d.roas != null; }).sort(function (x, y) { return y.d.roas - x.d.roas; });
      var bySpend = rated.slice().sort(function (x, y) { return (y.d.spend || 0) - (x.d.spend || 0); });

      var roasChart = charts.barsH(byRoas.slice(0, 8).map(function (x) { return { label: x.a.name, value: x.d.roas, display: x.d.roas.toFixed(2) + '×', cls: x.d.roas >= s.roasTarget ? 'good' : 'bad' }; }), { width: 560, labelW: 200 });
      var spendChart = charts.barsH(bySpend.slice(0, 8).map(function (x) { return { label: x.a.name, value: x.d.spend, display: fm('spend', x.d.spend) }; }), { width: 560, labelW: 200 });

      var insightCards =
        insightGroup('good', 'Scale', pins.scale, 'Strong ROAS — push more budget.') +
        insightGroup('bad', 'Pause / rework', pins.pause, 'Underperforming — cut or rebuild.') +
        insightGroup('warn', 'Refresh', pins.fatigue, 'Fatiguing — swap the creative.');

      el.innerHTML = kpis +
        '<div class="grid cols-2 view-section" style="align-items:start">' +
          '<div class="card"><div class="card-head"><h3>ROAS by ad</h3><span class="card-action u-label">vs ' + s.roasTarget + '× target</span></div>' + (byRoas.length ? roasChart : muted('No conversion-value data yet.')) + '</div>' +
          '<div class="card"><div class="card-head"><h3>Spend by ad</h3></div>' + (bySpend.length ? spendChart : muted('No spend logged yet.')) + '</div>' +
        '</div>' +
        '<div class="view-section"><div class="section-head"><h2>What to do next</h2><span class="u-label">rules-based</span></div>' +
          '<div class="grid cols-3" style="align-items:start">' + insightCards + '</div>' +
        '</div>' +
        '<div class="view-section"><div class="section-head"><h2>All ads</h2><span class="section-action"><button class="btn is-ghost is-sm" data-action="nav" data-view="ads">Open table</button></span></div>' +
          adsTable(ads.slice(0, 6)) + '</div>';
      bindAdLinks(el);
    }
  });

  function kpi(label, val, sub, feature) {
    return '<div class="kpi' + (feature ? ' is-feature' : '') + '"><span class="kpi-label">' + esc(label) + '</span><span class="kpi-value">' + val + '</span><span class="kpi-sub">' + esc(sub || '') + '</span></div>';
  }
  function muted(t) { return '<p class="u-muted" style="padding:1.5rem 0">' + esc(t) + '</p>'; }
  function insightGroup(sev, tag, ads, blurb) {
    var body = ads.length ? ads.slice(0, 5).map(function (a) {
      return '<div style="display:flex;align-items:center;gap:1rem;padding:.8rem 0;border-bottom:1px solid var(--line)"><span class="u-truncate" style="flex:1">' + esc(a.name) + '</span><button class="btn is-ghost is-sm" data-openad="' + a.id + '">Open</button></div>';
    }).join('') : '<p class="u-faint" style="font-size:1.2rem">Nothing here right now.</p>';
    return '<div class="card insight sev-' + sev + '" style="flex-direction:column;align-items:stretch"><div class="ins-tag" style="font-size:1.2rem;margin-bottom:.4rem">' + esc(tag) + ' · ' + ads.length + '</div><div class="u-muted" style="font-size:1.2rem;margin-bottom:.8rem">' + esc(blurb) + '</div>' + body + '</div>';
  }

  /* ===================== ALL ADS ======================================== */
  var adsUI = { q: '', status: '', sort: 'spend', dir: -1 };
  Ads.registerView('ads', {
    title: 'All Ads', mode: 'performance',
    actions: function () { return '<button class="btn is-sm" data-action="nav" data-view="generator"><span class="btn-ico">' + icons().plus + '</span> New ad</button>'; },
    render: function (el) {
      var ads = store.allAds();
      if (!ads.length) return empty(el, 'No ads yet', 'Create and approve ads in the generator.');
      var statusOpts = '<option value="">All statuses</option>' + STATUS.map(function (x) { return '<option value="' + x.id + '"' + (adsUI.status === x.id ? ' selected' : '') + '>' + x.label + '</option>'; }).join('');
      el.innerHTML = '<div class="toolbar">' +
        '<div class="search" style="min-width:24rem"><span class="ico">' + icons().search + '</span><input id="ads-q" placeholder="Search ads" value="' + esc(adsUI.q) + '" autocomplete="off"></div>' +
        '<span class="filter-select"><select class="select" id="ads-status">' + statusOpts + '</select></span>' +
        '<div class="toolbar-spacer"></div>' +
        '<span class="u-label" id="ads-count"></span>' +
      '</div><div id="ads-table"></div>';
      var q = el.querySelector('#ads-q');
      q.addEventListener('input', util.debounce(function () { adsUI.q = q.value; refresh(); }, 150));
      el.querySelector('#ads-status').addEventListener('change', function () { adsUI.status = this.value; refresh(); });
      refresh();
      function refresh() {
        var list = filterSort(store.allAds());
        el.querySelector('#ads-table').innerHTML = adsTable(list, true);
        el.querySelector('#ads-count').textContent = list.length + ' ads';
        bindAdLinks(el);
        el.querySelectorAll('th.sortable').forEach(function (th) { th.addEventListener('click', function () { var k = th.getAttribute('data-sort'); if (adsUI.sort === k) adsUI.dir *= -1; else { adsUI.sort = k; adsUI.dir = -1; } refresh(); }); });
      }
    }
  });

  function filterSort(ads) {
    var q = adsUI.q.toLowerCase();
    var list = ads.filter(function (a) { return (!adsUI.status || a.status === adsUI.status) && (!q || (a.name + ' ' + (a.angle || '')).toLowerCase().indexOf(q) >= 0); });
    list.sort(function (a, b) {
      var av, bv;
      if (adsUI.sort === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); return (av < bv ? -1 : av > bv ? 1 : 0) * adsUI.dir; }
      av = C.derive(a)[adsUI.sort]; bv = C.derive(b)[adsUI.sort];
      if (av == null) return 1; if (bv == null) return -1;
      return (av - bv) * adsUI.dir;
    });
    return list;
  }

  function adsTable(ads, sortable) {
    function th(key, label, cls) { return '<th class="' + (cls || '') + (sortable ? ' sortable' : '') + '" ' + (sortable ? 'data-sort="' + key + '"' : '') + '>' + label + (sortable && adsUI.sort === key ? ' <span class="arrow">' + (adsUI.dir < 0 ? '▾' : '▴') + '</span>' : '') + '</th>'; }
    var head = '<tr>' + th('name', 'Ad') + '<th>Status</th>' + th('spend', 'Spend', 'num') + th('impressions', 'Impr.', 'num') + th('ctr', 'CTR', 'num') + th('cpc', 'CPC', 'num') + th('conversions', 'Conv.', 'num') + th('cpa', 'CPA', 'num') + th('roas', 'ROAS', 'num') + '<th></th></tr>';
    var rows = ads.map(function (a) {
      var d = C.derive(a);
      return '<tr class="is-clickable" data-openad="' + a.id + '">' +
        '<td><div class="ad-cell"><div class="ad-thumb" data-thumb-ad="' + a.id + '"></div><div style="min-width:0"><div class="ac-name u-truncate">' + esc(a.name) + '</div><div class="u-faint" style="font-size:1.05rem">' + esc(T.tplById(a.template).label) + ' · ' + esc(a.angle || '—') + '</div></div></div></td>' +
        '<td>' + statusPill(a.status) + '</td>' +
        '<td class="num">' + fm('spend', d.spend) + '</td><td class="num">' + util.fmtCompact(d.impressions) + '</td>' +
        '<td class="num">' + fm('ctr', d.ctr) + '</td><td class="num">' + fm('cpc', d.cpc) + '</td>' +
        '<td class="num">' + util.fmtNum(d.conversions, 0) + '</td><td class="num">' + fm('cpa', d.cpa) + '</td>' +
        '<td class="num">' + (d.roas != null ? '<span class="' + (d.roas >= store.getSettings().roasTarget ? 'u-good' : 'u-bad') + '">' + d.roas.toFixed(2) + '×</span>' : '—') + '</td>' +
        '<td class="u-right"><div class="cell-actions"><button class="icon-btn" data-editmetrics="' + a.id + '" data-stop="1" title="Edit metrics">' + icons().edit + '</button></div></td>' +
      '</tr>';
    }).join('');
    return '<div class="table-wrap"><table class="tbl"><thead>' + head + '</thead><tbody>' + (rows || '<tr><td colspan="10" class="u-muted">No matches.</td></tr>') + '</tbody></table></div>';
  }

  // mount tiny thumbnails + wire row/open/edit clicks
  function bindAdLinks(scope) {
    scope.querySelectorAll('[data-thumb-ad]').forEach(function (n) { var a = store.getAd(n.getAttribute('data-thumb-ad')); if (a) thumbFor(n, a, 54, 54); });
    scope.querySelectorAll('[data-openad]').forEach(function (n) {
      n.addEventListener('click', function (e) { if (e.target.closest('[data-stop]')) return; openAd(n.getAttribute('data-openad')); });
    });
    scope.querySelectorAll('[data-editmetrics]').forEach(function (n) {
      n.addEventListener('click', function (e) { e.stopPropagation(); openAd(n.getAttribute('data-editmetrics'), true); });
    });
  }

  /* ===================== AD DETAIL ====================================== */
  function openAd(id, focusMetrics) {
    var a = store.getAd(id); if (!a) return;
    Ads.modal({
      title: a.name, xwide: true,
      body: '<div class="grid" style="grid-template-columns:40rem 1fr;gap:2.4rem;align-items:start">' +
          '<div>' +
            '<div class="ad-stage-frame" style="padding:1.4rem"><div class="ad-stage-scaler" id="det-preview"></div></div>' +
            '<div class="btn-row" style="margin-top:1.4rem">' +
              '<button class="btn is-sm" id="det-download"><span class="btn-ico">' + icons().download + '</span> PNG</button>' +
              '<button class="btn is-ghost is-sm" id="det-edit"><span class="btn-ico">' + icons().edit + '</span> Edit creative</button>' +
              '<button class="btn is-ghost is-sm" id="det-dup"><span class="btn-ico">' + icons().copy + '</span> Duplicate</button>' +
            '</div>' +
            '<div class="dl" style="margin-top:1.6rem">' +
              dlrow('Template', T.tplById(a.template).label + ' · ' + T.FORMATS[a.format].label) +
              dlrow('Objective', a.objective || '—') + dlrow('Audience', a.audience || '—') +
              dlrow('Created', util.fmtDate(a.createdAt)) +
            '</div>' +
            (a.caption ? '<div class="u-label" style="margin:1.6rem 0 .6rem">Caption (primary text)</div>' +
              '<div class="em-cap">' + esc(a.caption) + '</div>' +
              '<button class="btn is-ghost is-sm" id="det-cap" style="margin-top:.8rem">Copy caption</button>' : '') +
          '</div>' +
          '<div>' +
            '<div class="card-head"><h3>Status</h3></div>' +
            '<div class="btn-row" id="det-status" style="margin-bottom:2rem">' + statusButtons(a) + '</div>' +
            '<div class="card-head"><h3>Metrics</h3><span class="card-action u-label">enter what Meta reports</span></div>' +
            '<div class="metric-edit-grid" id="det-metrics">' + metricInputs(a) + '</div>' +
            '<div class="btn-row" style="margin:1.4rem 0 2rem"><button class="btn is-primary is-sm" id="det-save-metrics">Save metrics</button><button class="btn is-ghost is-sm" id="det-meta">Meta IDs</button></div>' +
            '<div class="card-head"><h3>Derived</h3></div>' +
            '<div class="metric-grid" id="det-derived">' + derivedCells(a) + '</div>' +
            '<div class="card-head" style="margin-top:2rem"><h3>Insights</h3></div>' +
            '<div class="insights" id="det-insights">' + insightList(a) + '</div>' +
          '</div>' +
        '</div>',
      foot: [{ label: 'Delete', act: 'delete', danger: true, ghost: true }, { label: 'Close', act: 'close' }],
      onAction: function (act) {
        if (act === 'close') Ads.closeModal();
        if (act === 'delete') Ads.confirm({ title: 'Delete ad?', message: a.name, danger: true, okLabel: 'Delete', onConfirm: function () { store.deleteAd(id); Ads.closeModal(); Ads.app.render(); } });
      },
      onMount: function (modalEl) {
        var dp = modalEl.querySelector('#det-preview');
        if (a.kind === 'video' && Ads.video) { dp.style.width = '300px'; Ads.video.mount(dp, a, true); } else render.mount(dp, a, 360);
        modalEl.querySelector('#det-download').addEventListener('click', function () { render.downloadAuto(a).then(function (r) { Ads.toast((r && r.ext ? r.ext.toUpperCase() : '') + ' downloaded'); }).catch(function (e) { Ads.toast(e.message, true); }); });
        modalEl.querySelector('#det-edit').addEventListener('click', function () {
          Ads.closeModal();
          Ads.gen.editModal(JSON.parse(JSON.stringify(a)), {
            title: 'Edit ad — ' + a.name,
            onSave: function (s) { store.updateAd(id, s); Ads.toast('Ad updated'); openAd(id); }
          });
        });
        if (modalEl.querySelector('#det-cap')) modalEl.querySelector('#det-cap').addEventListener('click', function () {
          try { navigator.clipboard.writeText(a.caption || ''); Ads.toast('Caption copied'); } catch (e) { Ads.toast('Could not copy', true); }
        });
        modalEl.querySelector('#det-dup').addEventListener('click', function () { var c = store.duplicateAd(id); Ads.closeModal(); Ads.toast('Duplicated'); openAd(c.id); });
        modalEl.querySelector('#det-meta').addEventListener('click', function () { metaIdsForm(id); });
        modalEl.querySelector('#det-save-metrics').addEventListener('click', function () { saveMetrics(id, modalEl); });
        modalEl.querySelectorAll('[data-setstatus]').forEach(function (b) { b.addEventListener('click', function () { store.setStatus(id, b.getAttribute('data-setstatus')); var a2 = store.getAd(id); modalEl.querySelector('#det-status').innerHTML = statusButtons(a2); modalEl.querySelectorAll('[data-setstatus]').forEach(reArm); Ads.toast('Status: ' + b.getAttribute('data-setstatus')); }); });
        if (focusMetrics) { var f = modalEl.querySelector('#det-metrics input'); if (f) f.focus(); }
        function reArm(b) { b.addEventListener('click', function () { store.setStatus(id, b.getAttribute('data-setstatus')); var a2 = store.getAd(id); modalEl.querySelector('#det-status').innerHTML = statusButtons(a2); modalEl.querySelectorAll('[data-setstatus]').forEach(reArm); }); }
      }
    });
  }
  Ads.perf = { openAd: openAd };

  function dlrow(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>'; }
  function statusButtons(a) {
    return STATUS.filter(function (x) { return x.id !== 'draft' || a.status === 'draft'; }).map(function (x) {
      return '<button class="btn is-sm ' + (a.status === x.id ? 'is-primary' : 'is-ghost') + '" data-setstatus="' + x.id + '">' + x.label + '</button>';
    }).join('');
  }
  function metricInputs(a) {
    return C.INPUT_METRICS.map(function (m) {
      var v = a.metrics[m.key]; v = v == null ? '' : v;
      return '<div class="field" style="margin:0"><label>' + esc(m.label) + (m.type === 'money' ? ' (' + sym() + ')' : '') + '</label><input class="input" data-metric="' + m.key + '" type="number" step="any" value="' + esc(v) + '"></div>';
    }).join('');
  }
  function derivedCells(a) {
    var d = C.derive(a);
    return C.METRICS.filter(function (m) { return !m.input; }).map(function (m) {
      return '<div class="metric-cell"><div class="mc-val">' + fm(m.key, d[m.key]) + '</div><div class="mc-label">' + esc(m.label) + '</div></div>';
    }).join('');
  }
  function insightList(a) {
    var ins = C.insights(a, C.portfolio(store.allAds()).bench, store.getSettings());
    if (!ins.length) return '<p class="u-muted">No flags — looks healthy.</p>';
    return ins.map(function (i) {
      return '<div class="insight sev-' + i.sev + '"><span class="ins-ico">' + (Ads.icons[i.sev === 'good' ? 'rocket' : i.sev === 'bad' ? 'pause' : 'info'] || Ads.icons.info) + '</span><div><div class="ins-tag">' + esc(i.tag) + '</div><div class="ins-body">' + i.body + '</div></div></div>';
    }).join('');
  }
  function saveMetrics(id, modalEl) {
    var m = {};
    modalEl.querySelectorAll('[data-metric]').forEach(function (inp) { m[inp.getAttribute('data-metric')] = util.num(inp.value); });
    store.setMetrics(id, m);
    var a = store.getAd(id);
    modalEl.querySelector('#det-derived').innerHTML = derivedCells(a);
    modalEl.querySelector('#det-insights').innerHTML = insightList(a);
    Ads.toast('Metrics saved');
  }
  function metaIdsForm(id) {
    var a = store.getAd(id);
    Ads.form({ title: 'Meta IDs & targeting', fields: [
      { name: 'campaign', label: 'Campaign ID', default: a.metaIds.campaign },
      { name: 'adset', label: 'Ad set ID', default: a.metaIds.adset },
      { name: 'ad', label: 'Ad ID', default: a.metaIds.ad },
      { name: 'audience', label: 'Audience / notes', type: 'textarea', default: a.audience }
    ], onSubmit: function (d) { store.updateAd(id, { metaIds: { campaign: d.campaign, adset: d.adset, ad: d.ad }, audience: d.audience }); Ads.closeModal(); Ads.toast('Saved'); } });
  }

  /* ===================== COMPARE ======================================== */
  var compareSel = [];
  Ads.registerView('compare', {
    title: 'Compare Ads', mode: 'performance',
    render: function (el) {
      var ads = store.allAds();
      if (!ads.length) return empty(el, 'Nothing to compare', 'Create ads first.');
      compareSel = compareSel.filter(function (id) { return store.getAd(id); });
      var picker = '<div class="card" style="margin-bottom:2rem"><div class="card-head"><h3>Pick 2–4 ads</h3><span class="card-action u-label">' + compareSel.length + ' selected</span></div>' +
        '<div class="grid cols-auto">' + ads.map(function (a) {
          var on = compareSel.indexOf(a.id) >= 0;
          return '<button class="opt-chip ' + (on ? 'is-active' : '') + '" data-cmp="' + a.id + '" style="text-align:left;align-items:flex-start;text-transform:none;letter-spacing:0">' + esc(a.name) + '</button>';
        }).join('') + '</div></div>';
      el.innerHTML = picker + '<div id="cmp-out"></div>';
      el.querySelectorAll('[data-cmp]').forEach(function (b) { b.addEventListener('click', function () {
        var id = b.getAttribute('data-cmp'), i = compareSel.indexOf(id);
        if (i >= 0) compareSel.splice(i, 1); else if (compareSel.length < 4) compareSel.push(id); else Ads.toast('Max 4', true);
        Ads.app.render();
      }); });
      renderCompare(el.querySelector('#cmp-out'));
    }
  });
  function renderCompare(out) {
    if (compareSel.length < 2) { out.innerHTML = '<div class="empty"><div class="empty-title">Select at least 2 ads</div></div>'; return; }
    var picked = compareSel.map(store.getAd);
    var metricsToShow = C.METRICS.filter(function (m) { return ['spend', 'impressions', 'ctr', 'cpc', 'cpm', 'conversions', 'cvr', 'cpa', 'roas'].indexOf(m.key) >= 0; });
    // best per metric
    var best = {};
    metricsToShow.forEach(function (m) {
      if (!m.dir) return;
      var vals = picked.map(function (a) { return C.derive(a)[m.key]; }).filter(function (v) { return v != null; });
      if (!vals.length) return;
      best[m.key] = m.dir === 'high' ? Math.max.apply(null, vals) : Math.min.apply(null, vals);
    });
    // winner = best ROAS (fallback CPA)
    var roasVals = picked.map(function (a) { return C.derive(a).roas; });
    var winIdx = -1, winVal = -Infinity;
    roasVals.forEach(function (v, i) { if (v != null && v > winVal) { winVal = v; winIdx = i; } });

    out.innerHTML = '<div class="compare-grid" style="grid-template-columns:repeat(' + picked.length + ',1fr)">' + picked.map(function (a, idx) {
      var d = C.derive(a);
      var rows = metricsToShow.map(function (m) {
        var v = d[m.key]; var isBest = m.dir && best[m.key] != null && v != null && v === best[m.key];
        return '<div class="compare-row"><span class="cr-label">' + esc(m.label) + '</span><span class="cr-val' + (isBest ? ' best' : '') + '">' + fm(m.key, v) + '</span></div>';
      }).join('');
      return '<div class="compare-col ' + (idx === winIdx ? 'is-winner' : '') + '">' +
        '<div class="cc-head"><div class="ad-thumb" data-thumb-ad="' + a.id + '" style="width:100%;height:120px;margin-bottom:1rem"></div>' +
          '<div style="font-family:var(--font-display);text-transform:uppercase;font-size:1.5rem;line-height:1.1">' + esc(a.name) + '</div>' +
          (idx === winIdx ? '<span class="tag" style="color:var(--good);border-color:var(--good);margin-top:.6rem">Best ROAS</span>' : '') + '</div>' +
        rows + '</div>';
    }).join('') + '</div>';
    out.querySelectorAll('[data-thumb-ad]').forEach(function (n) { var a = store.getAd(n.getAttribute('data-thumb-ad')); if (a) thumbFor(n, a, n.clientWidth || 240, 120); });
  }

  /* ===================== LIVE TRACKING ================================== */
  // The post-click funnel for POSTED ads, pulled from the tracking collector
  // (Stage 1): clicks on the tracked link, landing-page views + dwell time +
  // scroll, and click-throughs to the main site — plus spend the user enters,
  // giving cost-per-click and cost-per-site-visit, and an ad-vs-ad leaderboard.
  var trackUI = { sort: 'clicks', dir: -1 };
  function trackBase() {
    var t = store.getSettings().tracking || {};
    return String(t.url || window.location.origin).replace(/\/+$/, '');
  }
  function syncTracking(cb) {
    var base = trackBase();
    var headers = { 'X-Ads-Hub': '1' };
    var tok = (store.getSettings().tracking || {}).token;   // remote (office server) auth — Stage 3
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    fetch(base + '/api/track/stats', { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error('collector replied ' + r.status + (r.status === 403 ? ' (needs the sync token for a remote URL)' : '')); return r.json(); })
      .then(function (snap) { store.setTrackSnapshot(snap); cb(null, snap); })
      .catch(function (e) { cb(e); });
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m ? (m + 'm ' + (s < 10 ? '0' : '') + s + 's') : (s + 's');
  }
  // adKey → approved ad record (for a thumbnail + a link to the full ad detail)
  function adsByKey() { var m = {}; store.allAds().forEach(function (a) { if (a.adKey) m[a.adKey] = a; }); return m; }
  // one row per tracked ad: raw funnel + spend-derived cost efficiency
  function trackRows() {
    var t = store.getTracking(); var snap = t.snapshot; if (!snap || !snap.ads) return [];
    var spend = t.spend || {};
    return Object.keys(snap.ads).map(function (key) {
      var a = snap.ads[key] || {}; var sp = spend[key] != null ? util.num(spend[key]) : null;
      return {
        key: key, name: a.name || a.headline || key, headline: a.headline || '', page: a.page || '',
        clicks: a.clicks || 0, views: a.views || 0, uniques: a.uniques || 0,
        avgSeconds: a.avgSeconds || 0, scrollAvg: a.scrollAvg || 0, outs: a.outs || 0, outRate: a.outRate || 0,
        bySrc: a.bySrc || {}, spend: sp,
        viewRate: (a.clicks ? a.views / a.clicks : null),   // clicks that actually loaded the page
        cpc: (sp != null && a.clicks) ? sp / a.clicks : null,
        cps: (sp != null && a.outs) ? sp / a.outs : null    // cost per person who went on to the site
      };
    });
  }
  function srcChips(bySrc) {
    var keys = Object.keys(bySrc || {}); if (!keys.length) return '<span class="u-faint">—</span>';
    return keys.sort(function (a, b) { return bySrc[b] - bySrc[a]; }).slice(0, 5)
      .map(function (k) { return '<span class="src-chip">' + esc(k) + ' <b>' + bySrc[k] + '</b></span>'; }).join('');
  }
  function money(v) { return v == null ? '—' : util.fmtMoney(v, sym(), v >= 100 ? 0 : 2); }
  // re-render the whole tracking view (KPIs + callout + table) after a spend
  // change, preserving the scroll position. Works with the detail modal open —
  // the modal lives in a separate root, so only the background view rebuilds.
  function refreshTrackingView() {
    var main = document.querySelector('.main'); var y = main ? main.scrollTop : 0;
    Ads.go('tracking');
    var m2 = document.querySelector('.main'); if (m2) m2.scrollTop = y;
  }

  Ads.registerView('tracking', {
    title: 'Live Tracking', mode: 'performance',
    render: function (el) {
      var t = store.getTracking();
      var base = trackBase(), isLocal = !(store.getSettings().tracking || {}).url;
      var rows = trackRows();

      var head = '<div class="trk-head view-section">' +
        '<div><div><span class="u-label">Collector</span> <code class="trk-url">' + esc(base) + '</code>' +
          (isLocal ? ' <span class="u-faint">(running on this computer)</span>' : '') + '</div>' +
          '<div class="u-faint" id="trk-synced">' + (t.syncedAt ? 'Last synced ' + util.timeAgo(t.syncedAt) : 'Not synced yet') + '</div></div>' +
        '<button class="btn is-sm" id="trk-sync"><span class="btn-ico">' + icons().globe + '</span> Sync now</button>' +
      '</div>';

      if (!rows.length) {
        el.innerHTML = head + '<div class="empty"><div class="empty-title">No tracking data yet</div>' +
          '<div>Generate landing pages (which publishes them), post your ads with their tracked links, then hit <strong>Sync now</strong>. ' +
          'Clicks, time on page and click-throughs to your site will show up here per ad.</div>' +
          '<div class="btn-row" style="justify-content:center;margin-top:1.6rem"><button class="btn" id="trk-sync-empty"><span class="btn-ico">' + icons().globe + '</span> Sync now</button></div></div>';
        bindSync(el);
        return;
      }

      // portfolio totals across every tracked ad
      var tot = rows.reduce(function (o, r) {
        o.clicks += r.clicks; o.views += r.views; o.outs += r.outs; o.uniques += r.uniques;
        o.dwell += r.avgSeconds * r.uniques; o.spend += (r.spend || 0); return o;
      }, { clicks: 0, views: 0, outs: 0, uniques: 0, dwell: 0, spend: 0 });
      var blendAvg = tot.uniques ? tot.dwell / tot.uniques : 0;
      var anySpend = rows.some(function (r) { return r.spend != null; });

      var kpis = '<div class="grid cols-4 view-section">' +
        kpi('Link clicks', util.fmtNum(tot.clicks, 0), tot.views + ' opened the page', true) +
        kpi('Avg time on page', fmtDur(blendAvg), 'across ' + tot.uniques + ' visitors') +
        kpi('Went to your site', util.fmtNum(tot.outs, 0), (tot.views ? Math.round(100 * tot.outs / tot.views) : 0) + '% of visitors') +
        kpi('Total spend', money(tot.spend || null), anySpend ? (tot.outs ? money(tot.spend / tot.outs) + ' per site visit' : '—') : 'add spend below') +
      '</div>';

      // best performer callout: cheapest cost-per-site-visit if spend known,
      // else the most site-visits driven
      var ranked = rows.filter(function (r) { return r.cps != null; }).sort(function (a, b) { return a.cps - b.cps; });
      var best = ranked[0] || rows.slice().sort(function (a, b) { return b.outs - a.outs; })[0];
      var bestNote = best ? ('<div class="trk-best view-section"><span class="tag" style="color:var(--good);border-color:var(--good)">Top performer</span> ' +
        '<strong>' + esc(best.name) + '</strong> — ' + (best.cps != null ? money(best.cps) + ' per site visit' : best.outs + ' site visits') + '</div>') : '';

      el.innerHTML = head + kpis + bestNote +
        '<div class="view-section"><div class="section-head"><h2>Every ad, ranked</h2>' +
          '<span class="section-action"><button class="btn is-ghost is-sm" id="trk-spend-csv">Import spend (Meta CSV)</button></span></div>' +
          '<div id="trk-table"></div></div>';
      renderTable(el);
      bindSync(el);
      el.querySelector('#trk-spend-csv').addEventListener('click', function () { spendCsvModal(el); });
    }
  });

  function renderTable(el) {
    var rows = trackRows();
    // sort
    rows.sort(function (a, b) {
      var av, bv;
      if (trackUI.sort === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); return (av < bv ? -1 : av > bv ? 1 : 0) * trackUI.dir; }
      av = a[trackUI.sort]; bv = b[trackUI.sort];
      if (av == null) return 1; if (bv == null) return -1;
      return (av - bv) * trackUI.dir;
    });
    var byKey = adsByKey();
    function th(key, label, cls) {
      return '<th class="' + (cls || '') + ' sortable" data-tsort="' + key + '">' + label +
        (trackUI.sort === key ? ' <span class="arrow">' + (trackUI.dir < 0 ? '▾' : '▴') + '</span>' : '') + '</th>';
    }
    var head = '<tr>' + th('name', 'Ad') + '<th>Sources</th>' + th('clicks', 'Clicks', 'num') +
      th('views', 'Views', 'num') + th('uniques', 'Visitors', 'num') + th('avgSeconds', 'Avg time', 'num') +
      th('scrollAvg', 'Scroll', 'num') + th('outs', '→ Site', 'num') + th('outRate', 'CTR→site', 'num') +
      th('spend', 'Spend', 'num') + th('cpc', 'Cost/click', 'num') + th('cps', 'Cost/visit', 'num') + '</tr>';
    var body = rows.map(function (r) {
      var matched = byKey[r.key];
      return '<tr class="is-clickable" data-trkrow="' + esc(r.key) + '">' +
        '<td><div class="ad-cell">' + (matched ? '<div class="ad-thumb" data-thumb-ad="' + matched.id + '"></div>' : '<div class="ad-thumb trk-nothumb">' + icons().globe + '</div>') +
          '<div style="min-width:0"><div class="ac-name u-truncate">' + esc(r.name) + '</div>' +
          '<div class="u-faint" style="font-size:1.05rem">' + (r.page ? '/p/' + esc(r.page) : esc(r.headline)).slice(0, 60) + '</div></div></div></td>' +
        '<td class="trk-src">' + srcChips(r.bySrc) + '</td>' +
        '<td class="num">' + util.fmtNum(r.clicks, 0) + '</td>' +
        '<td class="num">' + util.fmtNum(r.views, 0) + '</td>' +
        '<td class="num">' + util.fmtNum(r.uniques, 0) + '</td>' +
        '<td class="num">' + fmtDur(r.avgSeconds) + '</td>' +
        '<td class="num">' + (r.scrollAvg ? r.scrollAvg + '%' : '—') + '</td>' +
        '<td class="num">' + util.fmtNum(r.outs, 0) + '</td>' +
        '<td class="num">' + (r.views ? Math.round(r.outRate * 100) + '%' : '—') + '</td>' +
        '<td class="num" data-stop="1"><span class="trk-spend-cell"><span class="trk-cur">' + esc(sym()) + '</span>' +
          '<input class="input trk-spend-input" data-spend="' + esc(r.key) + '" type="number" step="any" inputmode="decimal" value="' + (r.spend != null ? esc(r.spend) : '') + '" placeholder="0"></span></td>' +
        '<td class="num">' + money(r.cpc) + '</td>' +
        '<td class="num">' + money(r.cps) + '</td>' +
      '</tr>';
    }).join('');
    el.querySelector('#trk-table').innerHTML =
      '<div class="table-wrap"><table class="tbl trk-tbl"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';

    var scope = el.querySelector('#trk-table');
    scope.querySelectorAll('[data-thumb-ad]').forEach(function (n) { var a = store.getAd(n.getAttribute('data-thumb-ad')); if (a) thumbFor(n, a, 54, 54); });
    scope.querySelectorAll('th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-tsort');
        if (trackUI.sort === k) trackUI.dir *= -1; else { trackUI.sort = k; trackUI.dir = (k === 'name') ? 1 : -1; }
        renderTable(el);
      });
    });
    scope.querySelectorAll('.trk-spend-input').forEach(function (inp) {
      inp.addEventListener('click', function (e) { e.stopPropagation(); });
      inp.addEventListener('change', function () {
        store.setTrackSpend(inp.getAttribute('data-spend'), inp.value === '' ? null : util.num(inp.value));
        refreshTrackingView();   // KPI total + top-performer + derived columns stay consistent
      });
    });
    scope.querySelectorAll('[data-trkrow]').forEach(function (n) {
      n.addEventListener('click', function (e) { if (e.target.closest('[data-stop]')) return; trackDetail(n.getAttribute('data-trkrow')); });
    });
  }

  function bindSync(el) {
    function run(btn) {
      var old = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Syncing…'; }
      syncTracking(function (err) {
        if (btn) { btn.disabled = false; btn.innerHTML = old; }
        if (err) { Ads.toast('Sync failed: ' + err.message, true); return; }
        Ads.toast('Synced'); Ads.go('tracking');
      });
    }
    var s1 = el.querySelector('#trk-sync'); if (s1) s1.addEventListener('click', function () { run(s1); });
    var s2 = el.querySelector('#trk-sync-empty'); if (s2) s2.addEventListener('click', function () { run(s2); });
  }

  // per-ad funnel detail
  function trackDetail(key) {
    var r = trackRows().filter(function (x) { return x.key === key; })[0]; if (!r) return;
    var matched = adsByKey()[key];
    var funnel = charts.barsH([
      { label: 'Link clicks', value: r.clicks, display: util.fmtNum(r.clicks, 0) },
      { label: 'Opened page', value: r.views, display: util.fmtNum(r.views, 0) },
      { label: 'Unique visitors', value: r.uniques, display: util.fmtNum(r.uniques, 0) },
      { label: 'Went to site', value: r.outs, display: util.fmtNum(r.outs, 0), cls: 'good' }
    ], { width: 520, labelW: 150 });
    var srcRows = Object.keys(r.bySrc || {}).sort(function (a, b) { return r.bySrc[b] - r.bySrc[a]; })
      .map(function (k) { return '<div class="compare-row"><span class="cr-label">' + esc(k) + '</span><span class="cr-val">' + r.bySrc[k] + '</span></div>'; }).join('') || muted('No source tags — add ?s=fb / ?s=ig to the link per platform.');
    Ads.modal({
      title: r.name, wide: true,
      body: '<div class="grid cols-2" style="align-items:start;gap:2.4rem">' +
          '<div><div class="card-head"><h3>The funnel</h3></div>' + funnel +
            '<div class="metric-grid" style="margin-top:1.6rem">' +
              statCell('Avg time on page', fmtDur(r.avgSeconds)) +
              statCell('Avg scroll depth', r.scrollAvg ? r.scrollAvg + '%' : '—') +
              statCell('Click → page', r.viewRate != null ? Math.round(r.viewRate * 100) + '%' : '—') +
              statCell('Visitor → site', r.views ? Math.round(r.outRate * 100) + '%' : '—') +
            '</div>' +
          '</div>' +
          '<div><div class="card-head"><h3>Spend &amp; efficiency</h3></div>' +
            '<div class="field"><label>Amount spent promoting this ad (' + esc(sym()) + ')</label>' +
              '<input class="input" id="trk-det-spend" type="number" step="any" inputmode="decimal" value="' + (r.spend != null ? esc(r.spend) : '') + '" placeholder="0"></div>' +
            '<div class="metric-grid" id="trk-det-derived">' + detCosts(r) + '</div>' +
            '<div class="card-head" style="margin-top:2rem"><h3>By source</h3></div>' + srcRows +
            (matched ? '<div class="btn-row" style="margin-top:2rem"><button class="btn is-ghost is-sm" id="trk-open-ad">Open ad in performance</button></div>' : '') +
          '</div>' +
        '</div>',
      foot: [{ label: 'Close', act: 'close' }],
      onAction: function (act) { if (act === 'close') Ads.closeModal(); },
      onMount: function (m) {
        var sp = m.querySelector('#trk-det-spend');
        function liveVal() { return sp.value === '' ? null : util.num(sp.value); }
        // live feedback while typing — compute from the typed value, no store write
        sp.addEventListener('input', function () {
          m.querySelector('#trk-det-derived').innerHTML = costsFrom(r.clicks, r.views, r.outs, liveVal());
        });
        // commit + refresh the leaderboard/KPIs only on change (blur/enter), like
        // the inline table input — one store write, not one per keystroke, and the
        // background view stays consistent so closing the modal never leaves it stale
        sp.addEventListener('change', function () {
          store.setTrackSpend(key, liveVal());
          refreshTrackingView();
        });
        var oa = m.querySelector('#trk-open-ad');
        if (oa && matched) oa.addEventListener('click', function () { Ads.closeModal(); openAd(matched.id); });
      }
    });
  }
  function statCell(label, val) { return '<div class="metric-cell"><div class="mc-val">' + val + '</div><div class="mc-label">' + esc(label) + '</div></div>'; }
  // cost efficiency from an explicit spend (so the detail modal can show live
  // costs while typing without writing to the store)
  function costsFrom(clicks, views, outs, spend) {
    return statCell('Cost per click', money(spend != null && clicks ? spend / clicks : null)) +
      statCell('Cost per site visit', money(spend != null && outs ? spend / outs : null)) +
      statCell('Cost per page view', money(spend != null && views ? spend / views : null)) +
      statCell('Total spend', money(spend));
  }
  function detCosts(r) { return costsFrom(r.clicks, r.views, r.outs, r.spend); }

  // fill spend for many ads at once from a Meta CSV, matched by ad name
  function spendCsvModal(view) {
    Ads.modal({
      title: 'Import spend from a Meta CSV', wide: true,
      body: '<p class="u-muted" style="margin-bottom:1.4rem">Export from Meta Ads Manager and paste it here. We match rows to your tracked ads by <strong>ad name</strong> and fill in the <strong>Amount spent</strong> — everything else keeps coming from the live tracker.</p>' +
        '<div class="field"><label>Paste CSV</label><textarea class="textarea" id="trk-csv" style="min-height:10rem" placeholder="Ad name,Amount spent,...\nCumulus cloud storage · Image + Bar #1,42.10,..."></textarea></div>' +
        '<div id="trk-csv-out"></div>',
      foot: [{ label: 'Close', act: 'close', ghost: true }, { label: 'Match & fill', act: 'go', primary: true }],
      onAction: function (act, m) {
        if (act === 'close') return Ads.closeModal();
        if (act !== 'go') return;
        var text = m.querySelector('#trk-csv').value.trim();
        if (!text) { Ads.toast('Paste some CSV first', true); return; }
        var rows = util.parseCSV(text);
        if (!rows.length) { m.querySelector('#trk-csv-out').innerHTML = '<div class="notice warn">No rows found.</div>'; return; }
        var lower = {}; Object.keys(rows[0]).forEach(function (h) { lower[h.toLowerCase().trim()] = h; });
        function findCol(keys) { for (var i = 0; i < keys.length; i++) if (lower[keys[i]]) return lower[keys[i]]; return null; }
        var nameCol = findCol(['ad name', 'ad', 'name', 'creative name']) || Object.keys(rows[0])[0];
        var spendCol = findCol(CSV_MAP.spend);
        if (!spendCol) { m.querySelector('#trk-csv-out').innerHTML = '<div class="notice warn">No “Amount spent” column found.</div>'; return; }
        // tracked-ad names → adKey (from the last synced snapshot)
        var byName = {}; trackRows().forEach(function (r) { byName[r.name.toLowerCase().trim()] = r.key; });
        var n = 0;
        rows.forEach(function (row) {
          var nm = String(row[nameCol] || '').trim().toLowerCase(); var key = byName[nm];
          if (!key) return;
          // a blank / non-numeric "Amount spent" cell (common for paused or
          // zero-delivery ads) must NOT wipe spend the user already has — skip it
          var v = util.num(row[spendCol]);
          if (v == null) return;
          store.setTrackSpend(key, v); n++;
        });
        Ads.closeModal();
        Ads.toast(n ? 'Filled spend for ' + n + ' ad' + (n === 1 ? '' : 's') : 'No rows matched a tracked ad name (with a numeric spend)', !n);
        Ads.go('tracking');
      }
    });
  }

  /* ===================== CSV IMPORT ===================================== */
  // recognised Meta export headers → our metric keys
  var CSV_MAP = {
    spend: ['amount spent', 'amount spent (usd)', 'spend', 'cost'],
    impressions: ['impressions'],
    reach: ['reach'],
    frequency: ['frequency'],
    clicks: ['link clicks', 'clicks (all)', 'clicks', 'outbound clicks'],
    conversions: ['results', 'conversions', 'purchases', 'website purchases', 'leads'],
    convValue: ['purchase roas', 'conversion value', 'purchases conversion value', 'website purchases conversion value', 'value']
  };
  Ads.registerView('import', {
    title: 'Import Performance Data', mode: 'performance',
    render: function (el) {
      el.innerHTML = '<div class="grid cols-2" style="align-items:start">' +
        '<div class="card"><div class="card-head"><h3>Import a Meta CSV</h3></div>' +
          '<p class="u-muted" style="margin-bottom:1.4rem">Export from Meta Ads Manager (Reports → export as CSV), then drop it here. We match rows to your ads by <strong>ad name</strong> and update their metrics. Unmatched rows can be added as new ads.</p>' +
          '<div class="uploader" id="csv-up" style="padding:2.4rem">' + icons().importd + ' <span>Choose CSV file</span></div>' +
          '<div class="field" style="margin-top:1.6rem"><label>…or paste CSV</label><textarea class="textarea" id="csv-paste" style="min-height:8rem" placeholder="Ad name,Amount spent,Impressions,Link clicks,Results,..."></textarea></div>' +
          '<div class="btn-row"><button class="btn is-sm" id="csv-parse">Parse</button></div>' +
        '</div>' +
        '<div class="card"><div class="card-head"><h3>Tips</h3></div>' +
          '<ul class="u-muted" style="font-size:1.25rem;line-height:1.9;list-style:disc;padding-left:1.6rem">' +
            '<li>Name your Meta ads the same as here so they auto-match.</li>' +
            '<li>Recognised columns: spend, impressions, reach, frequency, link clicks, results/purchases, conversion value.</li>' +
            '<li>You can re-import any time — metrics overwrite.</li>' +
          '</ul></div>' +
      '</div><div id="csv-out" style="margin-top:2.4rem"></div>';
      el.querySelector('#csv-up').addEventListener('click', function () {
        var inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.csv,text/csv';
        inp.onchange = function () { var f = inp.files[0]; if (!f) return; var r = new FileReader(); r.onload = function () { handleCSV(el, r.result); }; r.readAsText(f); };
        inp.click();
      });
      el.querySelector('#csv-parse').addEventListener('click', function () { var t = el.querySelector('#csv-paste').value.trim(); if (t) handleCSV(el, t); else Ads.toast('Paste some CSV first', true); });
    }
  });

  function handleCSV(el, text) {
    var rows = util.parseCSV(text);
    if (!rows.length) { el.querySelector('#csv-out').innerHTML = '<div class="notice warn">No rows found.</div>'; return; }
    var headers = Object.keys(rows[0]);
    var lower = {}; headers.forEach(function (h) { lower[h.toLowerCase().trim()] = h; });
    function findCol(keys) { for (var i = 0; i < keys.length; i++) if (lower[keys[i]]) return lower[keys[i]]; return null; }
    var nameCol = findCol(['ad name', 'ad', 'name', 'creative name']) || headers[0];
    var cols = {}; Object.keys(CSV_MAP).forEach(function (k) { cols[k] = findCol(CSV_MAP[k]); });

    var ads = store.allAds(), byName = {}; ads.forEach(function (a) { byName[a.name.toLowerCase().trim()] = a; });
    var matched = [], unmatched = [];
    rows.forEach(function (r) {
      var nm = String(r[nameCol] || '').trim(); if (!nm) return;
      var metrics = {}; Object.keys(cols).forEach(function (k) { if (cols[k]) metrics[k] = util.num(r[cols[k]]); });
      var hit = byName[nm.toLowerCase()];
      (hit ? matched : unmatched).push({ name: nm, metrics: metrics, ad: hit });
    });

    var mapSummary = Object.keys(CSV_MAP).map(function (k) { return '<span class="tag" style="' + (cols[k] ? '' : 'opacity:.4') + '">' + esc(C.byKey(k).label) + (cols[k] ? ' ← ' + esc(cols[k]) : ' (none)') + '</span>'; }).join(' ');
    el.querySelector('#csv-out').innerHTML =
      '<div class="card"><div class="card-head"><h3>' + rows.length + ' rows · ' + matched.length + ' matched</h3></div>' +
        '<div style="margin-bottom:1.4rem;display:flex;gap:.6rem;flex-wrap:wrap">' + mapSummary + '</div>' +
        previewTable(matched, unmatched) +
        '<div class="btn-row" style="margin-top:1.6rem">' +
          '<button class="btn is-primary" id="csv-apply" ' + (matched.length ? '' : 'disabled') + '>Update ' + matched.length + ' matched ads</button>' +
          (unmatched.length ? '<button class="btn is-ghost" id="csv-add">Add ' + unmatched.length + ' new ads</button>' : '') +
        '</div>' +
      '</div>';
    if (matched.length) el.querySelector('#csv-apply').addEventListener('click', function () {
      matched.forEach(function (m) { store.setMetrics(m.ad.id, m.metrics); }); Ads.toast('Updated ' + matched.length + ' ads'); Ads.go('dashboard');
    });
    if (unmatched.length) el.querySelector('#csv-add').addEventListener('click', function () {
      store.addAds(unmatched.map(function (u) { return Object.assign(store.blankSpec(), { name: u.name, headlineStart: u.name }); }), { status: 'active' });
      // then set their metrics
      var fresh = store.allAds(); unmatched.forEach(function (u) { var a = fresh.filter(function (x) { return x.name === u.name; })[0]; if (a) store.setMetrics(a.id, u.metrics); });
      Ads.toast('Added ' + unmatched.length + ' ads'); Ads.go('ads');
    });
  }
  function previewTable(matched, unmatched) {
    function row(x, cls) { return '<tr><td>' + (cls === 'm' ? icons().check : '<span class="u-faint">+</span>') + '</td><td>' + esc(x.name) + '</td><td class="num">' + fm('spend', x.metrics.spend) + '</td><td class="num">' + util.fmtCompact(x.metrics.impressions) + '</td><td class="num">' + util.fmtNum(x.metrics.clicks, 0) + '</td><td class="num">' + util.fmtNum(x.metrics.conversions, 0) + '</td></tr>'; }
    var rows = matched.map(function (x) { return row(x, 'm'); }).concat(unmatched.slice(0, 30).map(function (x) { return row(x, 'u'); })).join('');
    return '<div class="table-wrap"><table class="tbl"><thead><tr><th></th><th>Ad name</th><th class="num">Spend</th><th class="num">Impr.</th><th class="num">Clicks</th><th class="num">Conv.</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function empty(el, title, sub) { el.innerHTML = '<div class="empty"><div class="empty-title">' + esc(title) + '</div><div>' + esc(sub) + '</div><div class="btn-row" style="justify-content:center;margin-top:1.6rem"><button class="btn" data-action="nav" data-view="generator">Open generator</button></div></div>'; }
  /* ===================== CAMPAIGN ROUNDS ================================= */
  // A folder per project; a round = the named batch of saved ads you post
  // together. Every ad gets platform-tagged tracked links (?s=ig/fb/tt/x) —
  // the collector already splits clicks, visits and time by that tag, so the
  // round view shows exactly where each visitor came from.
  var ROUND_PLATFORMS = [
    { id: 'ig', label: 'Instagram' }, { id: 'fb', label: 'Facebook' },
    { id: 'tt', label: 'TikTok' }, { id: 'x', label: 'X' }
  ];
  function projRounds(p) { return Array.isArray(p.rounds) ? p.rounds : []; }
  function savedByKey(p) { var m = {}; (p.savedAds || []).forEach(function (a) { if (a.adKey) m[a.adKey] = a; }); return m; }
  function landingKeys(p) {
    // only PUBLISHED landings count: an unpublished record means the /a/<key>
    // link was never registered with the collector and would 404 untracked
    var m = {};
    (p.landings || []).forEach(function (l) {
      if (!l.tracked) return;
      (l.adKeys || (l.adKey ? [l.adKey] : [])).forEach(function (k) { m[k] = l; });
    });
    return m;
  }
  function snapAds() { var t = store.getTracking(); return (t.snapshot && t.snapshot.ads) || {}; }

  var roundsOpenProject = null;   // project id while a folder is open as a page

  Ads.registerView('rounds', {
    title: function () {
      if (roundsOpenProject) { var p = store.getProject(roundsOpenProject); if (p) return '📁 ' + (p.name || 'Project'); }
      return 'Campaign Rounds';
    },
    mode: 'performance',
    render: function (el) {
      if (roundsOpenProject) {
        var open = store.getProject(roundsOpenProject);
        if (open) return renderFolderPage(el, open);
        roundsOpenProject = null;
      }
      var projects = store.listProjects();
      if (!projects.length) return empty(el, 'No projects yet', 'Create a project in the generator first.');
      el.innerHTML =
        '<div class="view-section"><p class="u-muted">One folder per project — open it to see every ad you’re posting and <strong>all its tracking data</strong> in one place. Group ads into <strong>rounds</strong>, post each with its platform link, and everything reports back here.</p></div>' +
        projects.map(function (p) {
          var rounds = projRounds(p);
          var adCount = rounds.reduce(function (n, r) { return n + r.adKeys.length; }, 0);
          return '<div class="view-section"><div class="rndf-card" data-folder="' + esc(p.id) + '">' +
            '<div class="rndf-info"><h2>📁 ' + esc(p.name || 'Project') + '</h2>' +
              '<span class="u-faint">' + rounds.length + ' round' + (rounds.length === 1 ? '' : 's') + ' · ' + adCount + ' ad' + (adCount === 1 ? '' : 's') + ' in rounds · ' + (p.savedAds || []).length + ' saved ads</span></div>' +
            '<button class="btn is-primary is-sm" data-folder-open="' + esc(p.id) + '">Open folder</button>' +
          '</div></div>';
        }).join('');
      el.querySelectorAll('[data-folder-open], .rndf-card').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          roundsOpenProject = b.getAttribute('data-folder-open') || b.getAttribute('data-folder');
          Ads.go('rounds');
        });
      });
    }
  });

  // the FOLDER PAGE — the main analytics surface: every ad in every round,
  // rendered in full, with its complete tracking picture and platform links
  function renderFolderPage(el, p) {
    var rounds = projRounds(p), byKey = savedByKey(p), lk = landingKeys(p), snap = snapAds();
    var t = store.getTracking(), spend = t.spend || {};
    var base = trackBase();
    function stat(v, l) { return '<span class="rndp-stat"><b>' + v + '</b><span>' + l + '</span></span>'; }
    var head = '<div class="view-section"><div class="btn-row">' +
      '<button class="btn is-ghost is-sm" id="rndf-back">← All folders</button>' +
      '<button class="btn is-ghost is-sm" id="rndf-sync">↻ Sync live stats</button>' +
      '<span class="u-faint" style="margin-left:auto">' + (t.syncedAt ? 'synced ' + esc(String(t.syncedAt).slice(0, 16).replace('T', ' ')) : 'stats not synced yet') + '</span>' +
      '<button class="btn is-sm" id="rndf-new">+ New round</button>' +
    '</div></div>';
    var sections = rounds.map(function (r) {
      var tot = { clicks: 0, views: 0, outs: 0, spend: 0, spendSet: false };
      var cards = r.adKeys.map(function (k) {
        var a = byKey[k]; var st = snap[k] || {};
        tot.clicks += st.clicks || 0; tot.views += st.views || 0; tot.outs += st.outs || 0;
        var sp = spend[k] != null ? util.num(spend[k]) : null;
        if (sp != null) { tot.spend += sp; tot.spendSet = true; }
        var outRate = st.views ? Math.round((st.outs || 0) / st.views * 100) : null;
        return '<div class="rndp-card">' +
          '<div class="rndp-thumb ad-stage-scaler" data-rt2="' + esc(k) + '"></div>' +
          '<div class="rndp-body">' +
            '<div class="rndp-name"><strong>' + esc(a ? (a.angle || a.name || k) : (k + ' (no longer saved)')) + '</strong>' +
              '<span class="u-faint"> · ' + (a ? (a.kind === 'video' ? 'video' : 'post') : '?') + (lk[k] ? '' : ' · ⚠ no landing page') + '</span></div>' +
            '<div class="rndp-stats">' +
              stat(st.clicks || 0, 'clicks') + stat(st.views || 0, 'visits') +
              stat(fmtDur(st.avgSeconds || 0), 'avg time') +
              stat(st.scrollAvg != null && st.views ? Math.round(st.scrollAvg) + '%' : '—', 'scroll') +
              stat((st.outs || 0) + (outRate != null ? ' (' + outRate + '%)' : ''), 'to site') +
            '</div>' +
            '<div class="rndp-srcrow">' + srcChips(st.bySrc) + '</div>' +
            '<div class="rndp-spend"><label>Spend ' + esc(sym()) + '</label>' +
              '<input class="input" data-spend="' + esc(k) + '" value="' + (sp != null ? sp : '') + '" placeholder="0" inputmode="decimal">' +
              (sp != null && st.clicks ? '<span class="u-faint">' + money(sp / st.clicks) + '/click</span>' : '') +
              (sp != null && st.outs ? '<span class="u-faint">' + money(sp / st.outs) + '/site visit</span>' : '') +
            '</div>' +
          '</div></div>';
      }).join('');
      return '<div class="view-section"><div class="section-head"><h2>' + esc(r.name) + '</h2>' +
        '<span class="section-action"><span class="u-label">' + r.adKeys.length + ' ads · ' + tot.clicks + ' clicks · ' + tot.views + ' visits · ' + tot.outs + ' to site' + (tot.spendSet ? ' · ' + money(tot.spend) + ' spent' : '') + '</span>' +
        '<button class="btn is-ghost is-sm" data-round-edit="' + esc(r.id) + '">Edit ads</button>' +
        '<button class="icon-btn" data-round-del2="' + esc(r.id) + '" title="Delete round">' + icons().trash + '</button></span></div>' +
        '<div class="rndp-grid">' + cards + '</div></div>';
    }).join('');
    el.innerHTML = head + (sections || '<div class="view-section"><div class="dos-state is-empty">No rounds yet — press “+ New round” and pick the ads you’re posting.</div></div>') +
      planSectionHTML(p, rounds);
    // thumbs
    el.querySelectorAll('[data-rt2]').forEach(function (n) {
      var a = byKey[n.getAttribute('data-rt2')]; if (!a) return;
      try { thumbFor(n, a, n.clientWidth || 150, null); } catch (e) {}
    });
    // bindings
    el.querySelector('#rndf-back').addEventListener('click', function () { roundsOpenProject = null; Ads.go('rounds'); });
    el.querySelector('#rndf-new').addEventListener('click', function () { roundEditor(p.id, null); });
    var syncBtn = el.querySelector('#rndf-sync');
    syncBtn.addEventListener('click', function () {
      syncBtn.disabled = true; syncBtn.innerHTML = '<span class="spinner"></span> Syncing…';
      syncTracking(function (err) {
        if (err) Ads.toast('Sync failed: ' + err.message, true);
        Ads.go('rounds');
      });
    });
    el.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        try { navigator.clipboard.writeText(b.getAttribute('data-copy')); Ads.toast('Link copied — use it as the ad’s destination URL'); }
        catch (e) { Ads.toast('Could not copy', true); }
      });
    });
    el.querySelectorAll('[data-round-edit]').forEach(function (b) {
      b.addEventListener('click', function () { roundEditor(p.id, b.getAttribute('data-round-edit')); });
    });
    el.querySelectorAll('[data-round-del2]').forEach(function (b) {
      b.addEventListener('click', function () {
        var rid = b.getAttribute('data-round-del2');
        Ads.confirm({
          title: 'Delete this round?', message: 'The ads and their tracking data stay — only the grouping is removed.',
          danger: true, okLabel: 'Delete',
          onConfirm: function () {
            var p2 = store.getProject(p.id); if (!p2) return;
            store.updateProject(p2.id, { rounds: projRounds(p2).filter(function (r) { return r.id !== rid; }) });
            Ads.go('rounds');
          }
        });
      });
    });
    el.querySelectorAll('[data-spend]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        store.setTrackSpend(inp.getAttribute('data-spend'), inp.value.trim());
        Ads.go('rounds');   // refresh cost-per metrics + round totals
      });
    });
    bindPlanSection(el, p, rounds);
  }

  /* ---- Post this round: budget + platforms + instructions → AI game plan →
     approve/modify → launch. Direct posting unlocks once Meta is connected. */
  var folderPlanRound = null;   // which round the plan box targets
  function planRoundOf(rounds) {
    return rounds.filter(function (r) { return r.id === folderPlanRound; })[0] || rounds[rounds.length - 1] || null;
  }
  function updateRound(pid, rid, patch) {
    var p = store.getProject(pid); if (!p) return;
    store.updateProject(pid, { rounds: projRounds(p).map(function (r) { return r.id === rid ? Object.assign({}, r, patch) : r; }) });
  }
  function planCardHTML(d, approved) {
    var platRows = (d.perPlatform || []).map(function (x) {
      return '<div class="pp-platrow"><div class="pp-platname"><strong>' + esc(x.platform) + '</strong><span>' + esc(x.budget) + (x.share ? ' · ' + esc(x.share) : '') + '</span></div>' +
        '<div class="pp-platwhy">' + esc(x.why) + (x.targeting ? ' <em>' + esc(x.targeting) + '</em>' : '') +
        (x.placements && x.placements.length ? '<div class="u-faint" style="margin-top:0.3rem">' + esc(x.placements.join(' · ')) + '</div>' : '') + '</div></div>';
    }).join('');
    var adRows = (d.adPlan || []).map(function (x) {
      return '<div class="pp-adrow"><strong>' + esc(x.ad) + '</strong> → ' + esc((x.platforms || []).join(', ')) +
        (x.budget ? ' · <b>' + esc(x.budget) + '</b>' : '') +
        (x.segment ? ' · aimed at <em>' + esc(x.segment) + '</em>' : '') +
        (x.note ? '<div class="u-faint">' + esc(x.note) + '</div>' : '') + '</div>';
    }).join('');
    return '<div class="pp-plan is-card">' +
      (approved ? '<div class="pp-approved">✓ Approved — ready to launch</div>' : '') +
      '<p class="pp-strategy">' + esc(d.strategy) + '</p>' +
      (d.duration ? '<p class="pp-line"><b>Run:</b> ' + esc(d.duration) + '</p>' : '') +
      (platRows ? '<div class="u-label" style="margin:1.2rem 0 0.6rem">Where the money goes</div>' + platRows : '') +
      (adRows ? '<div class="u-label" style="margin:1.4rem 0 0.6rem">Ad by ad</div>' + adRows : '') +
      (d.schedule ? '<p class="pp-line"><b>Schedule:</b> ' + esc(d.schedule) + '</p>' : '') +
      (d.expectations ? '<p class="pp-line"><b>What to expect:</b> ' + esc(d.expectations) + '</p>' : '') +
      (d.checkpoints ? '<p class="pp-line"><b>Checkpoints:</b> ' + esc(d.checkpoints) + '</p>' : '') +
      (d.warnings ? '<p class="pp-warn">⚠ ' + esc(d.warnings) + '</p>' : '') +
    '</div>';
  }
  function planSectionHTML(p, rounds) {
    if (!rounds.length) return '';
    var r = planRoundOf(rounds);
    var sel = rounds.length > 1
      ? '<select class="select" id="pp-round" style="max-width:26rem">' + rounds.map(function (x) {
          return '<option value="' + esc(x.id) + '"' + (x.id === r.id ? ' selected' : '') + '>' + esc(x.name) + '</option>';
        }).join('') + '</select>'
      : '';
    var plan = r.plan;
    var chat = Array.isArray(r.planChat) ? r.planChat : [];
    var priorIn = (plan && plan.input) || {};
    var platsOn = priorIn.platforms || ['ig', 'fb'];
    var chips = ROUND_PLATFORMS.map(function (pl) {
      return '<label class="pp-chip"><input type="checkbox" data-pp-plat="' + pl.id + '"' + (platsOn.indexOf(pl.id) >= 0 ? ' checked' : '') + '><span>' + pl.label + '</span></label>';
    }).join('');
    var thread = chat.map(function (m, i) {
      if (m.who === 'you') return '<div class="ppc-msg is-you">' + esc(m.text || '') + '</div>';
      if (m.plan) {
        var isLatest = plan && plan.data && i === chat.length - 1;
        return '<div class="ppc-msg is-ai is-plan">' + planCardHTML(m.plan, isLatest && plan.approved) + '</div>';
      }
      return '<div class="ppc-msg is-ai">' + esc(m.text || '') + '</div>';
    }).join('');
    if (!thread) {
      thread = '<div class="ppc-msg is-ai">Tell me what you want to do — e.g. <em>“$500 on Instagram and Facebook, launch Friday, push the voice-regret angle hardest”</em>. I’ll build the game plan from this round’s ads and your audience analysis' +
        (p.audience && p.audience.data ? '' : ' <strong>(tip: run “Analyze best target audience” in the generator first — the plan aims at it)</strong>') +
        ' — then keep talking to change anything.</div>';
    }
    return '<div class="view-section" id="rndf-post"><div class="section-head"><h2>Post this round</h2>' +
      '<span class="section-action">' + sel + '</span></div>' +
      '<div class="pp-quick">' +
        '<div class="field" style="max-width:15rem;margin:0"><label>Budget (' + esc(sym()) + ')</label><input class="input" id="pp-budget" inputmode="decimal" placeholder="500" value="' + esc(priorIn.budget || '') + '"></div>' +
        '<div class="field" style="margin:0"><label>Platforms</label><div class="pp-chips">' + chips + '</div></div>' +
      '</div>' +
      '<div class="ppc-thread" id="ppc-thread">' + thread + '</div>' +
      (plan && plan.data ? '<div class="btn-row" style="margin:1.2rem 0 0.4rem">' +
          (plan.approved
            ? '<button class="btn is-primary" id="pp-post">🚀 Post this round now</button>'
            : '<button class="btn is-primary is-sm" id="pp-approve">Approve this plan</button>') +
          '<button class="btn is-ghost is-sm" id="pp-discard">Start over</button>' +
        '</div>' : '') +
      '<div class="ppc-bar">' +
        '<input class="input" id="ppc-input" placeholder="' + (plan && plan.data ? 'Tell me what to change…' : 'Describe the launch — budget, platforms, timing, priorities…') + '">' +
        '<button class="btn is-sm is-primary" id="ppc-send">Send</button>' +
      '</div>' +
    '</div>';
  }
  function bindPlanSection(el, p, rounds) {
    var box = el.querySelector('#rndf-post'); if (!box) return;
    var r = planRoundOf(rounds);
    var selEl = box.querySelector('#pp-round');
    if (selEl) selEl.addEventListener('change', function () { folderPlanRound = selEl.value; Ads.go('rounds'); });
    var thread = box.querySelector('#ppc-thread');
    if (thread) thread.scrollTop = thread.scrollHeight;
    function pushChat(entry) {
      var p2 = store.getProject(p.id); if (!p2) return;
      var r2 = projRounds(p2).filter(function (x) { return x.id === r.id; })[0]; if (!r2) return;
      var chat = (Array.isArray(r2.planChat) ? r2.planChat : []).concat([entry]).slice(-30);
      updateRound(p.id, r.id, { planChat: chat });
    }
    function send() {
      var input = box.querySelector('#ppc-input');
      var msg = (input.value || '').trim();
      var budget = (box.querySelector('#pp-budget').value || '').trim();
      var plats = [].map.call(box.querySelectorAll('[data-pp-plat]'), function (c) { return c.checked ? c.getAttribute('data-pp-plat') : null; }).filter(Boolean);
      if (!msg && !(budget && !r.plan)) { Ads.toast('Say what you want the plan to do', true); return; }
      if (!budget || isNaN(parseFloat(budget)) || parseFloat(budget) <= 0) { Ads.toast('Set the budget box first — the plan allocates real money', true); return; }
      if (!plats.length) { Ads.toast('Pick at least one platform', true); return; }
      var shown = msg || ('Plan ' + budget + ' ' + sym() + ' across ' + plats.join(', '));
      // show the message + a thinking bubble immediately
      pushChat({ who: 'you', text: shown, at: util.nowISO() });
      input.value = ''; input.disabled = true;
      box.querySelector('#ppc-send').disabled = true;
      if (thread) {
        thread.insertAdjacentHTML('beforeend', '<div class="ppc-msg is-you">' + esc(shown) + '</div><div class="ppc-msg is-ai" id="ppc-wait"><span class="spinner"></span> Working on the plan…</div>');
        thread.scrollTop = thread.scrollHeight;
      }
      var byKey = savedByKey(p), snap = snapAds();
      var names = { ig: 'Instagram', fb: 'Facebook', tt: 'TikTok', x: 'X (Twitter)' };
      var adsTxt = r.adKeys.map(function (k) {
        var a = byKey[k]; if (!a) return null;
        var st = snap[k] || {};
        return '- ' + (a.angle || a.name || k) + ' | ' + (a.kind === 'video' ? (a.bgVideo ? 'video with real footage' : 'motion video') : 'static post') +
          ' | headline: ' + (((a.headlineStart || '') + ' ' + (a.headlineHighlight || '')).trim() || '—') +
          (st.clicks ? ' | so far: ' + st.clicks + ' clicks, ' + (st.outs || 0) + ' site visits' : '');
      }).filter(Boolean).join('\n');
      var aud = p.audience && p.audience.data ? JSON.stringify(p.audience.data).slice(0, 9000) : 'No audience analysis available — plan from the ads themselves.';
      var r2 = projRounds(store.getProject(p.id)).filter(function (x) { return x.id === r.id; })[0] || r;
      var history = (r2.planChat || []).slice(-8).map(function (m) {
        if (m.who === 'you') return 'ADVERTISER: ' + (m.text || '');
        if (m.plan) return 'YOUR PRIOR PLAN (summary): ' + String(m.plan.strategy || '').slice(0, 300);
        return null;
      }).filter(Boolean).join('\n');
      var ctx =
        '== THE ROUND ==\nRound "' + r.name + '" — ' + r.adKeys.length + ' ads:\n' + adsTxt +
        '\n\n== BUDGET ==\nTotal: ' + budget + ' ' + sym() + '. Platforms the advertiser chose: ' + plats.map(function (x) { return names[x] || x; }).join(', ') + '.' +
        '\n\n== AUDIENCE ANALYSIS (researched — aim the spend at this) ==\n' + aud +
        (r.plan && r.plan.data ? '\n\n== CURRENT PLAN (revise it, keep what was not questioned) ==\n' + JSON.stringify(r.plan.data).slice(0, 6000) : '') +
        (history ? '\n\n== CONVERSATION SO FAR ==\n' + history : '') +
        (msg ? '\n\n== THE ADVERTISER JUST SAID (respect this above all) ==\n' + msg : '');
      ai().mediaPlan({ context: ctx }).then(function (plan) {
        pushChat({ who: 'ai', plan: plan, at: util.nowISO() });
        updateRound(p.id, r.id, { plan: { at: util.nowISO(), input: { budget: budget, platforms: plats, details: msg }, data: plan, approved: false } });
        Ads.go('rounds');
      }).catch(function (e) {
        var w = box.querySelector('#ppc-wait'); if (w) w.remove();
        input.disabled = false; box.querySelector('#ppc-send').disabled = false;
        Ads.toast('Planning failed: ' + (e && e.message || 'unknown'), true);
      });
    }
    var sendBtn = box.querySelector('#ppc-send');
    if (sendBtn) sendBtn.addEventListener('click', send);
    var inp = box.querySelector('#ppc-input');
    if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    var approve = box.querySelector('#pp-approve');
    if (approve) approve.addEventListener('click', function () {
      updateRound(p.id, r.id, { plan: Object.assign({}, r.plan, { approved: true }) });
      Ads.go('rounds');
      Ads.toast('Plan approved');
    });
    var discard = box.querySelector('#pp-discard');
    if (discard) discard.addEventListener('click', function () {
      Ads.confirm({
        title: 'Start the plan over?', message: 'The round and its ads stay — the plan and this conversation are cleared.',
        danger: true, okLabel: 'Start over',
        onConfirm: function () { updateRound(p.id, r.id, { plan: null, planChat: [] }); Ads.go('rounds'); }
      });
    });
    var post = box.querySelector('#pp-post');
    if (post) post.addEventListener('click', function () {
      Ads.modal({
        title: 'One step before direct posting', wide: true,
        body: '<p class="u-muted">Posting straight from Ads Hub needs your <strong>Meta connection</strong> — a one-time setup in your Meta Business Manager:</p>' +
          '<ol style="margin:1.2rem 0 1.2rem 2rem;line-height:1.9;font-size:1.3rem">' +
            '<li>Business Settings → <strong>System Users</strong> → create one</li>' +
            '<li>Grant it your ad account, Facebook Page and Instagram account</li>' +
            '<li>Generate a token with <strong>ads_management</strong>, <strong>pages_manage_posts</strong>, <strong>instagram_content_publish</strong></li>' +
          '</ol>' +
          '<p class="u-muted">Tell Claude the token is ready and posting gets wired here — this button will then publish the approved plan directly. Until then, post manually: each ad’s platform links are one click away below.</p>' +
          '<div class="btn-row" style="margin-top:1.4rem"><button class="btn is-ghost is-sm" id="pp-links">Open the round’s links</button></div>',
        foot: [{ label: 'Close', act: 'cancel', ghost: true }],
        onMount: function (m) {
          var lb = m.querySelector('#pp-links');
          if (lb) lb.addEventListener('click', function () { Ads.closeModal(); roundDetail(p.id, r.id); });
        },
        onAction: function (act) { if (act === 'cancel') Ads.closeModal(); }
      });
    });
  }

  function roundEditor(pid, roundId) {
    var p = store.getProject(pid); if (!p) return;
    var existing = roundId ? projRounds(p).filter(function (r) { return r.id === roundId; })[0] : null;
    var savedAll = p.savedAds || [];
    // only ads WITH a tracking key can join a round (keys are assigned when
    // landing pages are generated) — keyless ads would be silently dropped
    var saved = savedAll.filter(function (a) { return a.adKey; });
    if (!savedAll.length) { Ads.toast('This project has no saved ads yet — ❤ some ads first', true); return; }
    if (!saved.length) { Ads.toast('These saved ads have no tracking keys yet — open Landing pages once first', true); return; }
    var keyless = savedAll.length - saved.length;
    var sel = {}; (existing ? existing.adKeys : []).forEach(function (k) { sel[k] = 1; });
    var lk = landingKeys(p);
    // every ad rendered IN FULL — click to include, same as the frame picker
    var list = saved.map(function (a, i) {
      var key = a.adKey;
      return '<div class="fp-item rnd-card' + (sel[key] ? ' is-on' : '') + '" data-rk="' + esc(key) + '">' +
        '<div class="rnd-thumbwrap"><div class="rnd-thumb ad-stage-scaler" data-rt="' + esc(key) + '"></div></div>' +
        '<span class="fp-tick">✓</span>' +
        '<div class="rnd-cap"><strong>' + esc(a.angle || a.name || ('Ad ' + (i + 1))) + '</strong>' +
          '<span>' + (a.kind === 'video' ? '▶ video' : 'post') + (lk[key] ? '' : ' · ⚠ no landing page') + '</span></div>' +
      '</div>';
    }).join('');
    Ads.modal({
      title: existing ? 'Edit round' : 'New round — pick the ads you’re posting', xwide: true,
      body: '<div class="field"><label>Round name</label><input class="input" id="rnd-name" value="' + esc(existing ? existing.name : ('Round ' + (projRounds(p).length + 1))) + '"></div>' +
        '<div class="u-label" style="margin:1rem 0 0.6rem"><span id="rnd-count"></span>' + (keyless ? ' — ' + keyless + ' hidden (no tracking key yet; open Landing pages once)' : '') + '</div>' +
        '<div class="fp-grid rnd-grid">' + list + '</div>' +
        '<div class="hint" style="margin-top:1rem">⚠ An ad’s tracked link only goes live when its landing page is generated — that’s what registers the link with the collector. Generate landing pages before posting.</div>',
      foot: [{ label: 'Cancel', act: 'cancel', ghost: true }, { label: existing ? 'Save round' : 'Create round', act: 'save', primary: true }],
      onMount: function (m) {
        var byK = {}; saved.forEach(function (a) { byK[a.adKey] = a; });
        function upd() {
          var n = m.querySelectorAll('.rnd-card.is-on').length;
          var c = m.querySelector('#rnd-count'); if (c) c.textContent = n + ' of ' + saved.length + ' ads in this round';
        }
        m.querySelectorAll('.rnd-card').forEach(function (it) {
          it.addEventListener('click', function () { it.classList.toggle('is-on'); upd(); });
        });
        m.querySelectorAll('[data-rt]').forEach(function (n) {
          var a = byK[n.getAttribute('data-rt')]; if (!a) return;
          var wrap = n.parentElement;
          try { mountThumbFitted(n, a, (wrap && wrap.clientWidth) || 200, 205); } catch (e) {}
        });
        upd();
      },
      onAction: function (act, m) {
        if (act === 'cancel') return Ads.closeModal();
        if (act !== 'save') return;
        var keys = [].map.call(m.querySelectorAll('.rnd-card.is-on'), function (c) { return c.getAttribute('data-rk'); }).filter(Boolean);
        if (!keys.length) { Ads.toast('Pick at least one ad', true); return; }
        var name = (m.querySelector('#rnd-name').value || '').trim() || 'Round';
        var p2 = store.getProject(pid); if (!p2) return;
        var rounds = projRounds(p2).slice();
        var openId;
        if (existing) { rounds = rounds.map(function (r) { return r.id === existing.id ? Object.assign({}, r, { name: name, adKeys: keys }) : r; }); openId = existing.id; }
        else { var nr = { id: util.uid('rd'), name: name, adKeys: keys, createdAt: util.nowISO() }; rounds.push(nr); openId = nr.id; }
        store.updateProject(pid, { rounds: rounds });
        Ads.closeModal();
        roundsOpenProject = pid;   // land on the folder page — the main data hub
        Ads.go('rounds');
      }
    });
  }

  function roundDetail(pid, roundId) {
    var p = store.getProject(pid); if (!p) return;
    var r = projRounds(p).filter(function (x) { return x.id === roundId; })[0]; if (!r) return;
    var byKey = savedByKey(p), lk = landingKeys(p), snap = snapAds();
    var base = trackBase();
    var tot = { clicks: 0, views: 0, outs: 0 };
    var rows = r.adKeys.map(function (k) {
      var a = byKey[k]; var st = snap[k] || {};
      tot.clicks += st.clicks || 0; tot.views += st.views || 0; tot.outs += st.outs || 0;
      var link = base + '/a/' + k;
      var plats = ROUND_PLATFORMS.map(function (pl) {
        return '<button class="btn is-ghost is-xs" data-copy="' + esc(link + '?s=' + pl.id) + '" title="Copy the link to use when posting on ' + pl.label + '">' + pl.label + '</button>';
      }).join('');
      return '<div class="rnd-adrow">' +
        '<div class="rnd-adhead"><strong>' + esc(a ? (a.name || a.angle || k) : (k + ' (no longer saved)')) + '</strong>' +
          (a ? '<span class="u-faint"> · ' + (a.kind === 'video' ? 'video' : 'post') + '</span>' : '') +
          (lk[k] ? '' : ' <span class="tag">no landing page</span>') + '</div>' +
        '<div class="rnd-links"><span class="u-label" style="margin-right:0.6rem">Copy link for:</span>' + plats +
          '<button class="btn is-ghost is-xs" data-copy="' + esc(link) + '">Plain</button></div>' +
        '<div class="rnd-stats">' +
          '<span><b>' + (st.clicks || 0) + '</b> clicks</span><span><b>' + (st.views || 0) + '</b> visits</span>' +
          '<span><b>' + fmtDur(st.avgSeconds || 0) + '</b> avg time</span><span><b>' + (st.outs || 0) + '</b> to site</span>' +
          '<span class="rnd-src">' + srcChips(st.bySrc) + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
    Ads.modal({
      title: (p.name || 'Project') + ' — ' + r.name, xwide: true,
      body: '<p class="u-muted">Post each ad using its <strong>platform link</strong> as the destination — Instagram posts get the Instagram link, and so on. Every click, landing visit, time-on-page and click-through to the site then reports <strong>per platform</strong>.</p>' +
        '<div class="btn-row" style="margin:1.2rem 0">' +
          '<button class="btn is-ghost is-sm" id="rnd-sync">↻ Sync live stats</button>' +
          '<button class="btn is-ghost is-sm" id="rnd-edit">Edit ads in round</button>' +
          '<span class="u-faint" style="margin-left:auto">Round total: <b>' + tot.clicks + '</b> clicks · <b>' + tot.views + '</b> visits · <b>' + tot.outs + '</b> to site</span>' +
        '</div>' + rows,
      foot: [{ label: 'Close', act: 'cancel', ghost: true }],
      onMount: function (m) {
        m.querySelectorAll('[data-copy]').forEach(function (b) {
          b.addEventListener('click', function () {
            try { navigator.clipboard.writeText(b.getAttribute('data-copy')); Ads.toast('Link copied — use it as the ad’s destination URL'); }
            catch (e) { Ads.toast('Could not copy', true); }
          });
        });
        var sync = m.querySelector('#rnd-sync');
        if (sync) sync.addEventListener('click', function () {
          sync.disabled = true; sync.innerHTML = '<span class="spinner"></span> Syncing…';
          syncTracking(function (err) {
            Ads.closeModal();
            if (err) Ads.toast('Sync failed: ' + err.message, true);
            roundDetail(pid, roundId);
          });
        });
        var ed = m.querySelector('#rnd-edit');
        if (ed) ed.addEventListener('click', function () { Ads.closeModal(); roundEditor(pid, roundId); });
      },
      onAction: function (act) { if (act === 'cancel') Ads.closeModal(); }
    });
  }

})();
