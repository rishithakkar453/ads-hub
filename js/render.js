/* ============================================================================
   ADS HUB — render engine
   • mount()/thumb()  — drop a live, scaled-to-fit ad preview into the DOM
   • exportPNG()       — rasterise an ad to a true 1080px PNG (SVG foreignObject
                         + embedded fonts → canvas → blob). Preview == export.
   • zip()             — minimal store-only ZIP for bulk download (no deps)
   Exposes window.Ads.render.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var T = Ads.templates;
  var util = Ads.util;

  /* ---- Shared ad stylesheet for on-screen previews ----------------------- */
  var injected = false;
  function injectAdStyles() {
    if (injected) return;
    var s = document.createElement('style');
    s.id = 'ads-shared-adcss';
    s.textContent = T.adCSS();
    document.head.appendChild(s);
    injected = true;
  }

  /* ---- Live preview mount ------------------------------------------------ */
  // scalerEl must be position:relative; overflow:hidden. We render the ad at
  // full pixel size and scale it down to targetW (defaults to the scaler width).
  function mount(scalerEl, spec, targetW) {
    injectAdStyles();
    var r = T.renderHTML(spec);
    scalerEl.innerHTML = '<div class="cr-stage">' + r.html + '</div>';
    var stage = scalerEl.firstChild;
    var w = targetW || scalerEl.clientWidth || 600;
    if (w < 40) w = 600;   // degenerate mid-layout width → sane default, never a scale(≈0) mount
    var scale = w / r.width;
    stage.style.transform = 'scale(' + scale + ')';
    scalerEl.style.width = w + 'px';
    scalerEl.style.height = (r.height * scale) + 'px';
    return { scale: scale, width: r.width, height: r.height };
  }

  // Thumbnail: fit the whole ad inside a fixed box (contain), letterbox-cropping
  // tall formats. Used in tables / bulk cells / compare.
  function thumb(scalerEl, spec, boxW, boxH) {
    injectAdStyles();
    if (!boxW || boxW < 40) boxW = 250;   // degenerate mid-layout width → sane default
    var r = T.renderHTML(spec);
    scalerEl.innerHTML = '<div class="cr-stage">' + r.html + '</div>';
    var stage = scalerEl.firstChild;
    var scale = boxW / r.width;
    stage.style.transform = 'scale(' + scale + ')';
    scalerEl.style.width = boxW + 'px';
    scalerEl.style.height = (boxH != null ? boxH : r.height * scale) + 'px';
  }

  /* ---- Font embedding (for export only) ---------------------------------- */
  var fontPromise = null;
  function fetchAsDataURL(url) {
    return fetch(url).then(function (r) { return r.blob(); }).then(function (blob) {
      return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.readAsDataURL(blob); });
    });
  }
  function embeddedFontCSS() {
    if (fontPromise) return fontPromise;
    var base = 'assets/fonts/';
    var faces = [
      { fam: 'Champion Heavyweight', file: 'Champion-Heavyweight_Web.woff2', weight: 700 },
      { fam: 'Champion Lightweight', file: 'Champion-Lightweight_Web.woff2', weight: 400 },
      { fam: 'Neue Haas Grotesk',    file: 'NHaasGroteskTXPro-55Rg.woff2',   weight: 400 }
    ];
    fontPromise = Promise.all(faces.map(function (f) {
      return fetchAsDataURL(base + f.file).then(function (durl) {
        return "@font-face{font-family:'" + f.fam + "';font-weight:" + f.weight + ";font-style:normal;src:url(" + durl + ") format('woff2');}";
      }).catch(function () { return ''; });
    })).then(function (parts) { return parts.join(''); });
    return fontPromise;
  }

  /* ---- PNG export -------------------------------------------------------- */
  function exportPNG(spec, opts) {
    opts = opts || {};
    var r = T.renderHTML(spec);
    return embeddedFontCSS().then(function (fontCSS) {
      var styleTag = '<style><![CDATA[' + fontCSS + T.adCSS() + ']]></style>';
      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + r.width + '" height="' + r.height + '" viewBox="0 0 ' + r.width + ' ' + r.height + '">' +
          '<foreignObject x="0" y="0" width="' + r.width + '" height="' + r.height + '">' +
            '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + r.width + 'px;height:' + r.height + 'px">' +
              styleTag + r.html +
            '</div>' +
          '</foreignObject>' +
        '</svg>';
      var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var scale = opts.scale || 1;
          var canvas = document.createElement('canvas');
          canvas.width = r.width * scale; canvas.height = r.height * scale;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          try {
            canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('toBlob failed')); }, 'image/png');
          } catch (e) { reject(e); }
        };
        img.onerror = function () { reject(new Error('Could not rasterise the ad. If it uses an uploaded image, try re-uploading it.')); };
        img.src = url;
      });
    });
  }

  function download(spec, filename) {
    return exportPNG(spec).then(function (blob) {
      util.downloadBlob(blob, filename || (util.slug(spec.name || spec.headlineStart) + '.png'));
    });
  }

  // Kind-aware: posts → PNG, video ads → mp4/webm.
  function downloadAuto(spec, base) {
    base = base || util.slug(spec.name || spec.headlineStart);
    if (spec.kind === 'video' && Ads.video) {
      return Ads.video.exportVideo(spec).then(function (r) { util.downloadBlob(r.blob, base + '.' + r.ext); return r; });
    }
    return exportPNG(spec).then(function (blob) { util.downloadBlob(blob, base + '.png'); return { ext: 'png' }; });
  }

  /* ---- Minimal store-only ZIP (no compression — PNGs are already small) -- */
  var CRC_TABLE = (function () {
    var t = [], c, n, k;
    for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function strBytes(s) { var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xFF; return a; }

  // files = [{ name, bytes(Uint8Array) }] → Blob (application/zip)
  function zipStore(files) {
    var parts = [], central = [], offset = 0;
    function u16(n) { return new Uint8Array([n & 255, (n >> 8) & 255]); }
    function u32(n) { return new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]); }
    function concat(arrs) { var len = arrs.reduce(function (s, a) { return s + a.length; }, 0); var out = new Uint8Array(len); var p = 0; arrs.forEach(function (a) { out.set(a, p); p += a.length; }); return out; }

    files.forEach(function (f) {
      var name = strBytes(f.name);
      var data = f.bytes;
      var crc = crc32(data);
      var local = concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
      parts.push(local);
      central.push(concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset), name]));
      offset += local.length;
    });
    var cd = concat(central);
    var end = concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(cd.length), u32(offset), u16(0)]);
    return new Blob([concat(parts), cd, end], { type: 'application/zip' });
  }

  // Export many specs → one ZIP of PNGs. onProgress(done,total) optional.
  // extraFiles: [{name, text}] appended to the archive (e.g. captions.csv).
  function zip(specs, names, onProgress, extraFiles) {
    var files = [], i = 0, used = {};
    function uniq(n) { var base = n; var k = 1; while (used[n]) n = base.replace(/\.png$/, '') + '-' + (++k) + '.png'; used[n] = 1; return n; }
    function next() {
      if (i >= specs.length) {
        (extraFiles || []).forEach(function (f) {
          files.push({ name: f.name, bytes: new TextEncoder().encode(f.text) });
        });
        return Promise.resolve(zipStore(files));
      }
      var spec = specs[i];
      var base = util.slug((names && names[i]) || spec.name || spec.headlineStart);
      var isVideo = spec.kind === 'video' && Ads.video;
      var maker = isVideo
        ? Ads.video.exportVideo(spec).then(function (r) { return { blob: r.blob, ext: r.ext }; })
        : exportPNG(spec).then(function (blob) { return { blob: blob, ext: 'png' }; });
      return maker.then(function (r) { return r.blob.arrayBuffer().then(function (buf) { return { buf: buf, ext: r.ext }; }); })
        .then(function (o) {
          files.push({ name: uniq(base + '.' + o.ext), bytes: new Uint8Array(o.buf) });
          i++; if (onProgress) onProgress(i, specs.length); return next();
        })
        .catch(function () { i++; if (onProgress) onProgress(i, specs.length); return next(); }); // skip a failed item
    }
    return next();
  }

  Ads.render = { injectAdStyles: injectAdStyles, mount: mount, thumb: thumb, exportPNG: exportPNG, download: download, downloadAuto: downloadAuto, zip: zip, zipStore: zipStore };
})();
