/* ============================================================================
   ADS HUB — motion video engine
   Short (~4.5s) on-brand motion ads rendered on a <canvas>: kinetic headline +
   ken-burns image + brand colour + animated CTA. Composed entirely from the
   brief's assets (accent, logo, OG/product image, copy). Used for previews
   (poster + live loop) and exported as real .mp4/.webm for Reels & TikTok.
   Exposes window.Ads.video.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var util = Ads.util;
  var FPS = 30, DURATION = 4.5;
  // The ad's loop length. Whole-video footage (e.g. an 8s Veo clip) makes the
  // loop match the FOOTAGE, so the ad never restarts mid-clip — that restart
  // used to hit at 4.5s, dipping to black halfway through an 8-second clip.
  // Clip-window and composed ads keep the designed 4.5s rhythm.
  function loopDur(spec, assets) {
    var v = assets && assets.video;
    if (v && !spec.clip && isFinite(v.duration) && v.duration > 0.5) return clamp(v.duration, 3, 12);
    return DURATION;
  }
  var PROBE = null; // when set to an array, drawFrame records text-block rects (for layout tests)

  /* ---- colour helpers ---------------------------------------------------- */
  function rgb(hex) {
    hex = String(hex || '#ff7a3c').replace('#', '');
    if (hex.length === 3) hex = hex.replace(/(.)/g, '$1$1');
    var n = parseInt(hex, 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgba(hex, a) { var c = rgb(hex); return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }
  function mix(hex, hex2, amt) {
    var a = rgb(hex), b = rgb(hex2);
    return 'rgb(' + Math.round(a.r + (b.r - a.r) * amt) + ',' + Math.round(a.g + (b.g - a.g) * amt) + ',' + Math.round(a.b + (b.b - a.b) * amt) + ')';
  }
  function contrastOn(hex) { var c = rgb(hex); return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) > 150 ? '#0b0c12' : '#ffffff'; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function eo(x) { x = clamp(x, 0, 1); return 1 - Math.pow(1 - x, 3); }
  function seg(t, start, dur) { return eo((t - start) / dur); }

  /* ---- dimensions -------------------------------------------------------- */
  var FMT = { story: { w: 1080, h: 1920 }, square: { w: 1080, h: 1080 }, portrait: { w: 1080, h: 1350 } };
  function dims(spec) { return FMT[spec.videoFormat] || FMT.story; } // video defaults to 9:16
  function motionOf(spec) { return spec.motion && spec.motion !== 'auto' ? spec.motion : ((spec.images && spec.images.product) ? 'showcase' : 'kinetic'); }
  function fonts(spec) {
    return spec.font === 'brand'
      ? { display: "'Champion Heavyweight','Helvetica Neue',sans-serif", w: '400' }
      : { display: "'Helvetica Neue',Arial,sans-serif", w: '800' };
  }

  /* ---- DNA: per-ad variety axes ------------------------------------------ */
  // Normalise the video "DNA" so old saved specs (no .dna) fall back to the
  // classic look, while freshly generated specs get varied treatments.
  function dnaOf(spec) {
    var d = spec.dna || {};
    return {
      typeMotion: d.typeMotion || 'lines',   // headline reveal style
      bgMove: d.bgMove || null,              // camera move (null → legacy)
      grade: d.grade || 'none',              // colour grade over footage/image
      accents: d.accents || [],              // motion-graphic furniture
      accentMode: d.accentMode || 'brand'    // secondary colour derivation
    };
  }
  // hue-rotate a hex colour (via HSL) to derive a harmonised secondary colour
  function rotateHue(hex, deg) {
    var c = rgb(hex), r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, s = 0, l = (mx + mn) / 2, dd = mx - mn;
    if (dd) {
      s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
      h = mx === r ? (g - b) / dd + (g < b ? 6 : 0) : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
      h /= 6;
    }
    h = (h + deg / 360) % 1; if (h < 0) h += 1;
    s = Math.min(1, s * 1.05 + 0.05);
    function hue(p, q, tt) { if (tt < 0) tt += 1; if (tt > 1) tt -= 1; if (tt < 1 / 6) return p + (q - p) * 6 * tt; if (tt < 1 / 2) return q; if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6; return p; }
    var q2 = l < 0.5 ? l * (1 + s) : l + s - l * s, p2 = 2 * l - q2;
    var R = Math.round(hue(p2, q2, h + 1 / 3) * 255), G = Math.round(hue(p2, q2, h) * 255), B = Math.round(hue(p2, q2, h - 1 / 3) * 255);
    function hx(v) { v = Math.max(0, Math.min(255, v)).toString(16); return v.length < 2 ? '0' + v : v; }
    return '#' + hx(R) + hx(G) + hx(B);
  }

  // camera move → {scale, ox, oy} for drawCover, as a function of ad time
  function bgTransform(move, t, dur, W, H) {
    var p = clamp(t / dur, 0, 1), e = eo(p);
    switch (move) {
      case 'pushIn': return { scale: 1.04 + 0.16 * e, ox: 0, oy: 0 };
      case 'pushOut': return { scale: 1.20 - 0.14 * e, ox: 0, oy: 0 };
      case 'panL': return { scale: 1.12, ox: (0.5 - p) * W * 0.10, oy: 0 };
      case 'panR': return { scale: 1.12, ox: (p - 0.5) * W * 0.10, oy: 0 };
      case 'reveal': return { scale: 1.16 - 0.11 * p, ox: (p - 0.5) * W * 0.06, oy: 0 };
      default: return { scale: 1.06, ox: 0, oy: Math.sin(t * 0.5) * H * 0.012 }; // drift
    }
  }

  // living gradient-mesh background for the no-footage / no-image case
  function drawMesh(ctx, accent, secondary, W, H, t) {
    var base = ctx.createLinearGradient(0, 0, W * 0.4, H);
    base.addColorStop(0, mix(accent, '#000000', 0.5)); base.addColorStop(1, '#06070c');
    ctx.fillStyle = base; ctx.fillRect(0, 0, W, H);
    var blobs = [[0.30, 0.30, accent, 0.42], [0.72, 0.55, secondary, 0.34], [0.5, 0.82, mix(accent, secondary, 0.5), 0.26]];
    for (var k = 0; k < blobs.length; k++) {
      var b = blobs[k];
      var gx = W * (b[0] + 0.10 * Math.sin(t * 0.5 + k * 1.7)), gy = H * (b[1] + 0.06 * Math.cos(t * 0.4 + k));
      var rg2 = ctx.createRadialGradient(gx, gy, 0, gx, gy, W * 0.8);
      rg2.addColorStop(0, rgba(b[2], b[3])); rg2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg2; ctx.fillRect(0, 0, W, H);
    }
  }

  // cheap film-grain tile (built once) + composited finish passes
  var _grain = null;
  function grainTile() {
    if (_grain) return _grain;
    var s = 128, c = document.createElement('canvas'); c.width = s; c.height = s;
    var g = c.getContext('2d'), id = g.createImageData(s, s), d = id.data;
    for (var i = 0; i < d.length; i += 4) { var v = (Math.random() * 255) | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    g.putImageData(id, 0, 0); _grain = c; return c;
  }
  function vignette(ctx, W, H, strength) {
    var g = ctx.createRadialGradient(W / 2, H * 0.46, W * 0.2, W / 2, H * 0.5, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,' + strength + ')');
    ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
  }
  // colour-grade a footage/image frame via GPU compositing (no getImageData)
  // Grades are a light FINISH, never a wash — real footage/frames must stay
  // clearly recognisable (heavy duotone/noir used to turn dark footage into
  // what read as a plain colour gradient).
  function applyGrade(ctx, grade, accent, secondary, W, H, t) {
    ctx.save();
    if (grade === 'duotone') {
      ctx.globalCompositeOperation = 'color'; ctx.globalAlpha = 0.18; ctx.fillStyle = accent; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 0.10; ctx.fillStyle = mix(accent, '#000000', 0.35); ctx.fillRect(0, 0, W, H);
    } else if (grade === 'warm') {
      ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = 0.32;
      var gw = ctx.createLinearGradient(0, 0, 0, H); gw.addColorStop(0, '#ff9d5c'); gw.addColorStop(1, '#1f4fd6'); ctx.fillStyle = gw; ctx.fillRect(0, 0, W, H);
    } else if (grade === 'noir') {
      ctx.globalCompositeOperation = 'saturation'; ctx.globalAlpha = 0.40; ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 0.06; ctx.fillStyle = accent; ctx.fillRect(0, 0, W, H);
    } else if (grade === 'vivid') {
      ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.16;
      var gv = ctx.createLinearGradient(0, 0, W, H); gv.addColorStop(0, accent); gv.addColorStop(1, secondary); ctx.fillStyle = gv; ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
    if (grade !== 'none') {                    // animated grain for a graded look
      ctx.save(); ctx.globalAlpha = 0.05; ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = ctx.createPattern(grainTile(), 'repeat');
      ctx.translate((t * 40) % 128, (t * 61) % 128); ctx.fillRect(-128, -128, W + 128, H + 128);
      ctx.restore();
    }
    vignette(ctx, W, H, grade === 'none' ? 0.30 : 0.36);
  }

  /* ---- text layout ------------------------------------------------------- */
  function wrap(ctx, text, maxW) {
    var words = String(text || '').split(/\s+/).filter(Boolean), lines = [], line = '';
    // break a single token that itself exceeds maxW into character chunks so a
    // long word / URL / hashtag can never run off the right edge; returns the
    // trailing (fitting) remainder to continue the running line
    function breakLong(w) {
      var cur = '';
      for (var k = 0; k < w.length; k++) {
        var tc = cur + w[k];
        if (cur && ctx.measureText(tc).width > maxW) { lines.push(cur); cur = w[k]; }
        else cur = tc;
      }
      return cur;
    }
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      if (ctx.measureText(word).width > maxW) {          // token wider than the box
        if (line) { lines.push(line); line = ''; }
        line = breakLong(word);
        continue;
      }
      var test = line ? line + ' ' + word : word;
      if (line && ctx.measureText(test).width > maxW) { lines.push(line); line = word; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  /* ---- one frame --------------------------------------------------------- */
  function drawFrame(ctx, spec, t, W, H, assets, dur, style, poster) {
    dur = dur || DURATION; style = style || motionOf(spec);
    var accent = spec.accent || '#ff7a3c';
    var f = fonts(spec);
    var pad = Math.round(W * 0.075);
    var dna = dnaOf(spec);
    var secondary = rotateHue(accent, dna.accentMode === 'harmonize' ? 176 : 34);
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';
    // opaque base so transparent PNGs / letterboxed footage never show through
    ctx.fillStyle = mix(accent, '#000000', 0.62); ctx.fillRect(0, 0, W, H);

    // ---- background ----
    function legibilityScrims() {
      var sc = ctx.createLinearGradient(0, H * 0.32, 0, H);
      sc.addColorStop(0, 'rgba(6,7,12,0)'); sc.addColorStop(0.55, 'rgba(6,7,12,0.5)'); sc.addColorStop(1, 'rgba(6,7,12,0.93)');
      ctx.fillStyle = sc; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(6,7,12,0.30)'; ctx.fillRect(0, 0, W, H * 0.26);
    }
    // use the live footage frame only for animated/exported frames AND only
    // when the video has actually decoded one (readyState >= HAVE_CURRENT_DATA);
    // poster frames always use the footage still, so a static preview never
    // renders as a blank base fill waiting on an undecoded video
    var liveFootage = !!(!poster && assets.video && assets.video.readyState >= 2 && (assets.video.videoWidth || assets.video.width));
    if (liveFootage) {
      // real uploaded footage — a chosen camera move over the clip. The
      // footage STILL goes down first: drawImage of a video that hasn't
      // presented a frame (mid-seek, stalled, decoder busy) is a silent
      // no-op, so without the underlay a stalled clip renders as the bare
      // base fill — the "gradient video" bug. With it, a blank draw leaves
      // the still visible and a working draw covers it seamlessly.
      var mv = bgTransform(dna.bgMove || 'drift', t, dur, W, H);
      if (assets.product) drawCover(ctx, assets.product, W, H, mv.scale, mv.ox, mv.oy);
      else drawMesh(ctx, accent, secondary, W, H, t);   // no still at all — designed mesh, never the bare base
      drawCover(ctx, assets.video, W, H, mv.scale, mv.ox, mv.oy);
      applyGrade(ctx, dna.grade, accent, secondary, W, H, t);
      legibilityScrims();
    } else if (assets.product) {
      // a real image (site image / upload / video frame) — ALWAYS shown when
      // present. No exceptions: an ad built on a real visual must hold that
      // visual constantly, never fall to the gradient.
      var mv2 = bgTransform(dna.bgMove || (style === 'reveal' ? 'reveal' : 'pushIn'), t, dur, W, H);
      drawCover(ctx, assets.product, W, H, mv2.scale, mv2.ox, mv2.oy);
      applyGrade(ctx, dna.grade, accent, secondary, W, H, t);
      legibilityScrims();
    } else {
      // nothing visual at all → the living gradient-mesh
      drawMesh(ctx, accent, secondary, W, H, t);
      legibilityScrims();
    }

    // ---- logo / brand (top-left) ----
    var topA = seg(t, 0.2, 0.5);
    if (topA > 0.01) {
      ctx.save(); ctx.globalAlpha = topA;
      if (assets.logo) {
        var lh = Math.round(W * 0.058), lw = lh * (assets.logo.naturalWidth / assets.logo.naturalHeight || 1);
        lw = Math.min(lw, W * 0.4);
        ctx.drawImage(assets.logo, pad, pad, lw, lh);
      } else if (spec.brand) {
        ctx.font = '700 ' + Math.round(W * 0.03) + 'px ' + f.display;
        ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
        ctx.fillText(String(spec.brand).toUpperCase(), pad, pad + W * 0.01);
        ctx.textBaseline = 'alphabetic';
      }
      ctx.restore();
    }

    // ---- bottom-anchored content block (measured, stacked bottom-up) ----
    // Every block reserves its TRUE measured ink height, so the headline can
    // never overlap the subtext no matter how many lines each wraps to. Each
    // block's bottom edge is anchored at `y`, then `y` moves up past it + a gap.
    var maxW = W - pad * 2;
    var GAP = Math.round(H * 0.03);
    var y = H - pad;                 // running upper boundary for the next (higher) block

    // true ink ascent/descent of a line in the currently-set font (falls back
    // to font-size ratios where measureText lacks bounding-box metrics)
    function lineExt(text, fs) {
      var m = ctx.measureText(text || 'Mg');
      var asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
      return { asc: asc > 0 ? asc : fs * 0.80, desc: desc > 0 ? desc : fs * 0.24 };
    }

    // CTA pill (bottom-most) — shrink the label font so the pill never runs
    // wider than the content box
    var ctaText = (spec.cta || 'Learn more');
    var ctaA = seg(t, 1.8, 0.45);
    var ctaFs = Math.round(W * 0.036), ctaMinFs = Math.round(W * 0.024);
    ctx.font = '700 ' + ctaFs + 'px ' + f.display;
    while (ctx.measureText(ctaText).width + ctaFs * 1.9 > maxW && ctaFs > ctaMinFs) {
      ctaFs = Math.round(ctaFs * 0.92); ctx.font = '700 ' + ctaFs + 'px ' + f.display;
    }
    var ctaW = Math.min(ctx.measureText(ctaText).width + ctaFs * 1.9, maxW);
    var ctaH = Math.round(ctaFs * 2.15);
    if (ctaA > 0.01) {
      var pulse = t > 1.8 ? (1 + 0.025 * Math.sin((t - 1.8) * 3.2)) : 1;
      ctx.save();
      ctx.globalAlpha = ctaA;
      var cw = Math.min(ctaW * pulse, maxW), ch = ctaH * pulse, cx = pad, cy = y - ch;
      ctx.fillStyle = accent; roundRect(ctx, cx, cy, cw, ch, ch * 0.28); ctx.fill();
      ctx.fillStyle = contrastOn(accent); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(ctaText, cx + (cw - ctx.measureText(ctaText).width) / 2, cy + ch / 2 + ctaFs * 0.02);
      ctx.textBaseline = 'alphabetic';
      ctx.restore();
      if (PROBE) PROBE.push({ block: 'cta', left: cx, right: cx + cw, fs: ctaFs });
    }
    y -= ctaH + GAP;

    // subtext (above CTA) — bottom line anchored just above `y`, stacked upward
    if (spec.subtext) {
      var subFs = Math.round(W * 0.032), subLh = subFs * 1.32;
      ctx.font = '400 ' + subFs + 'px ' + f.display;
      var subLines = wrap(ctx, spec.subtext, maxW).slice(0, 3);
      var nSub = subLines.length;
      var subA = seg(t, 1.3, 0.5);
      var subDescB = lineExt(subLines[nSub - 1], subFs).desc;
      var subAscT = lineExt(subLines[0], subFs).asc;
      var subBottomBase = y - subDescB;                     // bottom line's baseline
      ctx.save(); ctx.globalAlpha = subA; ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.textAlign = 'left';
      var subMaxRight = 0;
      for (var si = nSub - 1; si >= 0; si--) {
        ctx.fillText(subLines[si], pad, subBottomBase - (nSub - 1 - si) * subLh + (1 - subA) * 24);
        subMaxRight = Math.max(subMaxRight, pad + ctx.measureText(subLines[si]).width);
      }
      ctx.restore();
      var subTopBase = subBottomBase - (nSub - 1) * subLh;
      var subTop = subTopBase - subAscT;                    // true top of the subtext block
      if (PROBE) PROBE.push({ block: 'subtext', top: subTop, bottom: y, lines: nSub, right: subMaxRight });
      y = subTop - GAP;
    }

    // headline (start white + highlight accent), line-by-line reveal, bottom-up.
    // Auto-fit: shrink the font until it wraps to <= MAX_HL_LINES so long copy
    // never becomes a wall of oversized text that eats the whole frame.
    var MAX_HL_LINES = 4, hlMinFs = Math.round(W * 0.052);
    var hlFs = Math.round(W * (style === 'reveal' ? 0.098 : 0.088));
    function wrapHl(fs) {
      ctx.font = f.w + ' ' + fs + 'px ' + f.display;
      var s = wrap(ctx, spec.headlineStart || '', maxW);
      var h = spec.headlineHighlight ? wrap(ctx, spec.headlineHighlight, maxW) : [];
      return { s: s, h: h, n: s.length + h.length };
    }
    var wr = wrapHl(hlFs);
    while (wr.n > MAX_HL_LINES && hlFs > hlMinFs) { hlFs = Math.round(hlFs * 0.92); wr = wrapHl(hlFs); }
    // line step loose enough that a descender line above a tall-caps line can't
    // collide (interior overlap); baseline-to-baseline
    var hlLh = hlFs * 1.16;
    ctx.font = f.w + ' ' + hlFs + 'px ' + f.display;
    var allLines = wr.s.map(function (l) { return { text: l, hl: false }; })
      .concat(wr.h.map(function (l) { return { text: l, hl: true }; }));
    // hard cap: if it still wraps past MAX_HL_LINES at min font, truncate with …
    if (allLines.length > MAX_HL_LINES) {
      allLines = allLines.slice(0, MAX_HL_LINES);
      var lastL = allLines[MAX_HL_LINES - 1];
      var txt = lastL.text.replace(/[\s,.;:!?\-–—]+$/, '');
      // trim (by word, then by char) until the ellipsised line fits the box
      while (txt && ctx.measureText(txt + '…').width > maxW) {
        var sp2 = txt.lastIndexOf(' ');
        txt = sp2 > 0 ? txt.slice(0, sp2) : txt.slice(0, Math.max(1, txt.length - 2));
      }
      lastL.text = txt + '…';
    }
    var hlBottomForUnderline = null, hlWidthForUnderline = 0;
    var nHl = allLines.length;
    if (nHl) {
      var hlDescB = lineExt(allLines[nHl - 1].text, hlFs).desc;
      var hlAscT = lineExt(allLines[0].text, hlFs).asc;
      var hlBottomBase = y - hlDescB;                       // bottom headline line's baseline
      var hlLineBoxes = [];
      for (var li = nHl - 1; li >= 0; li--) {
        var item = allLines[li];
        var lineStart = 0.5 + (nHl - 1 - li) * 0.16;        // top lines reveal first
        var a = seg(t, lineStart, 0.5);
        var lineY = hlBottomBase - (nHl - 1 - li) * hlLh;
        var baseColor = item.hl ? accent : '#ffffff';
        ctx.textAlign = 'left';
        // ---- headline reveal treatment (DNA typeMotion) — final resting
        // positions are identical across treatments, so overlap-safety holds ----
        if (dna.typeMotion === 'words') {                   // staggered word pop-in
          var words = item.text.split(' '), wx = pad;
          for (var wi = 0; wi < words.length; wi++) {
            var wa = seg(t, lineStart + wi * 0.05, 0.34);
            ctx.save(); ctx.globalAlpha = clamp(wa, 0, 1); ctx.fillStyle = baseColor;
            ctx.translate(wx, lineY + (1 - wa) * Math.min(hlFs * 0.4, GAP * 0.7));
            ctx.fillText(words[wi], 0, 0); ctx.restore();
            wx += ctx.measureText(words[wi] + (wi < words.length - 1 ? ' ' : '')).width;
          }
        } else if (dna.typeMotion === 'punch') {            // scale-overshoot pop
          ctx.save(); ctx.globalAlpha = clamp(a, 0, 1); ctx.fillStyle = baseColor;
          var scp = 1 + 0.12 * (1 - eo(a));
          ctx.translate(pad, lineY); ctx.scale(scp, scp); ctx.fillText(item.text, 0, 0); ctx.restore();
        } else if (dna.typeMotion === 'sweep' && item.hl) { // accent colour wipe on highlights
          ctx.save(); ctx.globalAlpha = clamp(a, 0, 1);
          ctx.fillStyle = '#ffffff'; ctx.fillText(item.text, pad, lineY);
          var sweepP = eo(clamp((t - lineStart) / 0.6, 0, 1)), lw = ctx.measureText(item.text).width;
          ctx.beginPath(); ctx.rect(pad, lineY - hlFs, lw * sweepP, hlFs * 1.5); ctx.clip();
          ctx.fillStyle = accent; ctx.fillText(item.text, pad, lineY);
          ctx.restore();
        } else {                                            // 'lines' — fade + rise (classic)
          var sc2 = style === 'reveal' ? (0.92 + 0.08 * a) : 1;
          var dy = (1 - a) * Math.min(hlFs * 0.5, GAP * 0.8);
          ctx.save(); ctx.globalAlpha = clamp(a, 0, 1); ctx.fillStyle = baseColor;
          ctx.translate(pad, lineY + dy); ctx.scale(sc2, sc2); ctx.fillText(item.text, 0, 0); ctx.restore();
        }
        if (PROBE) { var e = lineExt(item.text, hlFs); hlLineBoxes.push({ top: lineY - e.asc, bottom: lineY + e.desc, right: pad + ctx.measureText(item.text).width }); }
      }
      hlBottomForUnderline = hlBottomBase + hlDescB;
      hlWidthForUnderline = ctx.measureText(allLines[nHl - 1].text).width;
      var hlTopBase = hlBottomBase - (nHl - 1) * hlLh;
      var hlTop = hlTopBase - hlAscT;
      if (PROBE) { PROBE.push({ block: 'headline', top: hlTop, bottom: hlBottomBase + hlDescB, lines: nHl }); PROBE.push({ block: 'headlineLines', boxes: hlLineBoxes }); }
      y = hlTop - GAP;
    }

    // badge (above headline)
    if (spec.badge) {
      var bFs = Math.round(W * 0.027);
      ctx.font = '600 ' + bFs + 'px ' + f.display;
      var badgeText = String(spec.badge).toUpperCase();
      var bw = ctx.measureText(badgeText).width + bFs * 2.2, bh = bFs * 2.2;
      var bA = seg(t, 0.4, 0.5);
      ctx.save(); ctx.globalAlpha = bA;
      ctx.fillStyle = rgba(accent, 0.22); roundRect(ctx, pad, y - bh, bw, bh, bh / 2); ctx.fill();
      ctx.strokeStyle = rgba(accent, 0.9); ctx.lineWidth = 2; roundRect(ctx, pad, y - bh, bw, bh, bh / 2); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText(badgeText, pad + bFs * 1.1, y - bh / 2 + bFs * 0.05);
      ctx.textBaseline = 'alphabetic';
      ctx.restore();
      if (PROBE) PROBE.push({ block: 'badge', top: y - bh, bottom: y });
    }
    if (PROBE) PROBE.push({ block: 'contentTop', top: y });

    // ---- motion-graphic accents (DNA furniture in the secondary colour) ----
    var accs = dna.accents || [];
    for (var ai = 0; ai < accs.length; ai++) {
      if (accs[ai] === 'progress') {                        // watch-time bar along the base
        var barH = Math.max(3, Math.round(H * 0.006));
        ctx.save(); ctx.globalAlpha = 0.92; ctx.fillStyle = secondary;
        ctx.fillRect(0, H - barH, W * clamp(t / dur, 0, 1), barH); ctx.restore();
      } else if (accs[ai] === 'underline' && hlBottomForUnderline != null) { // keyline under headline
        var uw = hlWidthForUnderline * eo(clamp((t - 1.0) / 0.5, 0, 1));
        var uh = Math.max(4, Math.round(hlFs * 0.07));
        ctx.save(); ctx.globalAlpha = 0.95; ctx.fillStyle = secondary;
        ctx.fillRect(pad, hlBottomForUnderline + Math.round(hlFs * 0.06), uw, uh); ctx.restore();
      } else if (accs[ai] === 'ticks') {                    // corner bracket that draws on
        var tl = W * 0.05 * eo(clamp((t - 0.5) / 0.5, 0, 1));
        ctx.save(); ctx.strokeStyle = secondary; ctx.lineWidth = Math.max(3, Math.round(W * 0.006)); ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.moveTo(pad, y - tl); ctx.lineTo(pad, y); ctx.lineTo(pad + tl, y); ctx.stroke(); ctx.restore();
      }
    }

    // ---- intro/outro fade for a soft loop (composed ads only) ----
    // Live-footage ads NEVER dip to black: the text must stay up for the whole
    // clip, and with the loop matched to the footage the restart is the clip's
    // own natural cut, not a blackout in the middle of it.
    if (!liveFootage) {
      var fade = 0;
      if (t < 0.3) fade = 1 - t / 0.3;
      else if (t > dur - 0.3) fade = (t - (dur - 0.3)) / 0.3;
      if (fade > 0) { ctx.fillStyle = 'rgba(6,7,12,' + clamp(fade, 0, 1) + ')'; ctx.fillRect(0, 0, W, H); }
    }
  }

  function drawCover(ctx, img, W, H, scale, ox, oy) {
    // videoWidth first: <video> elements have no naturalWidth and their .width
    // attribute is 0 — without it every live-footage draw was a silent no-op
    var iw = img.videoWidth || img.naturalWidth || img.width,
        ih = img.videoHeight || img.naturalHeight || img.height;
    if (!iw || !ih) return;
    var r = Math.max(W / iw, H / ih) * scale, dw = iw * r, dh = ih * r;
    ctx.drawImage(img, (W - dw) / 2 + ox, (H - dh) / 2 + oy, dw, dh);
  }

  /* ---- asset preload ----------------------------------------------------- */
  var imgCache = {};
  function loadImg(src) {
    if (!src) return Promise.resolve(null);
    if (imgCache[src]) return imgCache[src];
    imgCache[src] = new Promise(function (res) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { res(null); };
      im.src = src;
    });
    return imgCache[src];
  }
  // A background <video> element (uploaded footage), muted + playing. When a
  // `clip` {start,end} is given, the element loops just that sub-segment so a
  // single upload yields many distinct short clips across the batch.
  function loadVideo(src, clip) {
    if (!src) return Promise.resolve(null);
    return new Promise(function (res) {
      var v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
      var cs = clip ? Math.max(0, clip.start || 0) : 0;
      var ce = clip ? (clip.end || 0) : 0;
      // a degenerate clip (end missing / not past start) would make `enforce`
      // fire on EVERY timeupdate — the element re-seeks forever, never plays
      // forward and never presents a frame. Treat it as no clip at all.
      var useClip = !!clip && ce > cs + 0.2;
      if (!useClip) { cs = 0; v.loop = true; }        // whole-video path loops natively
      var settled = false;
      function enforce() { if (v.currentTime >= ce - 0.03 || v.currentTime < cs - 0.06) { try { v.currentTime = cs; } catch (e) {} } }
      function ok() {
        if (settled) return; settled = true;
        v._wantPlay = true;   // draw loops re-kick play() while this is set
        if (useClip && isFinite(v.duration) && v.duration > 0) {
          // stale analysis of a replaced upload: clamp the window to the file
          // that actually exists now. A start at/past the end (or a window
          // that collapses once clamped) can never play — loop the whole video
          ce = Math.min(ce, v.duration - 0.05);
          if (cs >= v.duration - 0.25 || ce <= cs + 0.2) {
            v.removeEventListener('timeupdate', enforce);
            useClip = false; v.loop = true; cs = 0;
            try { v.currentTime = 0; } catch (e) {}
          }
        }
        if (useClip) { try { v.currentTime = cs; } catch (e) {} }
        try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
        res(v);
      }
      if (useClip) v.addEventListener('timeupdate', enforce);
      // 'ended' kills timeupdate, so enforce alone can't re-loop a clip whose
      // window brushes the end of the file — restart it explicitly
      v.addEventListener('ended', function () {
        if (!useClip) return;
        try { v.currentTime = cs; var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () {}); } catch (e) {}
      });
      v.oncanplay = ok; v.onloadeddata = ok;
      v.onerror = function () { if (!settled) { settled = true; res(null); } };
      v.src = src;
      setTimeout(ok, 4000); // don't hang if events are slow
    });
  }
  // opts.still: skip the footage element entirely — poster frames never draw
  // the live video, and every loadVideo spins up a playing decoder that would
  // otherwise burn in the background (grid = one per cell)
  function loadAssets(spec, opts) {
    var still = !!(opts && opts.still);
    return Promise.all([
      loadImg(spec.images && spec.images.product),
      loadImg(spec.logo),
      still ? Promise.resolve(null) : loadVideo(spec.bgVideo, spec.clip)
    ]).then(function (r) { return { product: r[0], logo: r[1], video: r[2] }; });
  }
  // fully release a footage element so its decoder stops (a detached playing
  // <video> keeps decoding for the life of the session otherwise)
  function releaseVideo(v) {
    if (!v) return;
    v._wantPlay = false;
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
  }
  // Chrome pauses muted "video-only" media to save power (background/occluded
  // tabs), and play() can be interrupted mid-flight — either way the footage
  // freezes on one frame while the ad keeps animating. Every draw tick calls
  // this: if the clip SHOULD be running but got paused, kick it awake again.
  function kickPlay(v) {
    if (!v || !v._wantPlay || !v.paused) return;
    try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }

  /* ---- preview: poster + live loop --------------------------------------- */
  // Mount into slotEl (position:relative). animate=false → static poster frame.
  function mount(slotEl, spec, animate) {
    var d = dims(spec);
    var boxW = slotEl.clientWidth || 260;
    var boxH = Math.round(boxW * d.h / d.w);
    slotEl.innerHTML = '';
    var canvas = document.createElement('canvas');
    canvas.width = d.w; canvas.height = d.h;
    canvas.style.width = boxW + 'px'; canvas.style.height = boxH + 'px';
    canvas.style.display = 'block';
    slotEl.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var ctrl = { raf: 0, stopped: false, assets: null };
    // static poster cells never draw the live video — don't even load it
    loadAssets(spec, { still: !animate }).then(function (assets) {
      if (ctrl.stopped) return;
      ctrl.assets = assets;
      if (!animate) {
        // static poster draws an IMAGE (pre-extracted footage still / site image)
        // or the branded mesh gradient — never the live video, which draws blank
        // here and would wipe the fallback. Live motion is hover / export only.
        drawFrame(ctx, spec, DURATION * 0.62, d.w, d.h, assets, DURATION, null, true);
        if (assets.video) { assets.video._wantPlay = false; try { assets.video.pause(); } catch (e) {} }
        return;
      }
      // immediate non-blank frame (footage still / site image) before the live
      // loop starts and before the video has decoded a frame
      var D = loopDur(spec, assets);
      ctrl.D = D;
      drawFrame(ctx, spec, D * 0.5, d.w, d.h, assets, D, null, true);
      var start = null, lastT = 0;
      function step(ts) {
        if (ctrl.stopped) return;
        // the slot was re-rendered / the modal closed without stop() — kill the
        // loop and its decoder instead of animating a detached canvas forever
        if (!canvas.isConnected) return ctrl.stop();
        if (start == null) start = ts;
        var t = ((ts - start) / 1000) % D;
        // phase-lock whole-video footage: when the ad loop wraps, send the clip
        // back to its first frame so text and footage restart TOGETHER
        if (t < lastT && assets.video && !spec.clip) { try { assets.video.currentTime = 0; } catch (e) {} }
        lastT = t;
        kickPlay(assets.video);   // self-heal: power-saving / interrupted play()
        drawFrame(ctx, spec, t, d.w, d.h, assets, D);
        ctrl.raf = requestAnimationFrame(step);
      }
      ctrl.raf = requestAnimationFrame(step);
    });
    function pauseVid() { if (ctrl.assets && ctrl.assets.video) { ctrl.assets.video._wantPlay = false; try { ctrl.assets.video.pause(); } catch (e) {} } }
    ctrl.stop = function () { ctrl.stopped = true; if (ctrl.raf) cancelAnimationFrame(ctrl.raf); pauseVid(); };
    ctrl.poster = function () {
      ctrl.stopped = true; if (ctrl.raf) cancelAnimationFrame(ctrl.raf); pauseVid();
      var pd = ctrl.D || DURATION;
      if (ctrl.assets) drawFrame(ctx, spec, pd * 0.62, d.w, d.h, ctrl.assets, pd, null, true);
    };
    return ctrl;
  }

  /* ---- export ------------------------------------------------------------ */
  function supported() {
    return typeof MediaRecorder !== 'undefined' &&
      !!document.createElement('canvas').captureStream;
  }
  function pickMime() {
    var cands = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (var i = 0; i < cands.length; i++) { try { if (MediaRecorder.isTypeSupported(cands[i])) return cands[i]; } catch (e) {} }
    return '';
  }

  // → { blob, ext, mime }
  function exportVideo(spec) {
    if (!supported()) return Promise.reject(new Error('This browser can’t record video. Try Chrome, or use “Download frame” for a still.'));
    var mime = pickMime();
    if (!mime) return Promise.reject(new Error('No supported video format in this browser.'));
    var d = dims(spec);
    return loadAssets(spec).then(function (assets) {
      return new Promise(function (resolve, reject) {
        var canvas = document.createElement('canvas');
        canvas.width = d.w; canvas.height = d.h;
        var ctx = canvas.getContext('2d');
        var D = loopDur(spec, assets);   // an 8s Veo ad exports as a full 8s video
        try { if (assets.video && !spec.clip) assets.video.currentTime = 0; } catch (e) {}
        drawFrame(ctx, spec, 0, d.w, d.h, assets, D); // prime first frame
        var manualStream = null, track = null, manual = false;
        try { manualStream = canvas.captureStream(0); track = manualStream.getVideoTracks()[0]; manual = track && typeof track.requestFrame === 'function'; } catch (e) {}
        var stream = manual ? manualStream : canvas.captureStream(FPS);
        var rec;
        try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 }); }
        catch (e) { releaseVideo(assets.video); return reject(new Error('Could not start the recorder: ' + e.message)); }
        var chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onerror = function (e) { releaseVideo(assets.video); reject((e && e.error) || new Error('Recording failed')); };
        rec.onstop = function () {
          releaseVideo(assets.video);   // stop the background decoder — it would run for the whole session
          var ext = mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
          resolve({ blob: new Blob(chunks, { type: mime.split(';')[0] }), ext: ext, mime: mime });
        };
        rec.start();
        var frames = Math.round(D * FPS), i = 0;
        var timer = setInterval(function () {
          kickPlay(assets.video);   // an export must never record a frozen clip
          drawFrame(ctx, spec, i / FPS, d.w, d.h, assets, D);
          if (manual && track) { try { track.requestFrame(); } catch (e) {} }
          i++;
          if (i > frames) { clearInterval(timer); setTimeout(function () { try { rec.stop(); } catch (e) { releaseVideo(assets.video); reject(e); } }, 140); }
        }, 1000 / FPS);
      });
    });
  }

  // Full-res single-frame PNG (poster / ZIP fallback / thumbnail)
  function posterBlob(spec) {
    var d = dims(spec);
    return loadAssets(spec, { still: true }).then(function (assets) {
      var canvas = document.createElement('canvas');
      canvas.width = d.w; canvas.height = d.h;
      drawFrame(canvas.getContext('2d'), spec, DURATION * 0.62, d.w, d.h, assets, DURATION, null, true);
      return new Promise(function (res, rej) { canvas.toBlob(function (b) { b ? res(b) : rej(new Error('poster failed')); }, 'image/png'); });
    });
  }

  Ads.video = {
    FPS: FPS, DURATION: DURATION, dims: dims, motionOf: motionOf,
    mount: mount, exportVideo: exportVideo, posterBlob: posterBlob, supported: supported,
    // testing hooks: single-frame draw + the per-footage loop length
    _drawFrame: drawFrame, _loopDur: loopDur,
    // testing hook: layout(spec[,t]) returns the measured text-block rects for one frame
    layout: function (spec, t) {
      var d = dims(spec);
      var c = document.createElement('canvas'); c.width = d.w; c.height = d.h;
      var arr = []; PROBE = arr;
      try { drawFrame(c.getContext('2d'), spec, t == null ? DURATION * 0.62 : t, d.w, d.h, { product: null, logo: null, video: null }, DURATION); }
      finally { PROBE = null; }
      return { dims: d, blocks: arr };
    }
  };
})();
