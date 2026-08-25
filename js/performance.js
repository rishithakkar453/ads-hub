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
        '<td><div class="cr-cell"><div class="cr-thumb" data-thumb-ad="' + a.id + '"></div><div style="min-width:0"><div class="ac-name u-truncate">' + esc(a.name) + '</div><div class="u-faint" style="font-size:1.05rem">' + esc(T.tplById(a.template).label) + ' · ' + esc(a.angle || '—') + '</div></div></div></td>' +
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
            '<div class="cr-stage-frame" style="padding:1.4rem"><div class="cr-stage-scaler" id="det-preview"></div></div>' +
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
      { name: 'ad', label: 'Ad ID', default: a.metaIds.cr },
      { name: 'audience', label: 'Audience / notes', type: 'textarea', default: a.audience }
    ], onSubmit: function (d) { store.updateAd(id, { metaIds: { campaign: d.campaign, adset: d.adset, ad: d.cr }, audience: d.audience }); Ads.closeModal(); Ads.toast('Saved'); } });
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
        '<div class="cc-head"><div class="cr-thumb" data-thumb-ad="' + a.id + '" style="width:100%;height:120px;margin-bottom:1rem"></div>' +
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
  // API base: where THIS browser reaches the collector (same origin via the
  // tunnel or the gate — the public rewrite below would break both CORS and
  // the gate for /api/track/stats).
  function trackBase() {
    var t = store.getSettings().tracking || {};
    return String(t.url || window.location.origin).replace(/\/+$/, '');
  }
  // Link base: for URLs that LEAVE this machine (Instagram captions, copy-link
  // buttons, CSVs) — the SSH-tunnel origin localhost:3003 means nothing to the
  // outside world, so those always use the public address.
  function publicLinkBase() {
    var t = store.getSettings().tracking || {};
    if (t.url) return String(t.url).replace(/\/+$/, '');
    if (/^https?:\/\/(localhost|127\.)/i.test(window.location.origin)) return 'https://sm.partisans.ca';
    return String(window.location.origin).replace(/\/+$/, '');
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
  // adKey → the ad's real Instagram post URL: organic posts carry it directly,
  // dark ads get it from the synced insights. These pages render for the
  // account owner's logged-in session (and the IG app) — the user's preference.
  function igLinksByAdKey() {
    var map = {};   // adKey → { url, lbl }
    var dk = (store.getTracking().dark || {}).byId || {};
    store.listProjects().forEach(function (p) {
      (p.rounds || []).forEach(function (r) {
        Object.keys(r.igPosts || {}).forEach(function (k) {
          if (r.igPosts[k] && r.igPosts[k].permalink) map[k] = { url: r.igPosts[k].permalink, lbl: 'on Instagram ↗' };
        });
        [r.dark].concat(r.darkRuns || []).forEach(function (d) {
          if (!d) return;
          Object.keys(d.ads || {}).forEach(function (k) {
            var a = d.ads[k];
            if (map[k] || !a || !a.adId) return;
            if (dk[a.adId] && dk[a.adId].permalink) map[k] = { url: dk[a.adId].permalink, lbl: 'on Instagram ↗' };
          });
        });
      });
    });
    return map;
  }
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
    var igLinks = igLinksByAdKey();
    var body = rows.map(function (r) {
      var matched = byKey[r.key];
      return '<tr class="is-clickable" data-trkrow="' + esc(r.key) + '">' +
        '<td><div class="cr-cell">' + (matched ? '<div class="cr-thumb" data-thumb-ad="' + matched.id + '"></div>' : '<div class="cr-thumb trk-nothumb">' + icons().globe + '</div>') +
          '<div style="min-width:0"><div class="ac-name u-truncate">' + esc(r.name) + '</div>' +
          '<div class="u-faint" style="font-size:1.05rem">' + (r.page ? '/p/' + esc(r.page) : esc(r.headline)).slice(0, 60) +
          (igLinks[r.key] ? ' · <a href="' + esc(igLinks[r.key].url) + '" target="_blank" rel="noopener" data-stop="1">' + esc(igLinks[r.key].lbl) + '</a>' : '') +
          '</div></div></div></td>' +
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
      matched.forEach(function (m) { store.setMetrics(m.cr.id, m.metrics); }); Ads.toast('Updated ' + matched.length + ' ads'); Ads.go('dashboard');
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

  /* ---- Instagram connection page (Performance → Instagram) ---------------- */
  Ads.registerView('instagram', {
    title: 'Instagram', mode: 'performance',
    render: function (el) {
      el.innerHTML = '<div class="view-section">' +
        '<div class="section-head"><h2>Instagram — direct posting</h2></div>' +
        '<div class="card" style="max-width:76rem;padding:2.4rem 2.8rem">' +
          '<div class="hint" id="ig-state" style="margin-bottom:1.6rem"><span class="spinner"></span> Checking connection…</div>' +
          '<p class="u-muted">Connected, the <strong>🚀 button on a round’s page</strong> publishes its ads straight to your Instagram feed/Reels with tracked links in the captions, and <strong>Sync live stats</strong> pulls each post’s views, reach, likes, comments and saves back onto the round.</p>' +
          '<div class="field" style="margin-top:1.6rem"><label>Instagram access token</label>' +
            '<input class="input" type="password" id="ig-key" placeholder="IGAA… (paste the token from your Meta developer app)" autocomplete="off" spellcheck="false"></div>' +
          '<div class="btn-row"><button class="btn is-primary is-sm" id="ig-save">Connect</button>' +
            '<button class="btn is-ghost is-sm" id="ig-forget">Disconnect</button></div>' +
          '<details style="margin-top:2rem"><summary class="u-label" style="cursor:pointer">Where the token comes from (one-time setup)</summary>' +
            '<ol style="margin:1.2rem 0 0.4rem 2rem;line-height:1.9;font-size:1.28rem">' +
              '<li>Instagram app: switch to a <strong>professional account</strong> (Settings → Account type)</li>' +
              '<li><strong>developers.facebook.com</strong> → create an app → add the <strong>Instagram</strong> use case</li>' +
              '<li>App roles → add your IG username as <strong>Instagram Tester</strong> → accept at instagram.com/accounts/manage_access (Tester invites tab)</li>' +
              '<li>Use cases → Customize → <strong>API setup with Instagram business login</strong> → Add account → log in with Instagram → <strong>Generate token</strong></li>' +
              '<li>Copy the whole <code>IGAA…</code> string and paste it above — it verifies instantly and renews itself</li>' +
            '</ol></details>' +
        '</div>' +
        '<div class="section-head" style="margin-top:3.4rem"><h2>🌑 Dark ads — paid, invisible on the profile</h2></div>' +
        '<div class="card" style="max-width:76rem;padding:2.4rem 2.8rem">' +
          '<div class="hint" id="dk-state" style="margin-bottom:1.6rem"><span class="spinner"></span> Checking…</div>' +
          '<p class="u-muted">A separate <strong>System User token</strong> from Meta Business Manager unlocks the 🌑 option on the round page: real ads with budget and audience targeting that never appear on the profile. Everything is created <strong>paused</strong> — you review and activate in Ads Manager, so Ads Hub can never start spend on its own.</p>' +
          '<div class="field" style="margin-top:1.6rem"><label>System User token</label>' +
            '<input class="input" type="password" id="dk-key" placeholder="EAAB… (from Business Settings → System users → Generate token)" autocomplete="off" spellcheck="false"></div>' +
          '<div class="btn-row"><button class="btn is-primary is-sm" id="dk-save">Connect</button>' +
            '<button class="btn is-ghost is-sm" id="dk-forget">Disconnect</button></div>' +
          '<div id="dk-pickers" style="margin-top:1.2rem"></div>' +
          '<details style="margin-top:2rem"><summary class="u-label" style="cursor:pointer">One-time Business Manager setup</summary>' +
            '<ol style="margin:1.2rem 0 0.4rem 2rem;line-height:1.9;font-size:1.28rem">' +
              '<li><strong>business.facebook.com</strong> → create a Business portfolio (same developer login)</li>' +
              '<li>Create a <strong>Facebook Page</strong> (invisible shell, never posted to) and connect your Instagram account to it (Page settings → Linked accounts) so dark ads deliver as @your-handle</li>' +
              '<li>Create an <strong>ad account</strong> + add a <strong>payment method</strong> (Ads Manager → Billing); accept the ad terms + non-discrimination prompt</li>' +
              '<li>Business Settings → Users → <strong>System users</strong> → create (Admin) → add the ADS HUB app → <strong>Assign assets</strong>: ad account (Manage campaigns) + Page (Full control)</li>' +
              '<li><strong>Generate token</strong> with: ads_management, ads_read, business_management, pages_show_list, pages_read_engagement, pages_manage_ads, instagram_basic → paste above</li>' +
            '</ol></details>' +
        '</div></div>';
      var st = el.querySelector('#ig-state');
      function refresh() {
        ai().metaStatus().then(function (g) {
          if (g && g.enabled && g.ok === false) {
            st.innerHTML = '<strong style="color:var(--bad,#e5704f)">⚠ Instagram is rejecting the saved token.</strong> ' + esc(g.error || '') + ' Generate a fresh token (step 4 below) and paste it again.';
          } else if (g && g.enabled) {
            st.innerHTML = '✓ <strong>Connected' + (g.username ? ' as @' + esc(g.username) : '') + '</strong> — 🚀 posting and insights sync are live. The token renews itself.';
          } else {
            st.textContent = 'Not connected yet — paste the access token below.';
          }
        });
      }
      refresh();
      el.querySelector('#ig-save').addEventListener('click', function () {
        var k = el.querySelector('#ig-key').value;
        if (!k.trim()) { Ads.toast('Paste the token first', true); return; }
        st.innerHTML = '<span class="spinner"></span> Saving & verifying with Instagram…';
        ai().setMetaKey(k).then(function (resp) {
          el.querySelector('#ig-key').value = '';
          if (resp && resp.ok === false) {
            st.innerHTML = '<strong style="color:var(--bad,#e5704f)">Instagram rejected the token:</strong> ' + esc(resp.error || 'invalid token') + ' — make sure you copied the whole IGAA… string from Generate token (not the App ID or secret).';
            Ads.toast('Token saved but Instagram rejects it — details above', true);
          } else {
            Ads.toast('Instagram connected' + (resp && resp.username ? ' as @' + resp.username : ''));
            refresh();
          }
        }).catch(function (e) {
          st.innerHTML = '<strong style="color:var(--bad,#e5704f)">Could not save the token:</strong> ' + esc(e.message || 'unknown error') + ' — try pasting again.';
          Ads.toast(e.message, true);
        });
      });
      el.querySelector('#ig-forget').addEventListener('click', function () {
        Ads.confirm({
          title: 'Disconnect Instagram?', message: 'Direct posting turns off until you paste a token again. Published posts stay up.',
          danger: true, okLabel: 'Disconnect',
          onConfirm: function () { ai().setMetaKey('').then(function () { Ads.toast('Instagram disconnected'); refresh(); }).catch(function (e) { Ads.toast(e.message, true); }); }
        });
      });
      // ---- dark-ads (Marketing API) card ----
      var dkState = el.querySelector('#dk-state'), dkPickers = el.querySelector('#dk-pickers');
      function renderDkPickers(conf) {
        if (!dkPickers) return;
        if (!conf || (!(conf.accounts || []).length && !(conf.pages || []).length)) { dkPickers.innerHTML = ''; return; }
        var html = '';
        if ((conf.accounts || []).length > 1) {
          html += '<div class="field" style="max-width:32rem"><label>Ad account</label><select class="select" id="dk-acct">' +
            (conf.adAccountId ? '' : '<option value="" selected>— pick an ad account —</option>') +
            conf.accounts.map(function (a) { return '<option value="' + esc(a.id) + '"' + (a.id === conf.adAccountId ? ' selected' : '') + '>' + esc(a.name) + ' (' + esc(a.currency) + ')</option>'; }).join('') + '</select></div>';
        }
        if ((conf.pages || []).length > 1) {
          html += '<div class="field" style="max-width:32rem"><label>Page (ad identity)</label><select class="select" id="dk-page">' +
            (conf.pageId ? '' : '<option value="" selected>— pick a Page —</option>') +
            conf.pages.map(function (pg) { return '<option value="' + esc(pg.id) + '"' + (pg.id === conf.pageId ? ' selected' : '') + '>' + esc(pg.name) + (pg.igUsername ? ' → @' + esc(pg.igUsername) : ' (no IG connected)') + '</option>'; }).join('') + '</select></div>';
        }
        dkPickers.innerHTML = html;
        var acctSel = dkPickers.querySelector('#dk-acct'), pageSel = dkPickers.querySelector('#dk-page');
        function push() {
          ai().madsConfig({ adAccountId: acctSel ? acctSel.value : conf.adAccountId, pageId: pageSel ? pageSel.value : conf.pageId })
            .then(refreshDk).catch(function (e) { Ads.toast(e.message, true); });
        }
        if (acctSel) acctSel.addEventListener('change', push);
        if (pageSel) pageSel.addEventListener('change', push);
      }
      function refreshDk() {
        if (!dkState) return;
        ai().madsStatus().then(function (g) {
          var conf = g && g.conf;
          if (g && g.enabled && g.ok === false) {
            dkState.innerHTML = '<strong style="color:var(--bad,#e5704f)">⚠ Meta is rejecting the token.</strong> ' + esc(g.error || '') + ' Generate a fresh System User token and paste it again.';
          } else if (g && g.enabled && conf && conf.adAccountId && conf.pageId) {
            dkState.innerHTML = '✓ <strong>Dark ads ready</strong> — ad account <strong>' + esc(conf.adAccountName || conf.adAccountId) + '</strong> (' + esc(conf.currency || '') + '), identity <strong>' + esc(conf.pageName || conf.pageId) + (conf.igUsername ? ' → @' + esc(conf.igUsername) : '') + '</strong>.' +
              (!conf.igUsername ? ' <span style="color:var(--warn,#e6b450)">No Instagram connected to this Page — ads will use the Page identity; connect your IG to the Page for @-handle delivery.</span>' : '');
          } else if (g && g.enabled) {
            dkState.innerHTML = '<strong style="color:var(--warn,#e6b450)">Token OK — pick the ad account and Page below.</strong>' +
              ((conf && !(conf.accounts || []).length) ? ' No ad accounts are assigned to this System User yet — assign the ad account in Business Settings.' : '');
          } else {
            dkState.textContent = 'Not connected — dark ads unlock after the Business Manager setup below.';
          }
          renderDkPickers(conf);
        });
      }
      refreshDk();
      el.querySelector('#dk-save').addEventListener('click', function () {
        var k = el.querySelector('#dk-key').value;
        if (!k.trim()) { Ads.toast('Paste the System User token first', true); return; }
        dkState.innerHTML = '<span class="spinner"></span> Saving & discovering your ad account…';
        ai().setMadsKey(k).then(function (resp) {
          el.querySelector('#dk-key').value = '';
          if (resp && resp.ok === false) {
            dkState.innerHTML = '<strong style="color:var(--bad,#e5704f)">Meta rejected the token:</strong> ' + esc(resp.error || 'invalid') + ' — check the scopes and asset assignments in Business Settings.';
            Ads.toast('Token saved but Meta rejects it', true);
          } else {
            Ads.toast('Dark ads connected');
            refreshDk();
          }
        }).catch(function (e) { dkState.innerHTML = '<strong style="color:var(--bad,#e5704f)">Could not save:</strong> ' + esc(e.message || ''); Ads.toast(e.message, true); });
      });
      el.querySelector('#dk-forget').addEventListener('click', function () {
        Ads.confirm({
          title: 'Disconnect dark ads?', message: 'Existing campaigns stay in Ads Manager; Ads Hub just loses access.',
          danger: true, okLabel: 'Disconnect',
          onConfirm: function () { ai().setMadsKey('').then(function () { Ads.toast('Dark ads disconnected'); refreshDk(); }).catch(function (e) { Ads.toast(e.message, true); }); }
        });
      });
    }
  });

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
    var base = publicLinkBase();   // copy-link buttons produce URLs that leave this machine
    function stat(v, l) { return '<span class="rndp-stat"><b>' + v + '</b><span>' + l + '</span></span>'; }
    var head = '<div class="view-section"><div class="btn-row">' +
      '<button class="btn is-ghost is-sm" id="rndf-back">← All folders</button>' +
      '<button class="btn is-ghost is-sm" id="rndf-sync">↻ Sync live stats</button>' +
      '<span class="u-faint" style="margin-left:auto">' + (t.syncedAt ? 'synced ' + esc(String(t.syncedAt).slice(0, 16).replace('T', ' ')) : 'stats not synced yet') + '</span>' +
      '<button class="btn is-sm" id="rndf-new">+ New round</button>' +
    '</div></div>';
    // one round at a time: a highlighted heading with a dropdown, rounds
    // ordered by the number in their name (0.5 above 1, 1 above 2, …)
    function roundNum(r) { var m = /([0-9]+(?:\.[0-9]+)?)/.exec(r.name || ''); return m ? parseFloat(m[1]) : Infinity; }
    var sorted = rounds.slice().sort(function (a, b) {
      var na = roundNum(a), nb = roundNum(b);
      if (na !== nb) return na - nb;
      return String(a.name).localeCompare(String(b.name));
    });
    var selR = sorted.filter(function (r) { return r.id === folderPlanRound; })[0] || sorted[sorted.length - 1] || null;
    if (selR) folderPlanRound = selR.id;
    if (selR) {
      head += '<div class="view-section"><div class="rndf-pick">' +
        '<button class="rndf-current" id="rndf-pick">' + esc(selR.name) + ' <span class="rndf-caret">▾</span></button>' +
        '<span class="u-label">' + selR.adKeys.length + ' ads in this round</span>' +
        '<div class="rndf-menu" id="rndf-menu" hidden>' +
          sorted.map(function (r) {
            return '<button class="rndf-mi' + (r.id === selR.id ? ' is-active' : '') + '" data-rsel="' + esc(r.id) + '">' +
              esc(r.name) + '<span>' + r.adKeys.length + ' ads</span></button>';
          }).join('') +
        '</div>' +
      '</div></div>';
    }
    var sections = (selR ? [selR] : []).map(function (r) {
      var tot = { clicks: 0, views: 0, outs: 0, spend: 0, spendSet: false };
      var cards = r.adKeys.map(function (k) {
        var a = byKey[k]; var st = snap[k] || {};
        tot.clicks += st.clicks || 0; tot.views += st.views || 0; tot.outs += st.outs || 0;
        var sp = spend[k] != null ? util.num(spend[k]) : null;
        if (sp != null) { tot.spend += sp; tot.spendSet = true; }
        var outRate = st.views ? Math.round((st.outs || 0) / st.views * 100) : null;
        var ig = (r.igPosts || {})[k];
        var igm = ig && ig.id ? (t.ig && t.ig.byId && t.ig.byId[ig.id]) : null;
        var igLine = '';
        if (ig) {
          var bits = [];
          if (igm && !igm.error) {
            if (igm.views != null) bits.push(igm.views + ' views');
            if (igm.reach != null) bits.push(igm.reach + ' reach');
            if (igm.likes != null) bits.push('♥ ' + igm.likes);
            if (igm.comments != null) bits.push('💬 ' + igm.comments);
            if (igm.saved != null) bits.push('🔖 ' + igm.saved);
          }
          igLine = '<div class="rndp-ig">📸 ' +
            (ig.permalink ? '<a href="' + esc(ig.permalink) + '" target="_blank" rel="noopener">on Instagram</a>' : 'posted') +
            (bits.length ? ' · ' + bits.join(' · ') : ' · stats arrive on next sync') + '</div>';
        }
        var dk = (r.dark && r.dark.ads || {})[k];
        if (!(dk && dk.adId)) {
          // fall back to the newest archived run that has this ad
          for (var dri = (r.darkRuns || []).length - 1; dri >= 0; dri--) {
            var old = (r.darkRuns[dri].ads || {})[k];
            if (old && old.adId) { dk = old; break; }
          }
        }
        if (dk && dk.adId) {
          var dkm = t.dark && t.dark.byId && t.dark.byId[dk.adId];
          var dbits = [];
          if (dkm && !dkm.error) {
            if (dkm.status) dbits.push(dkm.status === 'PAUSED' ? 'paused' : dkm.status.toLowerCase());
            if (dkm.impressions != null) dbits.push(dkm.impressions + ' impr');
            if (dkm.clicks != null) dbits.push(dkm.clicks + ' clicks');
            if (dkm.spend != null) dbits.push(dkm.spend + ' ' + esc((r.dark && r.dark.currency) || '') + ' spent');
            if (dkm.cpc != null) dbits.push(dkm.cpc + '/click');
            if (dkm.likes != null) dbits.push('♥ ' + dkm.likes);
            if (dkm.comments != null) dbits.push('💬 ' + dkm.comments);
          }
          igLine += '<div class="rndp-ig">🌑 ' +
            (dkm && dkm.permalink ? '<a href="' + esc(dkm.permalink) + '" target="_blank" rel="noopener" title="opens the ad’s real Instagram post — view while logged in as the account owner">dark ad on Instagram</a> ' : 'dark ad ') +
            (dbits.length ? '· ' + dbits.join(' · ') : '· created paused — stats after next sync') + '</div>';
        }
        return '<div class="rndp-card">' +
          '<div class="rndp-thumb cr-stage-scaler" data-rt2="' + esc(k) + '"></div>' +
          '<div class="rndp-body">' +
            '<div class="rndp-name"><strong>' + esc(a ? (a.angle || a.name || k) : (k + ' (no longer saved)')) + '</strong>' +
              '<span class="u-faint"> · ' + (a ? (a.kind === 'video' ? 'video' : 'post') : '?') + (lk[k] ? '' : ' · ⚠ no landing page') + '</span></div>' +
            igLine +
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
        '<button class="btn is-ghost is-sm" data-round-dl="' + esc(r.id) + '">⬇ Download all</button>' +
        '<button class="btn is-ghost is-sm" data-round-edit="' + esc(r.id) + '">Edit ads</button>' +
        '<button class="icon-btn" data-round-del2="' + esc(r.id) + '" title="Delete round">' + icons().trash + '</button></span></div>' +
        '<div class="rndp-grid">' + cards + '</div></div>';
    }).join('');
    el.innerHTML = head + (sections || '<div class="view-section"><div class="dos-state is-empty">No rounds yet — press “+ New round” and pick the ads you’re posting.</div></div>') +
      planSectionHTML(p, selR ? [selR] : []);
    // round dropdown: open on the heading, pick → page re-renders scoped to it
    var pickBtn = el.querySelector('#rndf-pick'), pickMenu = el.querySelector('#rndf-menu');
    if (pickBtn) {
      pickBtn.addEventListener('click', function (e) { e.stopPropagation(); pickMenu.hidden = !pickMenu.hidden; });
      el.addEventListener('click', function () { if (pickMenu && !pickMenu.hidden) pickMenu.hidden = true; });
      el.querySelectorAll('[data-rsel]').forEach(function (b) {
        b.addEventListener('click', function () { folderPlanRound = b.getAttribute('data-rsel'); Ads.go('rounds'); });
      });
    }
    // thumbs — video ads play their clip on hover, same as the saved shelf
    el.querySelectorAll('[data-rt2]').forEach(function (n) {
      var a = byKey[n.getAttribute('data-rt2')]; if (!a) return;
      try { thumbFor(n, a, n.clientWidth || 150, null); } catch (e) {}
      if (a.kind === 'video' && Ads.video) {
        var card = n.closest('.rndp-card') || n;
        card.addEventListener('mouseenter', function () {
          if (n._vc) return;
          try { n._vc = Ads.video.mount(n, a, true); } catch (e) {}
        });
        card.addEventListener('mouseleave', function () {
          if (n._vc) { try { n._vc.poster(); } catch (e) {} n._vc = null; }
        });
      }
    });
    // bindings
    el.querySelector('#rndf-back').addEventListener('click', function () { roundsOpenProject = null; Ads.go('rounds'); });
    el.querySelector('#rndf-new').addEventListener('click', function () { roundEditor(p.id, null); });
    var syncBtn = el.querySelector('#rndf-sync');
    syncBtn.addEventListener('click', function () {
      syncBtn.disabled = true; syncBtn.innerHTML = '<span class="spinner"></span> Syncing…';
      syncTracking(function (err) {
        if (err) Ads.toast('Sync failed: ' + err.message, true);
        // also pull Instagram per-post insights for everything this project posted
        var ids = [];
        projRounds(store.getProject(p.id) || p).forEach(function (r2) {
          Object.keys(r2.igPosts || {}).forEach(function (k2) {
            var g = r2.igPosts[k2]; if (g && g.id) ids.push(g.id);
          });
        });
        var darkIds = [];
        projRounds(store.getProject(p.id) || p).forEach(function (r2) {
          // current run + every archived run — an old campaign may be ACTIVE
          var sets = [(r2.dark && r2.dark.ads) || {}].concat((r2.darkRuns || []).map(function (dr) { return dr.ads || {}; }));
          sets.forEach(function (set) {
            Object.keys(set).forEach(function (k2) {
              var d = set[k2]; if (d && d.adId && darkIds.indexOf(d.adId) < 0) darkIds.push(d.adId);
            });
          });
        });
        var syncs = [];
        if (ids.length) syncs.push(ai().metaInsights(ids).then(function (resp) {
          var clean = {}, by = resp.byId || {};
          Object.keys(by).forEach(function (id) { if (by[id] && !by[id].error) clean[id] = by[id]; });
          if (Object.keys(clean).length) store.setTrackIG(clean);
        }).catch(function () {}));
        if (darkIds.length) syncs.push(ai().madsInsights(darkIds).then(function (resp) {
          var clean = {}, by = resp.byId || {};
          Object.keys(by).forEach(function (id) { if (by[id] && !by[id].error) clean[id] = by[id]; });
          if (Object.keys(clean).length) store.setTrackDark(clean);
        }).catch(function () {}));
        if (!syncs.length) return Ads.go('rounds');
        Promise.all(syncs).then(function () { Ads.go('rounds'); });
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
    el.querySelectorAll('[data-round-dl]').forEach(function (b) {
      b.addEventListener('click', function () {
        var rid = b.getAttribute('data-round-dl');
        var r2 = rounds.filter(function (x) { return x.id === rid; })[0]; if (!r2) return;
        var specs2 = r2.adKeys.map(function (k) { return byKey[k]; }).filter(Boolean);
        var nVid2 = specs2.filter(function (s) { return s.kind === 'video'; }).length;
        Ads.confirm({
          title: 'Download this round?',
          message: specs2.length + ' ad' + (specs2.length === 1 ? '' : 's') + ' → one ZIP with each creative plus its caption and per-platform tracked links.' +
            (nVid2 ? ' The ' + nVid2 + ' video' + (nVid2 === 1 ? '' : 's') + ' record in real time (~5s each), so it takes a moment.' : ''),
          okLabel: 'Download',
          onConfirm: function () { downloadRound(p.id, rid, b); }
        });
      });
    });
    // double-click any ad card → the full ad lightbox (video plays, caption,
    // details, download) — same window as the generator's saved shelf
    el.querySelectorAll('.rndp-card').forEach(function (card) {
      var tEl = card.querySelector('[data-rt2]');
      var a = tEl && byKey[tEl.getAttribute('data-rt2')];
      if (!a) return;
      card.title = a.kind === 'video' ? 'Hover plays the clip · double-click opens the full ad' : 'Double-click to open the full ad';
      card.addEventListener('dblclick', function (e) {
        if (e.target.closest('input, a, button, textarea')) return;   // spend box, IG links
        // onSaved: re-render this page so the card immediately shows the edit
        if (Ads.openAdLightbox) Ads.openAdLightbox(a, null, { onSaved: function () { Ads.go('rounds'); } });
      });
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
    bindPlanSection(el, p, selR ? [selR] : []);
  }

  // One ZIP per round: every ad's creative (PNG / real MP4) plus a .txt twin
  // with the caption and its per-platform tracked links — everything needed
  // to post manually anywhere and still have every click land in tracking.
  function downloadRound(pid, rid, btn) {
    var p = store.getProject(pid); if (!p) return;
    var r = projRounds(p).filter(function (x) { return x.id === rid; })[0]; if (!r) return;
    var byKey = savedByKey(p), lk = landingKeys(p);
    var base = publicLinkBase();
    var PLAT_NAMES = { ig: 'Instagram', fb: 'Facebook', tt: 'TikTok', x: 'X (Twitter)' };
    var specs = [], names = [], txts = [], missingLanding = 0;
    r.adKeys.forEach(function (k) {
      var a = byKey[k]; if (!a) return;
      var slug = util.slug(a.angle || a.name || k) + '-' + k.slice(-4);
      specs.push(a); names.push(slug);
      if (!lk[k]) missingLanding++;
      var links = ROUND_PLATFORMS.map(function (pl) {
        return PLAT_NAMES[pl.id] + ':  ' + base + '/a/' + k + '?s=' + pl.id;
      }).join('\n');
      txts.push({ name: slug + '.txt', text:
        'CAPTION (paste as the post text)\n================================\n' + (a.caption || '—') +
        '\n\nHEADLINE:    ' + (((a.headlineStart || '') + ' ' + (a.headlineHighlight || '')).trim() || '—') +
        '\nDESCRIPTION: ' + (a.description || '—') +
        '\nCTA:         ' + (a.cta || '—') +
        '\n\nTRACKED LINK — use the one matching the platform you post on\n============================================================\n' + links +
        (lk[k] ? '' : '\n\n⚠ This ad has NO published landing page yet — open Landing pages in the\ngenerator and publish first, or these links will show “Unknown link”.') +
        '\n' });
    });
    if (!specs.length) return Ads.toast('No downloadable ads in this round', true);
    var nVid = specs.filter(function (s) { return s.kind === 'video'; }).length;
    if (nVid) Ads.toast(nVid + ' video' + (nVid === 1 ? '' : 's') + ' record in real time (~5s each) — hang tight');
    var old = btn.innerHTML; btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 0/' + specs.length;
    var readme = 'ROUND: ' + r.name + '  (' + p.name + ') — ' + specs.length + ' ads\n\n' +
      'Each ad = its creative (image or video) + a .txt twin with the caption\n' +
      'and tracked links. To post manually:\n' +
      '  1. Upload the creative, paste the caption.\n' +
      '  2. Use the tracked link for THAT platform as the link on/under the\n' +
      '     post (…?s=ig Instagram, ?s=fb Facebook, ?s=tt TikTok, ?s=x X).\n' +
      'Every click routes through the collector, is logged per platform, and\n' +
      'lands on the ad’s own landing page automatically — nothing else to\n' +
      'set up. Results appear on the round page after “Sync live stats”.\n' +
      (missingLanding ? '\n⚠ ' + missingLanding + ' ad(s) in this round have no published landing page yet —\ntheir links 404 until you publish Landing pages in the generator.\n' : '');
    render.zip(specs, names, function (done, total) {
      btn.innerHTML = '<span class="spinner"></span> ' + done + '/' + total;
    }, [{ name: 'READ-ME.txt', text: readme }].concat(txts))
      .then(function (blob) {
        util.downloadBlob(blob, util.slug(p.name + '-' + r.name) + '.zip');
        Ads.toast('Round downloaded — creatives, captions and tracked links for every platform');
      })
      .catch(function (e) { Ads.toast('Download failed: ' + ((e && e.message) || 'unknown'), true); })
      .then(function () { btn.disabled = false; btn.innerHTML = old; });
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
      return '<div class="pp-adrow"><strong>' + esc(x.cr) + '</strong> → ' + esc((x.platforms || []).join(', ')) +
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
      // two ways to launch: public organic posts on the profile, or paid dark
      // ads that never appear there. Ask which — each falls back to its own
      // setup instructions when not yet connected.
      Ads.modal({
        title: 'How do you want to launch this round?',
        body: '<div class="pchoice">' +
          '<button class="pchoice-opt" data-pchoice="public"><strong>📣 Public posts</strong><span>Publish on the @profile as normal posts (free). Boost the winners manually in the Instagram app.</span></button>' +
          '<button class="pchoice-opt" data-pchoice="dark"><strong>🌑 Dark ads</strong><span>Paid ads with budget + audience targeting that NEVER show on the profile. Created paused — you activate them in Ads Manager.</span></button>' +
        '</div>',
        foot: [{ label: 'Cancel', act: 'cancel', ghost: true }],
        onMount: function (m) {
          m.querySelectorAll('[data-pchoice]').forEach(function (b) {
            b.addEventListener('click', function () {
              var choice = b.getAttribute('data-pchoice');
              Ads.closeModal();
              if (choice === 'public') {
                ai().metaStatus().then(function (st) {
                  if (st && st.enabled && st.ok !== false) return openIgPostFlow(p.id, r.id);
                  if (st && st.enabled) {
                    return ai().metaVerify().then(function (v) {
                      if (v && v.ok) return openIgPostFlow(p.id, r.id);
                      Ads.toast('Instagram token problem: ' + ((v && v.error) || 'see Performance → Instagram'), true);
                      igSetupModal(p, r);
                    });
                  }
                  igSetupModal(p, r);
                });
              } else {
                ai().madsStatus().then(function (st) {
                  if (st && st.enabled && st.ok !== false && st.conf && st.conf.adAccountId && st.conf.pageId) return openDarkPostFlow(p.id, r.id, st.conf);
                  if (st && st.enabled) { Ads.toast('Dark ads are connected but need the ad account/Page picked — see Performance → Instagram', true); Ads.go('instagram'); return; }
                  darkSetupModal();
                });
              }
            });
          });
        },
        onAction: function (act) { if (act === 'cancel') Ads.closeModal(); }
      });
    });
  }
  function darkSetupModal() {
    Ads.modal({
      title: 'Set up dark ads (one-time)', wide: true,
      body: '<p class="u-muted">Dark ads run through Meta’s ads system — that needs the money plumbing once:</p>' +
        '<ol style="margin:1.2rem 0 1.2rem 2rem;line-height:1.9;font-size:1.3rem">' +
          '<li><strong>business.facebook.com</strong> → create a Business portfolio (use your developer login)</li>' +
          '<li>Create a <strong>Facebook Page</strong> (invisible shell — never post to it) and connect your Instagram account to it (Page settings → Linked accounts)</li>' +
          '<li>Create an <strong>ad account</strong> and add a <strong>payment method</strong> (Ads Manager → Billing); accept the ad terms and the non-discrimination certification when prompted</li>' +
          '<li>Business Settings → Users → <strong>System users</strong> → create one (Admin), add your ADS HUB app to it, and <strong>Assign assets</strong>: the ad account (Manage campaigns) + the Page (Full control)</li>' +
          '<li>Generate the token with scopes <strong>ads_management, ads_read, business_management, pages_show_list, pages_read_engagement, pages_manage_ads, instagram_basic</strong></li>' +
          '<li>Paste it in <strong>Performance → Instagram → Dark ads</strong></li>' +
        '</ol>' +
        '<p class="u-muted">Every dark ad is created <strong>paused</strong> — Ads Hub never starts spend; you review and switch ads on in Ads Manager.</p>',
      foot: [{ label: 'Open the connect page', act: 'go', primary: true }, { label: 'Close', act: 'cancel', ghost: true }],
      onAction: function (act) { Ads.closeModal(); if (act === 'go') Ads.go('instagram'); }
    });
  }
  function blobToB64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { reject(new Error('could not read the rendered file')); };
      fr.readAsDataURL(blob);
    });
  }
  function openDarkPostFlow(pid, rid, conf) {
    var p = store.getProject(pid); if (!p) return;
    var r = projRounds(p).filter(function (x) { return x.id === rid; })[0]; if (!r) return;
    var byKey = savedByKey(p);
    var items = r.adKeys.map(function (k) {
      var a = byKey[k]; if (!a) return null;
      return { key: k, spec: a };
    }).filter(Boolean);
    if (!items.length) return Ads.toast('No ads in this round', true);
    var priorIn = (r.plan && r.plan.input) || {};
    // targeting is remembered per round — an Optimize (or manual setup) done
    // once prefills every later visit
    var savedT = r.darkTargeting || null;
    var tBudget = (savedT && savedT.budget) || (priorIn.budget && +priorIn.budget <= 100 ? priorIn.budget : '');
    var tDays = (savedT && savedT.days) || 7;
    var tCountries = (savedT && savedT.countries) || 'CA, US';
    var tAgeMin = (savedT && savedT.ageMin) || 25;
    var tAgeMax = (savedT && savedT.ageMax) || 65;
    var tGender = (savedT && savedT.gender) || 'all';
    var rows = items.map(function (it) {
      return '<div class="igpost-row">' +
        '<div class="igpost-row-thumb cr-stage-scaler" data-dkt="' + esc(it.key) + '"></div>' +
        '<div class="igpost-row-body"><strong>' + esc(it.spec.angle || it.spec.name || it.key) + '</strong>' +
          '<span class="u-faint">' + (it.spec.kind === 'video' ? 'video dark ad' : 'image dark ad') + ' · CTA link → its landing page</span></div>' +
        '<div class="igpost-row-state" data-dkstate="' + esc(it.key) + '">ready</div>' +
      '</div>';
    }).join('');
    // remember the whole targeting setup on the round so reopening the modal
    // (or reloading) never loses an Optimize or manual tweaks
    function persistTargeting(m, why) {
      updateRound(pid, rid, { darkTargeting: {
        budget: m.querySelector('#dk-budget').value.trim(),
        days: m.querySelector('#dk-days').value.trim(),
        countries: m.querySelector('#dk-countries').value,
        ageMin: m.querySelector('#dk-agemin').value,
        ageMax: m.querySelector('#dk-agemax').value,
        gender: m.querySelector('#dk-gender').value,
        includeFb: m.querySelector('#dk-fb').checked,
        interests: (m.__ints || []).slice(),
        why: why != null ? why : ((m.querySelector('#dk-why') || {}).textContent || ''),
        at: util.nowISO()
      } });
    }
    Ads.modal({
      title: '🌑 Dark ads for ' + (r.name || 'this round'), wide: true,
      body: '<p class="u-muted">Creates one paused campaign in ad account <strong>' + esc(conf.adAccountName || conf.adAccountId) + '</strong>' +
          (conf.igUsername ? ', delivering as <strong>@' + esc(conf.igUsername) + '</strong>' : '') +
          ' — none of it appears on the profile, and nothing spends until you activate the ads in Ads Manager.</p>' +
        (r.dark && r.dark.campaignId ? '<div class="hint" style="margin-bottom:1rem">⚠ This round already has a dark campaign — running again creates a NEW one (the old one stays in Ads Manager).</div>' : '') +
        '<div class="pp-quick">' +
          '<div class="field" style="max-width:15rem;margin:0"><label>TOTAL budget (' + esc(conf.currency || 'USD') + ')</label><input class="input" id="dk-budget" inputmode="decimal" placeholder="20" value="' + esc(tBudget) + '"></div>' +
          '<div class="field" style="max-width:8rem;margin:0"><label>Days</label><input class="input" id="dk-days" inputmode="numeric" value="' + esc(tDays) + '"></div>' +
          '<div class="field" style="max-width:16rem;margin:0"><label>Countries</label><input class="input" id="dk-countries" value="' + esc(tCountries) + '" placeholder="CA, US, GB…"></div>' +
          '<div class="field" style="max-width:8rem;margin:0"><label>Age min</label><input class="input" id="dk-agemin" inputmode="numeric" value="' + esc(tAgeMin) + '"></div>' +
          '<div class="field" style="max-width:8rem;margin:0"><label>Age max</label><input class="input" id="dk-agemax" inputmode="numeric" value="' + esc(tAgeMax) + '"></div>' +
          '<div class="field" style="max-width:11rem;margin:0"><label>Gender</label><select class="select" id="dk-gender">' +
            ['all', 'women', 'men'].map(function (g) { return '<option value="' + g + '"' + (g === tGender ? ' selected' : '') + '>' + (g === 'all' ? 'Everyone' : g.charAt(0).toUpperCase() + g.slice(1)) + '</option>'; }).join('') +
          '</select></div>' +
          '<label class="pp-chip" style="align-self:flex-end"><input type="checkbox" id="dk-fb"' + (savedT && savedT.includeFb ? ' checked' : '') + '><span>also Facebook feed</span></label>' +
        '</div>' +
        '<p class="u-faint" id="dk-explain" style="margin:0.4rem 0 1rem;font-size:1.18rem"></p>' +
        '<div class="field"><label>Detailed targeting — interests (from Meta’s catalog)</label>' +
          '<div class="dk-chips" id="dk-ints"><span class="u-faint" style="font-size:1.12rem">none yet — add below or press Optimize</span></div>' +
          '<div style="display:flex;gap:0.8rem;margin-top:0.6rem">' +
            '<input class="input" id="dk-int-add" placeholder="type an interest and press Enter (e.g. Genealogy)" style="max-width:34rem">' +
            '<button class="btn is-primary is-sm" id="dk-opt">✨ Optimize targeting for this round</button>' +
          '</div>' +
          '<div class="hint" id="dk-why" style="margin-top:0.6rem"></div>' +
        '</div>' +
        '<div class="igpost-list">' + rows + '</div>' +
        '<div class="gh-status" id="dk-status"></div>',
      foot: [
        { label: 'Create ' + items.length + ' dark ad' + (items.length === 1 ? '' : 's') + ' (paused)', act: 'go', primary: true },
        { label: 'Cancel', act: 'cancel', ghost: true }
      ],
      onMount: function (m) {
        m.querySelectorAll('[data-dkt]').forEach(function (n) {
          var it = items.filter(function (x) { return x.key === n.getAttribute('data-dkt'); })[0];
          if (it) { try { mountThumbFitted(n, it.spec, 90, 110); } catch (e) {} }
        });
        // editing budget/targeting invalidates an armed confirm — the number
        // you confirm must be the number that runs
        function disarm() {
          m.__dkArmed = false;
          var g = m.querySelector('[data-mact="go"]');
          if (g && !g.disabled) g.textContent = 'Create ' + items.length + ' dark ad' + (items.length === 1 ? '' : 's') + ' (paused)';
        }
        ['dk-budget', 'dk-days', 'dk-countries', 'dk-agemin', 'dk-agemax', 'dk-fb', 'dk-gender'].forEach(function (id) {
          var n = m.querySelector('#' + id); if (!n) return;
          n.addEventListener(id === 'dk-fb' || id === 'dk-gender' ? 'change' : 'input', disarm);
        });
        // live plain-money breakdown: total ÷ days ÷ ads, plus the hard end date
        function updateExplain() {
          var ex = m.querySelector('#dk-explain'); if (!ex) return;
          var cur = conf.currency || 'USD';
          var tot = parseFloat(m.querySelector('#dk-budget').value);
          var d = Math.min(90, Math.max(1, parseInt(m.querySelector('#dk-days').value, 10) || 0));
          if (!(tot > 0) || !d) { ex.textContent = 'Set a TOTAL budget and how many days it runs — the campaign stops automatically and can never spend more than the total.'; return; }
          var endD = new Date(Date.now() + d * 86400 * 1000);
          var perDay = tot / d, perAd = tot / items.length;
          ex.innerHTML = '<strong>' + tot + ' ' + esc(cur) + ' total over ' + d + ' day' + (d === 1 ? '' : 's') + '</strong> — about ' +
            (Math.round(perDay * 100) / 100) + ' ' + esc(cur) + '/day shared by ' + items.length + ' ad' + (items.length === 1 ? '' : 's') +
            ' ≈ ' + (Math.round(perAd * 100) / 100) + ' ' + esc(cur) + ' per ad overall if they perform equally (Meta gives more to whichever performs better). ' +
            'Ends automatically on <strong>' + endD.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '</strong> — total spend can never exceed ' + tot + ' ' + esc(cur) + '.';
        }
        updateExplain();
        m.querySelector('#dk-budget').addEventListener('input', updateExplain);
        m.querySelector('#dk-days').addEventListener('input', updateExplain);
        // ---- interest chips + AI optimize ----
        m.__ints = [];
        var intBox = m.querySelector('#dk-ints');
        function renderInts() {
          if (!m.__ints.length) { intBox.innerHTML = '<span class="u-faint" style="font-size:1.12rem">none yet — add below or press Optimize</span>'; return; }
          intBox.innerHTML = m.__ints.map(function (x, i) {
            return '<span class="dk-chip">' + esc(x.name) + (x.size ? ' <em>' + (x.size > 1e6 ? Math.round(x.size / 1e6) + 'M' : Math.round(x.size / 1e3) + 'K') + '</em>' : '') +
              '<button data-dki="' + i + '" title="remove">×</button></span>';
          }).join('');
          intBox.querySelectorAll('[data-dki]').forEach(function (b) {
            b.addEventListener('click', function () { m.__ints.splice(+b.getAttribute('data-dki'), 1); renderInts(); disarm(); });
          });
        }
        function addInterest(q, silent) {
          return ai().madsInterests(q).then(function (results) {
            var top = results[0];
            if (!top) { if (!silent) Ads.toast('Meta has no interest matching “' + q + '”', true); return; }
            if (m.__ints.some(function (x) { return x.id === top.id; })) return;
            m.__ints.push(top); renderInts(); disarm();
          }).catch(function (e) { if (!silent) Ads.toast(e.message, true); });
        }
        // restore the remembered targeting (interests + reasoning)
        if (savedT) {
          m.__ints = (savedT.interests || []).slice();
          renderInts();
          var whyEl0 = m.querySelector('#dk-why');
          if (whyEl0 && savedT.why) whyEl0.textContent = savedT.why;
        }
        var intAdd = m.querySelector('#dk-int-add');
        intAdd.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          var q = intAdd.value.trim(); if (!q) return;
          intAdd.value = '';
          addInterest(q, false).then(function () { persistTargeting(m); });
        });
        m.querySelector('#dk-opt').addEventListener('click', function () {
          var why = m.querySelector('#dk-why');
          var optBtn = m.querySelector('#dk-opt');
          optBtn.disabled = true; optBtn.innerHTML = '<span class="spinner"></span> Reading the audience research…';
          var pNow = store.getProject(pid);
          var ctx = '== AUDIENCE RESEARCH (primary source — aim at its PRIMARY segment) ==\n' +
            (pNow && pNow.audience && pNow.audience.data ? JSON.stringify(pNow.audience.data).slice(0, 9000) : 'No audience analysis — infer from the ads and dossier.') +
            '\n\n== WHAT THE BUSINESS IS ==\n' + ((pNow && pNow.dossier && pNow.dossier.text) || '').slice(0, 2500) +
            '\n\n== THE ADS IN THIS ROUND ==\n' + items.map(function (it) {
              return '- ' + (it.spec.angle || it.spec.name || it.key) + ' | ' + (((it.spec.headlineStart || '') + ' ' + (it.spec.headlineHighlight || '')).trim());
            }).join('\n');
          ai().darkTarget({ context: ctx }).then(function (t) {
            if (t.countries && t.countries.length) m.querySelector('#dk-countries').value = t.countries.join(', ');
            if (t.ageMin) m.querySelector('#dk-agemin').value = t.ageMin;
            if (t.ageMax) m.querySelector('#dk-agemax').value = t.ageMax;
            m.querySelector('#dk-gender').value = t.gender || 'all';
            disarm();
            if (why) why.textContent = t.why || '';
            // resolve the suggested interests against Meta's catalog, in order
            var qi = 0, kws = t.interests || [];
            optBtn.innerHTML = '<span class="spinner"></span> Matching interests on Meta…';
            (function nextKw() {
              if (qi >= kws.length) {
                optBtn.disabled = false; optBtn.textContent = '✨ Optimize targeting for this round';
                if (why) why.textContent = (t.why || '') + (m.__ints.length ? ' — ' + m.__ints.length + ' interests matched in Meta’s catalog.' : ' — no interests matched; add some manually.');
                persistTargeting(m);   // the optimized setup survives closing the modal
                return;
              }
              addInterest(kws[qi++], true).then(nextKw);
            })();
          }).catch(function (e) {
            optBtn.disabled = false; optBtn.textContent = '✨ Optimize targeting for this round';
            Ads.toast(e.noKey ? 'Turn on AI (top-right) to use Optimize' : e.message, true);
          });
        });
      },
      onAction: function (act, m) {
        if (act === 'cancel') return Ads.closeModal();
        if (act !== 'go') return;
        var budget = parseFloat(m.querySelector('#dk-budget').value);
        if (!(budget > 0)) return Ads.toast('Set the TOTAL budget — the most this round can ever spend', true);
        var dkDays = Math.min(90, Math.max(1, parseInt(m.querySelector('#dk-days').value, 10) || 0));
        if (!dkDays) return Ads.toast('Set how many days the round runs', true);
        var countries = m.querySelector('#dk-countries').value.split(',').map(function (c) { return c.trim().toUpperCase(); }).filter(function (c) { return /^[A-Z]{2}$/.test(c); });
        if (!countries.length) return Ads.toast('Give at least one 2-letter country code (e.g. CA, US)', true);
        var goBtn = m.querySelector('[data-mact="go"]');
        if (!m.__dkArmed) {
          m.__dkArmed = true;
          var endStr = new Date(Date.now() + dkDays * 86400 * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          if (goBtn) goBtn.textContent = '⚠ PAUSED campaign: ' + items.length + ' ad' + (items.length === 1 ? '' : 's') + ' · ' + budget + ' ' + (conf.currency || 'USD') + ' TOTAL · ' + dkDays + ' day' + (dkDays === 1 ? '' : 's') + ' (ends ' + endStr + ') — press again to confirm';
          return;
        }
        if (goBtn) { goBtn.disabled = true; goBtn.innerHTML = '<span class="spinner"></span> Working…'; }
        persistTargeting(m);   // whatever launches is what's remembered
        var status = m.querySelector('#dk-status');
        function setRow(key, html) { var el2 = m.querySelector('[data-dkstate="' + key + '"]'); if (el2) el2.innerHTML = html; }
        // 1. render every creative locally (images → JPEG bytes, videos → MP4
        //    staged publicly + poster thumb), 2. one server job builds the chain
        var payloadAds = [], pi = 0;
        (function prep() {
          if (pi >= items.length) return launch();
          var it = items[pi++];
          setRow(it.key, '<span class="spinner"></span> rendering…');
          var link = publicLinkBase() + '/a/' + it.key + '?s=ig';
          if (it.spec.kind === 'video') {
            Ads.video.exportVideo(it.spec).then(function (rr) {
              if (rr.ext !== 'mp4') throw new Error('browser exported ' + rr.ext + ' — Meta needs MP4 (use Chrome)');
              setRow(it.key, '<span class="spinner"></span> uploading…');
              return ai().metaStage(rr.blob, it.key + '-dark.mp4').then(function (staged) {
                return Ads.video.posterBlob(it.spec).then(creativeToJpeg).then(blobToB64).then(function (thumb) {
                  payloadAds.push({ adKey: it.key, name: it.spec.angle || it.spec.name || it.key, kind: 'video', videoUrl: staged.url, thumbB64: thumb, caption: it.spec.caption || '', link: link });
                  setRow(it.key, 'ready to submit');
                  prep();
                });
              });
            }).catch(function (e) { setRow(it.key, '<span style="color:var(--bad,#e5704f)">✗ ' + esc((e.message || 'render failed').slice(0, 90)) + '</span>'); prep(); });
          } else {
            render.exportPNG(it.spec).then(creativeToJpeg).then(blobToB64).then(function (b64) {
              payloadAds.push({ adKey: it.key, name: it.spec.angle || it.spec.name || it.key, kind: 'image', imageB64: b64, caption: it.spec.caption || '', link: link });
              setRow(it.key, 'ready to submit');
              prep();
            }).catch(function (e) { setRow(it.key, '<span style="color:var(--bad,#e5704f)">✗ ' + esc((e.message || 'render failed').slice(0, 90)) + '</span>'); prep(); });
          }
        })();
        function launch() {
          if (!payloadAds.length) {
            if (status) status.textContent = 'Nothing rendered successfully — nothing was sent to Meta.';
            if (goBtn) { goBtn.disabled = false; goBtn.textContent = 'Retry'; m.__dkArmed = false; }
            return;
          }
          if (status) status.innerHTML = '<span class="spinner"></span> Creating the paused campaign on Meta…';
          var genderSel = m.querySelector('#dk-gender').value;
          ai().madsDark({
            roundId: rid, roundName: r.name, budget: budget, days: dkDays, countries: countries,
            ageMin: m.querySelector('#dk-agemin').value, ageMax: m.querySelector('#dk-agemax').value,
            includeFb: m.querySelector('#dk-fb').checked,
            genders: genderSel === 'women' ? [2] : genderSel === 'men' ? [1] : [],
            interests: m.__ints || [],
            ads: payloadAds,
            idem: 'dark:' + rid + ':' + (r.dark && r.dark.campaignId ? r.dark.campaignId : 'first')
          }, function (note) { if (status) status.innerHTML = '<span class="spinner"></span> ' + esc(note); })
            .then(function (result) {
              var ok = 0, failed = 0;
              Object.keys(result.ads || {}).forEach(function (k) {
                if (result.ads[k].adId) { ok++; setRow(k, '✓ created (paused)'); }
                else { failed++; setRow(k, '<span style="color:var(--bad,#e5704f)">✗ ' + esc((result.ads[k].error || 'failed').slice(0, 90)) + '</span>'); }
              });
              // archive the previous run — its (possibly ACTIVE, spending) ads
              // must keep syncing and showing, never silently vanish
              var pF = store.getProject(pid);
              var rF = (pF && projRounds(pF).filter(function (x) { return x.id === rid; })[0]) || r;
              var runs = (rF.darkRuns || []).slice();
              if (rF.dark && rF.dark.campaignId && rF.dark.campaignId !== result.campaignId) runs.push(rF.dark);
              updateRound(pid, rid, {
                dark: { campaignId: result.campaignId, adsetId: result.adsetId, budget: budget, days: dkDays, currency: conf.currency || 'USD', at: util.nowISO(), ads: result.ads },
                darkRuns: runs
              });
              var actNum = String(conf.adAccountId || '').replace(/^act_/, '');
              if (status) status.innerHTML = ok + ' dark ad' + (ok === 1 ? '' : 's') + ' created PAUSED' + (failed ? ' · ' + failed + ' failed' : '') +
                ' — <a href="https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=' + esc(actNum) + '" target="_blank" rel="noopener">open Ads Manager</a> to review targeting and switch them on.';
              if (goBtn) { goBtn.textContent = 'Done'; goBtn.disabled = false; goBtn.setAttribute('data-mact', 'cancel'); }
              Ads.toast(ok + ' paused dark ad' + (ok === 1 ? '' : 's') + ' created — activate in Ads Manager', !!failed && !ok);
              Ads.go('rounds');
            })
            .catch(function (e) {
              var extra = '';
              if (e.partial && e.partial.campaignId) {
                extra = ' A paused campaign was already created before the failure — pressing Retry RESUMES it (no duplicate).';
              }
              if (status) status.innerHTML = '<span style="color:var(--bad,#e5704f)">✗ ' + esc((e.message || 'failed').slice(0, 200)) + '</span>' + esc(extra);
              if (goBtn) { goBtn.disabled = false; goBtn.textContent = 'Retry'; m.__dkArmed = false; }
            });
        }
      }
    });
  }
  function igSetupModal(p, r) {
      Ads.modal({
        title: 'Connect Instagram to post directly', wide: true,
        body: '<p class="u-muted">One-time setup — <strong>no Facebook Page, no Business Manager</strong>. Ads Hub then publishes this round straight to your Instagram:</p>' +
          '<ol style="margin:1.2rem 0 1.2rem 2rem;line-height:1.9;font-size:1.3rem">' +
            '<li>In the Instagram app: switch the account to a <strong>professional account</strong> (Settings → Account type)</li>' +
            '<li>At <strong>developers.facebook.com</strong> (free developer login): create an app → add the <strong>Instagram</strong> product → “API setup with Instagram business login”</li>' +
            '<li>Log in there with the Instagram account and approve <strong>instagram_business_basic</strong>, <strong>instagram_business_content_publish</strong>, <strong>instagram_business_manage_insights</strong></li>' +
            '<li>Copy the access token it shows and paste it in <strong>Performance → Instagram</strong> — this button then publishes for real</li>' +
          '</ol>' +
          '<p class="u-muted">Budget note: this path publishes the posts; putting money behind one is a manual <strong>Boost</strong> tap in the Instagram app. Fully automatic paid campaigns (spend + CPC syncing back here) are a later upgrade — that’s the only part that needs Meta Business Manager and a (never-used) Facebook Page.</p>' +
          '<p class="u-muted">Until then, post manually: each ad’s platform links are one click away below.</p>' +
          '<div class="btn-row" style="margin-top:1.4rem"><button class="btn is-ghost is-sm" id="pp-links">Open the round’s links</button></div>',
        foot: [{ label: 'Close', act: 'cancel', ghost: true }],
        onMount: function (m) {
          var lb = m.querySelector('#pp-links');
          if (lb) lb.addEventListener('click', function () { Ads.closeModal(); roundDetail(p.id, r.id); });
        },
        onAction: function (act) { if (act === 'cancel') Ads.closeModal(); }
      });
  }

  /* ---- Direct Instagram posting ------------------------------------------ */
  // Instagram feed images must be JPEG (no alpha) 320–1440px wide, aspect
  // 4:5 … 1.91:1 — pad out-of-range renders onto a dark canvas instead of
  // letting Meta reject them.
  function creativeToJpeg(pngBlob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(pngBlob);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = Math.min(1440, img.naturalWidth || 1080);
        var h = Math.round((img.naturalHeight || 1080) * w / (img.naturalWidth || 1080));
        var cw = w, ch = h;
        if (ch / cw > 1.25) cw = Math.ceil(ch / 1.25);        // too tall (e.g. 9:16 story) → pad sides to 4:5
        if (cw / ch > 1.91) ch = Math.ceil(cw / 1.91);        // too wide → pad top/bottom
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        var x = c.getContext('2d');
        x.fillStyle = '#0a0a0c'; x.fillRect(0, 0, cw, ch);
        x.drawImage(img, Math.round((cw - w) / 2), Math.round((ch - h) / 2), w, h);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('JPEG conversion failed')); }, 'image/jpeg', 0.92);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read the rendered image')); };
      img.src = url;
    });
  }
  function igCaptionFor(spec) {
    var cap = String(spec.caption || ((spec.headlineStart || '') + ' ' + (spec.headlineHighlight || '')).trim() || '');
    var link = publicLinkBase() + '/a/' + spec.adKey + '?s=ig';
    // Instagram caps captions at 2200 chars — trim the TEXT, never the link
    var room = 2200 - link.length - 2;
    if (cap.length > room) cap = cap.slice(0, Math.max(0, room - 1)) + '…';
    return (cap ? cap + '\n\n' : '') + link;
  }
  function openIgPostFlow(pid, rid) {
    var p = store.getProject(pid); if (!p) return;
    var r = projRounds(p).filter(function (x) { return x.id === rid; })[0]; if (!r) return;
    var byKey = savedByKey(p);
    var items = r.adKeys.map(function (k) {
      var a = byKey[k]; if (!a) return null;
      return { key: k, spec: a, posted: !!((r.igPosts || {})[k]) };
    }).filter(Boolean);
    var fresh = items.filter(function (it) { return !it.posted; });
    var rows = items.map(function (it) {
      return '<div class="igpost-row" data-igrow="' + esc(it.key) + '">' +
        '<div class="igpost-row-thumb cr-stage-scaler" data-igt="' + esc(it.key) + '"></div>' +
        '<div class="igpost-row-body">' +
          '<strong>' + esc(it.spec.angle || it.spec.name || it.key) + '</strong>' +
          '<span class="u-faint">' + (it.spec.kind === 'video' ? 'publishes as a Reel' : 'publishes as a feed photo') + '</span>' +
          '<div class="igpost-cap">' + esc(igCaptionFor(it.spec).slice(0, 220)) + '</div>' +
        '</div>' +
        '<div class="igpost-row-state" data-igstate="' + esc(it.key) + '">' + (it.posted
          ? '✓ posted<br><label style="cursor:pointer;user-select:none"><input type="checkbox" data-igrepost="' + esc(it.key) + '"> post again</label>'
          : 'ready') + '</div>' +
      '</div>';
    }).join('');
    Ads.modal({
      title: '🚀 Post this round to Instagram', wide: true,
      body: '<p class="u-muted">Each ad publishes to your Instagram with its tracked link in the caption (links in captions aren’t tappable on Instagram — the click data mainly flows once you Boost, or via link-in-bio; the post itself still lands the message). Videos render before uploading — leave this open until every row shows ✓.</p>' +
        '<div class="igpost-list">' + rows + '</div>' +
        '<div class="gh-status" id="igpost-status"></div>',
      foot: [
        { label: 'Post ' + fresh.length + ' ad' + (fresh.length === 1 ? '' : 's') + ' now', act: 'go', primary: true },
        { label: 'Cancel', act: 'cancel', ghost: true }
      ],
      onMount: function (m) {
        m.querySelectorAll('[data-igt]').forEach(function (n) {
          var it = items.filter(function (x) { return x.key === n.getAttribute('data-igt'); })[0];
          if (it) { try { mountThumbFitted(n, it.spec, 90, 110); } catch (e) {} }
        });
        // ticking "post again" on an already-posted ad adds it to the run;
        // the button count follows and any armed confirm resets
        m.querySelectorAll('[data-igrepost]').forEach(function (c) {
          c.addEventListener('change', function () {
            var goBtn = m.querySelector('[data-mact="go"]');
            var n = fresh.length + m.querySelectorAll('[data-igrepost]:checked').length;
            if (goBtn) goBtn.textContent = 'Post ' + n + ' ad' + (n === 1 ? '' : 's') + ' now';
            m.__igArmed = false;
          });
        });
      },
      onAction: function (act, m) {
        if (act === 'cancel') return Ads.closeModal();
        if (act !== 'go') return;
        // recompute the pending set from the STORE — never the stale closure —
        // so pressing the button again can only ever post what isn't live yet
        var pNow = store.getProject(pid);
        var rNow = pNow && projRounds(pNow).filter(function (x) { return x.id === rid; })[0];
        var postedNow = (rNow && rNow.igPosts) || {};
        var repost = {};
        m.querySelectorAll('[data-igrepost]').forEach(function (c) { if (c.checked) repost[c.getAttribute('data-igrepost')] = 1; });
        var pending = items.filter(function (it) { return !postedNow[it.key] || repost[it.key]; });
        pending.forEach(function (it) { it.priorId = postedNow[it.key] ? String(postedNow[it.key].id || 'r') : ''; });
        if (!pending.length) { Ads.toast('Everything is already posted — tick “post again” on an ad to repost it', true); return; }
        var goBtn = m.querySelector('[data-mact="go"]');
        // explicit two-press confirm: nothing publishes on the first click
        if (!m.__igArmed) {
          m.__igArmed = true;
          if (goBtn) goBtn.textContent = '⚠ About to post ' + pending.length + ' ad' + (pending.length === 1 ? '' : 's') + ' to Instagram — press again to confirm';
          var stEl = m.querySelector('#igpost-status');
          if (stEl) stEl.textContent = 'Nothing has been posted yet. Press the button again to publish for real, or Cancel.';
          return;
        }
        if (goBtn) { goBtn.disabled = true; goBtn.innerHTML = '<span class="spinner"></span> Posting…'; }
        var status = m.querySelector('#igpost-status');
        var done = 0, failed = 0, i = 0;
        function setRow(key, html) { var el2 = m.querySelector('[data-igstate="' + key + '"]'); if (el2) el2.innerHTML = html; }
        function finish() {
          if (status) status.textContent = done + ' posted' + (failed ? ', ' + failed + ' failed — press the button again to retry just those' : ' — all live on Instagram');
          if (goBtn) {
            goBtn.disabled = false;
            if (failed) { goBtn.textContent = 'Retry failed'; }
            else { goBtn.textContent = 'Done'; goBtn.setAttribute('data-mact', 'cancel'); }   // a re-click now just closes
          }
          Ads.toast(done + ' ad' + (done === 1 ? '' : 's') + ' posted to Instagram' + (failed ? ' · ' + failed + ' failed' : ''), !!failed && !done);
          Ads.go('rounds');
        }
        (function next() {
          if (i >= pending.length) return finish();
          var it = pending[i++];
          var isVideo = it.spec.kind === 'video';
          setRow(it.key, '<span class="spinner"></span> rendering…');
          var renderP = isVideo
            ? Ads.video.exportVideo(it.spec).then(function (rr) {
                if (rr.ext !== 'mp4') throw new Error('this browser exported ' + rr.ext.toUpperCase() + ' — Instagram needs MP4 (use Chrome)');
                return { blob: rr.blob, name: it.key + '.mp4', kind: 'video' };
              })
            : render.exportPNG(it.spec).then(creativeToJpeg).then(function (b) {
                return { blob: b, name: it.key + '.jpg', kind: 'image' };
              });
          renderP.then(function (media) {
            setRow(it.key, '<span class="spinner"></span> uploading…');
            return ai().metaStage(media.blob, media.name).then(function (staged) {
              setRow(it.key, '<span class="spinner"></span> publishing' + (media.kind === 'video' ? ' (reels take a minute)…' : '…'));
              // deliberate reposts get a new idempotency key (suffixed with the
              // prior media id) so the anti-double-post lock doesn't block them,
              // while retries of THIS attempt still collapse into one job
              return ai().metaPost({ kind: media.kind, url: staged.url, caption: igCaptionFor(it.spec), idem: rid + ':' + it.key + (it.priorId ? ':' + it.priorId : '') });
            });
          }).then(function (out) {
            done++;
            setRow(it.key, '✓ live' + (out.permalink ? ' — <a href="' + esc(out.permalink) + '" target="_blank" rel="noopener">open</a>' : ''));
            // persist on the ROUND, re-read fresh so parallel edits aren’t lost
            var p2 = store.getProject(pid);
            var r2 = p2 && projRounds(p2).filter(function (x) { return x.id === rid; })[0];
            if (r2) {
              var posts = Object.assign({}, r2.igPosts || {});
              posts[it.key] = { id: out.mediaId, permalink: out.permalink || '', at: util.nowISO(), kind: isVideo ? 'video' : 'image' };
              updateRound(pid, rid, { igPosts: posts });
            }
            next();
          }).catch(function (e) {
            failed++;
            setRow(it.key, '<span style="color:var(--bad,#e5704f)">✗ ' + esc((e && e.message || 'failed').slice(0, 120)) + '</span>');
            next();
          });
        })();
      }
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
        '<div class="rnd-thumbwrap"><div class="rnd-thumb cr-stage-scaler" data-rt="' + esc(key) + '"></div></div>' +
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
    var base = publicLinkBase();   // these links go ON posted ads — public address
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
