/* ============================================================================
   ADS HUB — utilities
   Pure helpers: escaping, ids, formatting, files, CSV, download. window.Ads.util
   ========================================================================== */
window.Ads = window.Ads || {};
// View registry — defined here (first module) so every later module can register.
Ads.views = Ads.views || {};
Ads.registerView = Ads.registerView || function (id, def) { Ads.views[id] = def; };

(function () {
  'use strict';

  var util = {
    uid: function (p) { return (p || 'id') + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); },

    escapeHtml: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    clamp: function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); },

    slug: function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'ad'; },

    debounce: function (fn, ms) {
      var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); };
    },

    // Numbers ----------------------------------------------------------------
    // Coerce loose input ("$1,200", "3.2%", "") to a number or null.
    num: function (v) {
      if (v == null || v === '') return null;
      if (typeof v === 'number') return isFinite(v) ? v : null;
      var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
      return isFinite(n) ? n : null;
    },
    fmtNum: function (n, dp) {
      if (n == null || isNaN(n)) return '—';
      return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp || 0, maximumFractionDigits: dp == null ? 0 : dp });
    },
    fmtCompact: function (n) {
      if (n == null || isNaN(n)) return '—';
      var a = Math.abs(n);
      if (a >= 1e9) return (n / 1e9).toFixed(a % 1e9 === 0 ? 0 : 1) + 'B';
      if (a >= 1e6) return (n / 1e6).toFixed(a % 1e6 === 0 ? 0 : 1) + 'M';
      if (a >= 1e3) return (n / 1e3).toFixed(a % 1e3 === 0 ? 0 : 1) + 'K';
      return String(Math.round(n));
    },
    fmtMoney: function (n, sym, dp) {
      sym = sym || '$';
      if (n == null || isNaN(n)) return '—';
      return sym + Number(n).toLocaleString('en-US', { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 2 : dp });
    },
    fmtMoneyShort: function (n, sym) {
      sym = sym || '$';
      if (n == null || isNaN(n)) return '—';
      return sym + util.fmtCompact(n);
    },
    fmtPct: function (n, dp) {
      if (n == null || isNaN(n)) return '—';
      return (n).toFixed(dp == null ? 2 : dp) + '%';
    },

    // Dates ------------------------------------------------------------------
    nowISO: function () { var d = new Date(); return d.toISOString(); },
    todayISO: function () { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
    fmtDate: function (s) {
      if (!s) return '—';
      var d = new Date(s); if (isNaN(d)) return '—';
      var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return d.getDate() + ' ' + M[d.getMonth()] + ' ' + d.getFullYear();
    },
    fmtDateTime: function (s) {
      if (!s) return '—'; var d = new Date(s); if (isNaN(d)) return '—';
      return util.fmtDate(s) + ' · ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    },
    timeAgo: function (s) {
      if (!s) return 'never'; var d = new Date(s); if (isNaN(d)) return '—';
      var sec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
      if (sec < 45) return 'just now';
      var mins = Math.round(sec / 60); if (mins < 60) return mins + ' min' + (mins === 1 ? '' : 's') + ' ago';
      var hrs = Math.round(mins / 60); if (hrs < 24) return hrs + ' hour' + (hrs === 1 ? '' : 's') + ' ago';
      var days = Math.round(hrs / 24); if (days < 30) return days + ' day' + (days === 1 ? '' : 's') + ' ago';
      return util.fmtDate(s);
    },

    // Files ------------------------------------------------------------------
    fileToDataURL: function (file) {
      return new Promise(function (res, rej) {
        var r = new FileReader();
        r.onload = function () { res(r.result); };
        r.onerror = rej;
        r.readAsDataURL(file);
      });
    },

    downloadBlob: function (blob, filename) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    },
    downloadText: function (text, filename, mime) {
      util.downloadBlob(new Blob([text], { type: mime || 'text/plain' }), filename);
    },

    // CSV --------------------------------------------------------------------
    // Minimal RFC-4180-ish parser → array of row-objects keyed by header.
    parseCSV: function (text) {
      text = String(text).replace(/^﻿/, '');
      var rows = [], row = [], field = '', i = 0, inQ = false, c;
      while (i < text.length) {
        c = text[i];
        if (inQ) {
          if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
          else field += c;
        } else {
          if (c === '"') inQ = true;
          else if (c === ',') { row.push(field); field = ''; }
          else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
          else if (c === '\r') { /* skip */ }
          else field += c;
        }
        i++;
      }
      if (field.length || row.length) { row.push(field); rows.push(row); }
      if (!rows.length) return [];
      var headers = rows.shift().map(function (h) { return String(h).trim(); });
      return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); })
        .map(function (r) {
          var o = {}; headers.forEach(function (h, j) { o[h] = r[j] != null ? r[j].trim() : ''; }); return o;
        });
    },

    toCSV: function (rows, columns) {
      function cell(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
      var head = columns.map(function (c) { return cell(c.label); }).join(',');
      var body = rows.map(function (r) { return columns.map(function (c) { return cell(typeof c.get === 'function' ? c.get(r) : r[c.key]); }).join(','); }).join('\n');
      return head + '\n' + body;
    }
  };

  Ads.util = util;
})();
