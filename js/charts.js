/* ============================================================================
   ADS HUB — tiny SVG chart library (no deps). Monochrome + restrained accent.
   Exposes window.Ads.charts.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var esc = Ads.util.escapeHtml;

  function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  var charts = {
    // Horizontal bars. data = [{label, value, display, cls}]. cls: 'good'|'bad'|'alt'
    barsH: function (data, opts) {
      opts = opts || {}; data = data || [];
      var max = opts.max || Math.max.apply(null, data.map(function (d) { return d.value || 0; }).concat([1]));
      var rowH = opts.rowH || 30, gap = 10, labelW = opts.labelW || 150, valW = opts.valW || 78;
      var w = opts.width || 560, h = data.length * (rowH + gap) || 30;
      var trackX = labelW, trackW = w - labelW - valW;
      var rows = data.map(function (d, i) {
        var y = i * (rowH + gap);
        var bw = Math.max(2, ((d.value || 0) / max) * trackW);
        return '<text x="0" y="' + (y + rowH / 2 + 4) + '" style="fill:#fff;font-size:12px;letter-spacing:.02em">' + esc(trunc(d.label, 22)) + '</text>' +
          '<rect class="bar-bg" x="' + trackX + '" y="' + y + '" width="' + trackW + '" height="' + rowH + '"/>' +
          '<rect class="bar-fill ' + (d.cls || '') + '" x="' + trackX + '" y="' + y + '" width="' + bw.toFixed(1) + '" height="' + rowH + '"/>' +
          '<text x="' + w + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end" style="font-family:var(--font-display);font-size:14px;fill:#fff">' + esc(d.display != null ? d.display : d.value) + '</text>';
      }).join('');
      return '<div class="chart"><svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' + rows + '</svg></div>';
    },

    // Vertical columns. data = [{label, value, display, cls}]
    columns: function (data, opts) {
      opts = opts || {}; data = data || [];
      var w = opts.width || 640, h = opts.height || 220, padB = 34, padT = 22, padL = 6, padR = 6;
      var max = opts.max || Math.max.apply(null, data.map(function (d) { return d.value || 0; }).concat([1]));
      var n = data.length || 1, slot = (w - padL - padR) / n, bw = Math.min(opts.barWidth || 54, slot * 0.62), chartH = h - padB - padT;
      var cols = data.map(function (d, i) {
        var x = padL + i * slot + (slot - bw) / 2;
        var bh = Math.max(2, ((d.value || 0) / max) * chartH), y = padT + (chartH - bh);
        return '<rect class="col-fill ' + (d.cls || '') + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '"/>' +
          '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 7).toFixed(1) + '" text-anchor="middle" style="font-family:var(--font-display);font-size:12px;fill:#fff">' + esc(d.display != null ? d.display : d.value) + '</text>' +
          '<text class="axis-label" x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - 12) + '" text-anchor="middle">' + esc(trunc(d.label, 10)) + '</text>';
      }).join('');
      var baseline = '<line class="axis" x1="' + padL + '" y1="' + (padT + chartH) + '" x2="' + (w - padR) + '" y2="' + (padT + chartH) + '"/>';
      return '<div class="chart"><svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">' + baseline + cols + '</svg></div>';
    },

    donut: function (pct, opts) {
      opts = opts || {};
      var size = opts.size || 160, sw = opts.stroke || 16, r = (size - sw) / 2, cx = size / 2, cy = size / 2, circ = 2 * Math.PI * r;
      var val = Math.max(0, Math.min(1, pct)) * circ;
      var center = opts.centerText != null ? opts.centerText : (Math.round(pct * 100) + '%');
      return '<div class="chart"><svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
        '<circle class="donut-track" cx="' + cx + '" cy="' + cy + '" r="' + r + '" stroke-width="' + sw + '"/>' +
        '<circle class="donut-val" cx="' + cx + '" cy="' + cy + '" r="' + r + '" stroke-width="' + sw + '" stroke-dasharray="' + val.toFixed(2) + ' ' + (circ - val).toFixed(2) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>' +
        '<text class="donut-center" x="' + cx + '" y="' + (cy + 7) + '" text-anchor="middle" font-size="' + (size * 0.24) + '">' + esc(center) + '</text>' +
        '</svg></div>';
    }
  };

  Ads.charts = charts;
})();
