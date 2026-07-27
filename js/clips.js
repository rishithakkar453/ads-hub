/* ============================================================================
   ADS HUB — client-side video clip analyzer
   Given an uploaded video (object URL), find the BEST short clips entirely in
   the browser: sample downscaled frames, score each for sharpness / motion /
   exposure / colour / subject-contrast, detect shot cuts, then pick a handful
   of high-interest, temporally-diverse 1.5–3s windows. Each clip carries a
   poster still. No server, no ffmpeg, no libraries — canvas + getImageData.
   Exposes window.Ads.clips.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';

  var AW = 64;                 // analysis frame width (tiny = fast getImageData)
  var CLIP_LEN = 2.4, CLIP_MIN = 1.5, CLIP_MAX = 3.0, HOP = 0.3;
  var BUDGET_MS = 9000;        // hard wall so a huge file can't hang the tab

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function median(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return b[b.length >> 1]; }

  // seek a <video> to t and resolve once the frame has landed (watchdog guarded)
  function seek(v, t, ms) {
    return new Promise(function (res) {
      var done = false;
      function ok() { if (done) return; done = true; v.removeEventListener('seeked', ok); res(true); }
      v.addEventListener('seeked', ok);
      try { v.currentTime = t; } catch (e) { done = true; res(false); return; }
      setTimeout(function () { if (!done) { done = true; v.removeEventListener('seeked', ok); res(false); } }, ms || 600);
    });
  }

  // pull per-frame features off a 64px draw of the current video frame
  function features(cx, AH, prev) {
    var N = AW * AH;
    var d = cx.getImageData(0, 0, AW, AH).data;
    var gray = new Uint8Array(N), hist = new Uint16Array(16), sum = 0;
    var rgS = 0, ybS = 0, rgSq = 0, ybSq = 0, rSum = 0, gSum = 0, bSum = 0;
    for (var p = 0, q = 0; p < N; p++, q += 4) {
      var R = d[q], G = d[q + 1], B = d[q + 2];
      rSum += R; gSum += G; bSum += B;
      var g = (R * 77 + G * 150 + B * 29) >> 8; gray[p] = g; sum += g; hist[g >> 4]++;
      var rg = R - G, yb = 0.5 * (R + G) - B;
      rgS += rg; ybS += yb; rgSq += rg * rg; ybSq += yb * yb;
    }
    var meanG = sum / N, br = meanG / 255;
    var rgM = rgS / N, ybM = ybS / N;
    var rgStd = Math.sqrt(Math.max(0, rgSq / N - rgM * rgM));
    var ybStd = Math.sqrt(Math.max(0, ybSq / N - ybM * ybM));
    var color = clamp((Math.sqrt(rgStd * rgStd + ybStd * ybStd) + 0.3 * Math.sqrt(rgM * rgM + ybM * ybM)) / 55, 0, 1);
    // sharpness: mean |Laplacian| over interior (variance-of-Laplacian proxy)
    var lap = 0, c = 0;
    for (var y = 1; y < AH - 1; y++) for (var x = 1; x < AW - 1; x++) {
      var i = y * AW + x; lap += Math.abs(4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - AW] - gray[i + AW]); c++;
    }
    var sharp = lap / (c || 1);
    // subject/contrast: centre-weighted absolute deviation from the frame mean
    var sal = 0;
    for (var y2 = 0; y2 < AH; y2++) for (var x2 = 0; x2 < AW; x2++) {
      var w = (x2 > AW * 0.2 && x2 < AW * 0.8 && y2 > AH * 0.2 && y2 < AH * 0.8) ? 1.6 : 1;
      sal += Math.abs(gray[y2 * AW + x2] - meanG) * w;
    }
    var contrast = sal / (N * 255);
    // motion + histogram change vs previous sample
    var diff = 0, hd = 0;
    if (prev) {
      var sad = 0; for (var p2 = 0; p2 < N; p2++) sad += Math.abs(gray[p2] - prev.gray[p2]); diff = sad / (N * 255);
      var h = 0; for (var b = 0; b < 16; b++) h += Math.abs(hist[b] - prev.hist[b]); hd = 0.5 * h / N;
    }
    return { gray: gray, hist: hist, br: br, sharp: sharp, color: color, contrast: contrast, diff: diff, histDiff: hd, rM: rSum / N, gM: gSum / N, bM: bSum / N };
  }

  function scoreInterest(s) {
    var mN = Math.min(s.diff, 0.12) / 0.12;
    var motion = 1 - Math.abs(mN - 0.45) / 0.55;          // sweet-spot: some motion beats frozen
    var sharpN = Math.min(1, s.sharp / 12);
    var expo = 1 - Math.pow(Math.abs(s.br - 0.5) / 0.5, 1.4);
    var it = 0.24 * sharpN + 0.22 * motion + 0.18 * expo + 0.16 * s.color + 0.20 * Math.min(1, s.contrast * 3);
    if (s.br < 0.06 || s.br > 0.97 || sharpN < 0.10) it *= 0.1;  // veto black / blown / mush
    return clamp(it, 0, 1);
  }

  // main entry: analyze(url) → Promise<[{start,end,score,thumbTime,motion,dominantColor,poster}]>
  function analyze(url, opts, onProgress) {
    opts = opts || {};
    var topN = opts.topN || 6;
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'; v.src = url;
      var settled = false;
      function bail(reason) { if (settled) return; settled = true; try { v.pause(); } catch (e) {} resolve({ clips: [], reason: reason || 'none' }); }
      v.onerror = function () { bail('load-error'); };
      setTimeout(function () { bail('timeout'); }, BUDGET_MS + 4000);

      v.onloadedmetadata = function () {
        var dur = v.duration, vw = v.videoWidth, vh = v.videoHeight;
        if (!isFinite(dur) || dur <= 0 || !vw) return bail('bad-duration');
        if (dur < 0.8) return bail('too-short');
        var AH = Math.max(16, Math.round(AW * vh / vw));
        var cv = document.createElement('canvas'); cv.width = AW; cv.height = AH;
        var cx = cv.getContext('2d', { willReadFrequently: true });

        // whole video is already short enough to be one clip
        if (dur <= CLIP_MAX + 0.3) {
          grabPoster(v, dur * 0.4, vw, vh).then(function (poster) {
            settled = true; resolve({ clips: [{ start: 0, end: dur, score: 1, thumbTime: dur * 0.4, motion: 'med', dominantColor: null, poster: poster }], reason: 'whole' });
          });
          return;
        }

        var N = clamp(Math.round(dur * 5), 16, 140);
        var S = [], t0 = (opts.now || 0);
        var startWall = perfNow();
        var i = 0, prev = null;

        function step() {
          if (settled) return;
          if (i >= N || perfNow() - startWall > BUDGET_MS) return finish();
          var t = (i + 0.5) * dur / N;
          seek(v, t, 600).then(function (ok) {
            if (settled) return;
            if (ok) {
              try {
                cx.drawImage(v, 0, 0, AW, AH);
                var f = features(cx, AH, prev); f.t = t; prev = f; S.push(f);
              } catch (e) { if (String(e).indexOf('SecurityError') >= 0 || (e && e.name === 'SecurityError')) return finish(true); }
            }
            i++;
            if (onProgress) try { onProgress(i / N); } catch (e) {}
            step();
          });
        }

        function finish(tainted) {
          if (settled) return;
          if (tainted || S.length < 4) return bail(tainted ? 'tainted' : 'too-few-samples');
          // interest per sample + 3-tap smoothing
          S.forEach(function (s) { s.interest = scoreInterest(s); });
          for (var k = 1; k < S.length - 1; k++) S[k].iSm = 0.25 * S[k - 1].interest + 0.5 * S[k].interest + 0.25 * S[k + 1].interest;
          if (S.length) { S[0].iSm = S[0].interest; S[S.length - 1].iSm = S[S.length - 1].interest; }
          // all-dark / unusable footage → let caller fall back to whole-video / gradient
          var usable = S.filter(function (s) { return s.interest > 0.12; });
          if (usable.length < 3) return bail('low-quality');

          // scene cuts (adaptive vs local median)
          var cuts = [];
          for (var c = 1; c < S.length; c++) {
            var win = S.slice(Math.max(0, c - 6), c + 6).map(function (s) { return s.diff; });
            // mean-colour jump catches hue cuts that luma/motion signals miss
            var colorJump = (Math.abs(S[c].rM - S[c - 1].rM) + Math.abs(S[c].gM - S[c - 1].gM) + Math.abs(S[c].bM - S[c - 1].bM)) / (3 * 255);
            if (colorJump > 0.18 || ((S[c].diff > 0.18 || S[c].histDiff > 0.30) && S[c].diff > 2.2 * (median(win) + 0.02))) cuts.push(S[c].t);
          }
          function shotAt(tt) { var n = 0; for (var m = 0; m < cuts.length; m++) if (tt >= cuts[m]) n++; return n; }
          function idxAt(tt) { var lo = 0, hi = S.length - 1; while (lo < hi) { var mid = (lo + hi) >> 1; if (S[mid].t < tt) lo = mid + 1; else hi = mid; } return lo; }

          // candidate windows (never straddle a cut)
          var cand = [];
          for (var a = 0; a + CLIP_LEN <= dur; a += HOP) {
            var b = a + CLIP_LEN;
            if (shotAt(a) !== shotAt(b)) continue;
            var i0 = idxAt(a), i1 = idxAt(b); if (i1 - i0 < 2) continue;
            var sum = 0, diffs = [], half = (i0 + i1) >> 1, h1 = 0, h2 = 0, c1 = 0, c2 = 0;
            for (var j = i0; j <= i1; j++) { sum += S[j].iSm; diffs.push(S[j].diff); if (j < half) { h1 += S[j].iSm; c1++; } else { h2 += S[j].iSm; c2++; } }
            var mean = sum / (i1 - i0 + 1);
            var arc = clamp(((h2 / (c2 || 1)) - (h1 / (c1 || 1))) / 0.15, 0, 1);
            var dm = diffs.reduce(function (s, x) { return s + x; }, 0) / diffs.length;
            var sd = Math.sqrt(diffs.reduce(function (s, x) { return s + (x - dm) * (x - dm); }, 0) / diffs.length);
            var stab = 1 - Math.min(1, sd / 0.10);
            var pen = (a < 0.4 ? 0.4 : 0) + (b > dur - 0.3 ? 0.4 : 0);
            var start = a; for (var cc = 0; cc < cuts.length; cc++) if (cuts[cc] <= a && a - cuts[cc] < 0.3) { start = cuts[cc] + 0.05; break; }
            cand.push({ start: start, end: Math.min(dur, start + CLIP_LEN), score: mean + 0.10 * stab - 0.15 * pen + 0.06 * arc, shot: shotAt(a), motionE: dm });
          }
          if (!cand.length) cand.push({ start: 0, end: Math.min(dur, CLIP_LEN), score: 0.5, shot: 0, motionE: 0 });
          cand.sort(function (x, y) { return y.score - x.score; });

          // greedy non-max suppression → temporally diverse picks
          var MIN_GAP = Math.max(CLIP_LEN, 2.5), picks = [], usedShots = {};
          for (var p = 0; p < cand.length && picks.length < topN; p++) {
            var ctr = (cand[p].start + cand[p].end) / 2;
            var near = picks.some(function (q) { return Math.abs((q.start + q.end) / 2 - ctr) < MIN_GAP; });
            if (near) continue;
            if (!usedShots[cand[p].shot]) cand[p].score += 0.05;
            usedShots[cand[p].shot] = 1; picks.push(cand[p]);
          }

          // refine endpoints (shave dull lead-in/out) + thumb time
          picks.forEach(function (pk) {
            var a2 = idxAt(pk.start), b2 = idxAt(pk.end), s2 = 0;
            for (var j2 = a2; j2 <= b2; j2++) s2 += S[j2].iSm;
            var mean2 = s2 / (b2 - a2 + 1);
            while (b2 - a2 > 0 && S[a2].iSm < 0.5 * mean2 && S[a2 + 1].t - pk.start < 0.6) a2++;
            while (b2 > a2 && S[b2].iSm < 0.5 * mean2 && pk.end - S[b2 - 1].t < 0.6) b2--;
            pk.start = S[a2].t; pk.end = S[b2].t;
            // best (sharpest/most-interesting) frame inside → poster + focal point
            var bestI = a2, bestV = -1;
            for (var j3 = a2; j3 <= b2; j3++) if (S[j3].interest > bestV) { bestV = S[j3].interest; bestI = j3; }
            pk.thumbTime = S[bestI].t;
            pk.motion = pk.motionE < 0.02 ? 'low' : (pk.motionE < 0.06 ? 'med' : 'high');
            pk.dominantColor = null;
          });
          var out = picks.filter(function (pk) { return pk.end - pk.start >= CLIP_MIN; }).slice(0, topN);
          if (!out.length) return bail('no-window');

          // grab a poster still for each clip (sequential seeks), then resolve
          var idx = 0;
          function nextPoster() {
            if (idx >= out.length) { settled = true; try { v.pause(); } catch (e) {} return resolve({ clips: out, reason: 'ok', cuts: cuts.length }); }
            grabPoster(v, out[idx].thumbTime, vw, vh).then(function (poster) { out[idx].poster = poster; idx++; nextPoster(); });
          }
          nextPoster();
        }

        step();
      };
    });
  }

  // Extract N frames spread evenly across the whole video — quality-filtered
  // (near-black / flat frames rejected) and downscaled. These give the AI real
  // coverage of every scene AND become usable creative images.
  // frames(url, {count}) → Promise<{frames: [dataURL], reason}>
  function frames(url, opts) {
    opts = opts || {};
    var want = Math.max(4, Math.min(32, opts.count || 12));
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'; v.src = url;
      var settled = false;
      function bail(reason) { if (settled) return; settled = true; try { v.pause(); } catch (e) {} resolve({ frames: [], reason: reason || 'none' }); }
      v.onerror = function () { bail('load-error'); };
      setTimeout(function () { bail('timeout'); }, 30000);
      v.onloadedmetadata = function () {
        var dur = v.duration, vw = v.videoWidth, vh = v.videoHeight;
        if (!isFinite(dur) || dur <= 0 || !vw) return bail('bad-duration');
        // never denser than ~2 frames/sec — anything more is near-duplicates
        var n = Math.min(want, Math.max(3, Math.round(dur * 2)));
        var scale = Math.min(1, 800 / Math.max(vw, vh));
        var c = document.createElement('canvas');
        c.width = Math.max(2, Math.round(vw * scale)); c.height = Math.max(2, Math.round(vh * scale));
        var g = c.getContext('2d', { willReadFrequently: true });
        var out = [], i = 0;
        function capture() {
          try {
            g.drawImage(v, 0, 0, c.width, c.height);
            // quality gate: sampled mean brightness + contrast range
            var s = g.getImageData(0, 0, c.width, c.height).data, sum = 0, mn = 255, mx = 0, k = 0;
            for (var p = 0; p < s.length; p += 4 * 41) { var L = (s[p] + s[p + 1] + s[p + 2]) / 3; sum += L; mn = Math.min(mn, L); mx = Math.max(mx, L); k++; }
            var mean = sum / k;
            if (mean > 14 && (mx - mn) > 12) out.push(c.toDataURL('image/jpeg', 0.8));
          } catch (e) { return bail('tainted'); }
        }
        function step() {
          if (settled) return;
          if (i >= n) { settled = true; try { v.pause(); } catch (e) {} return resolve({ frames: out, reason: 'ok' }); }
          var t = dur * (0.03 + 0.94 * (i + 0.5) / n);   // even spread, skip edges
          seek(v, t, 700).then(function (ok) { if (ok) capture(); i++; step(); });
        }
        step();
      };
    });
  }

  // grab a higher-res poster still at time t → jpeg data URL
  function grabPoster(v, t, vw, vh) {
    return seek(v, t, 700).then(function () {
      try {
        var scale = Math.min(1, 640 / Math.max(vw, vh));
        var c = document.createElement('canvas');
        c.width = Math.max(2, Math.round(vw * scale)); c.height = Math.max(2, Math.round(vh * scale));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.82);
      } catch (e) { return null; }
    });
  }

  function perfNow() { try { return performance.now(); } catch (e) { return 0; } }

  Ads.clips = { analyze: analyze, frames: frames };
})();
