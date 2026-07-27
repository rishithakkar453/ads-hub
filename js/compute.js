/* ============================================================================
   ADS HUB — metrics & insights engine
   Derives KPIs from raw inputs, rolls up the portfolio, computes benchmarks,
   and produces rules-based "what to do next" optimisation insights.
   Exposes window.Ads.compute.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var util = Ads.util;

  // Display metadata for every metric. dir: which direction is "good".
  var METRICS = [
    { key: 'spend',       label: 'Spend',       type: 'money', input: true,  dir: null  },
    { key: 'impressions', label: 'Impressions', type: 'int',   input: true,  dir: null  },
    { key: 'reach',       label: 'Reach',       type: 'int',   input: true,  dir: null  },
    { key: 'frequency',   label: 'Frequency',   type: 'dec',   input: true,  dir: 'low' },
    { key: 'clicks',      label: 'Clicks',      type: 'int',   input: true,  dir: 'high' },
    { key: 'ctr',         label: 'CTR',         type: 'pct',   input: false, dir: 'high' },
    { key: 'cpc',         label: 'CPC',         type: 'money', input: false, dir: 'low' },
    { key: 'cpm',         label: 'CPM',         type: 'money', input: false, dir: 'low' },
    { key: 'conversions', label: 'Conversions', type: 'int',   input: true,  dir: 'high' },
    { key: 'cvr',         label: 'CVR',         type: 'pct',   input: false, dir: 'high' },
    { key: 'cpa',         label: 'CPA',         type: 'money', input: false, dir: 'low' },
    { key: 'convValue',   label: 'Conv. value', type: 'money', input: true,  dir: 'high' },
    { key: 'roas',        label: 'ROAS',        type: 'x',     input: false, dir: 'high' }
  ];
  var INPUT_METRICS = METRICS.filter(function (m) { return m.input; });

  function fmtMetric(key, v, sym) {
    sym = sym || '$';
    if (v == null || isNaN(v)) return '—';
    var m = byKey(key);
    switch (m ? m.type : '') {
      case 'money': return util.fmtMoney(v, sym, v >= 1000 ? 0 : 2);
      case 'pct': return util.fmtPct(v, 2);
      case 'x': return (v).toFixed(2) + '×';
      case 'dec': return (v).toFixed(2);
      default: return util.fmtNum(v, 0);
    }
  }
  function byKey(k) { for (var i = 0; i < METRICS.length; i++) if (METRICS[i].key === k) return METRICS[i]; return null; }

  // Derive all KPIs for one ad (or any {metrics} object).
  function derive(ad) {
    var m = (ad && ad.metrics) || {};
    var spend = util.num(m.spend), imp = util.num(m.impressions), reach = util.num(m.reach),
        clicks = util.num(m.clicks), conv = util.num(m.conversions), val = util.num(m.convValue),
        freq = util.num(m.frequency);
    function div(a, b) { return (a != null && b) ? a / b : null; }
    return {
      spend: spend, impressions: imp, reach: reach, clicks: clicks, conversions: conv, convValue: val,
      frequency: freq != null ? freq : (imp != null && reach ? imp / reach : null),
      ctr: div(clicks, imp) != null ? div(clicks, imp) * 100 : null,
      cpc: div(spend, clicks),
      cpm: div(spend, imp) != null ? div(spend, imp) * 1000 : null,
      cvr: div(conv, clicks) != null ? div(conv, clicks) * 100 : null,
      cpa: div(spend, conv),
      roas: div(val, spend)
    };
  }

  function hasData(ad) { var d = derive(ad); return d.impressions != null && d.impressions > 0; }

  function median(arr) {
    var a = arr.filter(function (x) { return x != null && !isNaN(x); }).sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  // Roll up a set of ads: blended totals + per-metric benchmarks (medians).
  function portfolio(ads) {
    var withData = ads.filter(hasData);
    var sum = { spend: 0, impressions: 0, reach: 0, clicks: 0, conversions: 0, convValue: 0 };
    withData.forEach(function (a) {
      var d = derive(a);
      ['spend', 'impressions', 'reach', 'clicks', 'conversions', 'convValue'].forEach(function (k) { if (d[k] != null) sum[k] += d[k]; });
    });
    var blended = {
      spend: sum.spend, impressions: sum.impressions, reach: sum.reach, clicks: sum.clicks,
      conversions: sum.conversions, convValue: sum.convValue,
      ctr: sum.impressions ? sum.clicks / sum.impressions * 100 : null,
      cpc: sum.clicks ? sum.spend / sum.clicks : null,
      cpm: sum.impressions ? sum.spend / sum.impressions * 1000 : null,
      cvr: sum.clicks ? sum.conversions / sum.clicks * 100 : null,
      cpa: sum.conversions ? sum.spend / sum.conversions : null,
      roas: sum.spend ? sum.convValue / sum.spend : null
    };
    var ds = withData.map(derive);
    var bench = {};
    ['ctr', 'cpc', 'cpm', 'cvr', 'cpa', 'roas', 'frequency'].forEach(function (k) {
      bench[k] = median(ds.map(function (d) { return d[k]; }));
    });
    return { count: ads.length, withData: withData.length, totals: blended, bench: bench };
  }

  /* ---- Insight rules ----------------------------------------------------- */
  // Returns [{ sev:'good'|'warn'|'bad'|'info', tag, body }]. Ordered by impact.
  function insights(ad, bench, settings) {
    bench = bench || {}; settings = settings || {};
    var d = derive(ad);
    var out = [];
    var ctrT = util.num(settings.ctrTarget) || 1.0;
    var roasT = util.num(settings.roasTarget) || 2.0;
    var cpaT = util.num(settings.cpaTarget) || 40;

    if (d.impressions == null || d.impressions < 1000) {
      out.push({ sev: 'info', tag: 'Gathering data', body: 'Not enough delivery yet to judge. Let it spend until at least ~1,000 impressions before optimising.' });
      return out;
    }

    // ROAS — the headline decision
    if (d.roas != null) {
      if (d.roas >= roasT * 1.5 && d.spend >= 50) out.push({ sev: 'good', tag: 'Scale', body: 'ROAS of ' + d.roas.toFixed(2) + '× is well above your ' + roasT + '× target. <span class="em">Increase budget 20–30% and watch CPA hold.</span>' });
      else if (d.roas >= roasT) out.push({ sev: 'good', tag: 'Profitable', body: 'ROAS ' + d.roas.toFixed(2) + '× clears your ' + roasT + '× target. Keep funding it.' });
      else if (d.roas < roasT * 0.6 && d.spend >= 50) out.push({ sev: 'bad', tag: 'Pause / rework', body: 'ROAS ' + d.roas.toFixed(2) + '× is well under target. <span class="em">Pause, or rework the offer/landing page before spending more.</span>' });
      else out.push({ sev: 'warn', tag: 'Below target', body: 'ROAS ' + d.roas.toFixed(2) + '× is under your ' + roasT + '× target. Iterate the creative or audience.' });
    }

    // CTR — is the creative stopping the scroll?
    if (d.ctr != null) {
      var ctrLow = d.ctr < ctrT || (bench.ctr != null && d.ctr < bench.ctr * 0.7);
      var ctrHigh = (bench.ctr != null && d.ctr >= bench.ctr * 1.3) || d.ctr >= ctrT * 1.6;
      if (ctrLow) out.push({ sev: 'warn', tag: 'Weak hook', body: 'CTR ' + d.ctr.toFixed(2) + '% is low — the creative isn\'t stopping the scroll. <span class="em">Test a new headline, first frame, or format.</span>' });
      else if (ctrHigh) out.push({ sev: 'good', tag: 'Strong hook', body: 'CTR ' + d.ctr.toFixed(2) + '% beats the pack — this angle resonates. Make more variations of it.' });
    }

    // Click→convert gap (landing/offer)
    if (d.ctr != null && d.cvr != null && d.clicks >= 50 && bench.cvr != null && d.cvr < bench.cvr * 0.6 && d.ctr >= (bench.ctr || ctrT)) {
      out.push({ sev: 'warn', tag: 'Landing / offer gap', body: 'Good clicks but CVR is only ' + d.cvr.toFixed(2) + '% — people click then bounce. <span class="em">Check landing-page match, speed, and offer.</span>' });
    }

    // Fatigue
    if (d.frequency != null && d.frequency >= 3) out.push({ sev: 'warn', tag: 'Ad fatigue', body: 'Frequency ' + d.frequency.toFixed(1) + ' — the same people are seeing it repeatedly. Refresh the creative or widen the audience.' });

    // CPA efficiency
    if (d.cpa != null) {
      if (d.cpa > cpaT * 1.3) out.push({ sev: 'warn', tag: 'High CPA', body: 'CPA ' + util.fmtMoney(d.cpa, settings.currency, 2) + ' is above your ' + util.fmtMoney(cpaT, settings.currency, 0) + ' target.' });
      else if (d.cpa <= cpaT * 0.7 && d.conversions >= 3) out.push({ sev: 'good', tag: 'Efficient CPA', body: 'CPA ' + util.fmtMoney(d.cpa, settings.currency, 2) + ' is comfortably under target.' });
    }

    var order = { bad: 0, good: 1, warn: 2, info: 3 };
    out.sort(function (a, b) { return order[a.sev] - order[b.sev]; });
    return out;
  }

  // One-line portfolio recommendation set for the dashboard.
  function portfolioInsights(ads, bench, settings) {
    var scale = [], pause = [], fatigue = [];
    ads.forEach(function (a) {
      if (a.status === 'archived') return;
      var ins = insights(a, bench, settings);
      ins.forEach(function (i) {
        if (i.tag === 'Scale') scale.push(a);
        if (i.tag === 'Pause / rework') pause.push(a);
        if (i.tag === 'Ad fatigue') fatigue.push(a);
      });
    });
    return { scale: scale, pause: pause, fatigue: fatigue };
  }

  Ads.compute = {
    METRICS: METRICS, INPUT_METRICS: INPUT_METRICS, byKey: byKey, fmtMetric: fmtMetric,
    derive: derive, hasData: hasData, portfolio: portfolio, insights: insights, portfolioInsights: portfolioInsights, median: median
  };
})();
