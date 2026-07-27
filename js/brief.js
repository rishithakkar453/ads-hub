/* ============================================================================
   ADS HUB — brief ingestion
   Turns everything the user gives us (website URL, free text, PDF/TXT files,
   product images) into one normalised "brief" the generator can work from.
   Also provides the no-AI fallback copywriter that mines the brief for
   headlines, captions and descriptions. Exposes window.Ads.brief.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var util = Ads.util;

  /* ---- File readers ------------------------------------------------------ */
  var TEXT_EXT = /\.(txt|md|markdown|csv|json|html?)$/i;
  var IMG_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;
  var PDF_EXT = /\.pdf$/i;

  function readAsText(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result || '')); };
      r.onerror = rej;
      r.readAsText(file);
    });
  }

  // Downscale images so a 12MP photo doesn't blow up localStorage / export.
  function readImage(file, maxDim) {
    maxDim = maxDim || 1600;
    return util.fileToDataURL(file).then(function (durl) {
      return new Promise(function (res) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth, h = img.naturalHeight;
          if (Math.max(w, h) <= maxDim) return res(durl);
          var scale = maxDim / Math.max(w, h);
          var c = document.createElement('canvas');
          c.width = Math.round(w * scale); c.height = Math.round(h * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', 0.88));
        };
        img.onerror = function () { res(durl); };
        img.src = durl;
      });
    });
  }

  // Ingest a video file → { name, url (object URL), poster (data-URL still) }.
  // The object URL feeds the motion engine as live footage; the poster is a
  // persistable still used for post ads and as a fallback after reload.
  function ingestVideo(file) {
    return new Promise(function (res) {
      var url = URL.createObjectURL(file);
      var v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
      var done = false, lastAny = null;
      function finish(poster) { if (done) return; done = true; try { v.pause(); } catch (e) {} res({ name: file.name, url: url, poster: poster || lastAny || null }); }

      // draw the current frame → { url, ok } (ok = not a near-black / flat frame)
      function capture() {
        try {
          var w = v.videoWidth, h = v.videoHeight; if (!w || !h) return null;
          var scale = Math.min(1, 1000 / Math.max(w, h));
          var c = document.createElement('canvas'); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
          var g = c.getContext('2d'); g.drawImage(v, 0, 0, c.width, c.height);
          var s = g.getImageData(0, 0, c.width, c.height).data, sum = 0, n = 0, mn = 255, mx = 0;
          for (var i = 0; i < s.length; i += 4 * 37) { var L = (s[i] + s[i + 1] + s[i + 2]) / 3; sum += L; mn = Math.min(mn, L); mx = Math.max(mx, L); n++; }
          var mean = sum / n;
          return { url: c.toDataURL('image/jpeg', 0.82), ok: mean > 14 && (mx - mn) > 12 };
        } catch (e) { return null; }
      }

      // try several positions until one yields a non-black frame (fades / dark
      // intros are common, so the old single 25% grab often came back black)
      var idx = 0, targets = [];
      function tryNext() {
        if (done) return;
        if (idx >= targets.length) return finish(null);
        var t = targets[idx++];
        var onSeeked = function () {
          v.removeEventListener('seeked', onSeeked);
          var cap = capture();
          if (cap) { lastAny = lastAny || cap.url; if (cap.ok) return finish(cap.url); }
          tryNext();
        };
        v.addEventListener('seeked', onSeeked);
        try { v.currentTime = t; } catch (e) { v.removeEventListener('seeked', onSeeked); tryNext(); }
      }

      v.onloadedmetadata = function () {
        var dur = (isFinite(v.duration) && v.duration > 0) ? v.duration : 4;
        targets = [dur * 0.3, dur * 0.5, dur * 0.12, dur * 0.7, Math.min(0.6, dur * 0.03)]
          .map(function (x) { return Math.max(0.03, Math.min(x, dur - 0.05)); });
        tryNext();
      };
      v.onerror = function () { finish(null); };
      v.src = url;
      setTimeout(function () { finish(null); }, 12000);
    });
  }

  // Lazy-load pdf.js from CDN only when a PDF is actually dropped.
  var pdfLibPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfLibPromise) return pdfLibPromise;
    pdfLibPromise = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = function () {
        if (!window.pdfjsLib) return rej(new Error('pdf.js failed to initialise'));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        res(window.pdfjsLib);
      };
      s.onerror = function () { rej(new Error('Could not load the PDF reader (offline?). Paste the text instead.')); };
      document.head.appendChild(s);
    });
    return pdfLibPromise;
  }

  function readPDF(file) {
    return loadPdfJs().then(function (pdfjs) {
      return file.arrayBuffer().then(function (buf) {
        return pdfjs.getDocument({ data: buf }).promise;
      }).then(function (doc) {
        var pages = Math.min(doc.numPages, 12);
        var chain = Promise.resolve('');
        var texts = [];
        for (var i = 1; i <= pages; i++) (function (n) {
          chain = chain.then(function () {
            return doc.getPage(n).then(function (p) { return p.getTextContent(); }).then(function (tc) {
              texts.push(tc.items.map(function (it) { return it.str; }).join(' '));
            });
          });
        })(i);
        return chain.then(function () { return texts.join('\n').replace(/\s+/g, ' ').trim(); });
      });
    });
  }

  // Ingest a FileList → { texts:[{name,text}], images:[dataURL], skipped:[name] }
  function ingest(fileList) {
    var files = [].slice.call(fileList || []);
    var out = { texts: [], images: [], skipped: [] };
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        if (IMG_EXT.test(f.name) || /^image\//.test(f.type)) {
          return readImage(f).then(function (durl) { out.images.push(durl); });
        }
        if (PDF_EXT.test(f.name) || f.type === 'application/pdf') {
          return readPDF(f).then(function (text) { out.texts.push({ name: f.name, text: text.slice(0, 12000) }); })
            .catch(function (e) { out.skipped.push(f.name + ' (' + e.message + ')'); });
        }
        if (TEXT_EXT.test(f.name) || /^text\//.test(f.type)) {
          return readAsText(f).then(function (text) { out.texts.push({ name: f.name, text: text.slice(0, 12000) }); });
        }
        out.skipped.push(f.name + ' (unsupported type)');
      });
    });
    return chain.then(function () { return out; });
  }

  /* ---- Brief composition -------------------------------------------------- */
  // brief = { url, site, text, files:[{name,text}], images:[dataURL] }
  function compose(brief) {
    var parts = [];
    if (brief.site && brief.site.brief) parts.push(brief.site.brief);
    else if (brief.url) parts.push('Website: ' + brief.url);
    if (brief.text) parts.push('Additional details from the advertiser:\n' + brief.text.slice(0, 3000));
    (brief.files || []).forEach(function (f) {
      parts.push('Attached document "' + f.name + '":\n' + f.text.slice(0, 2500));
    });
    if ((brief.images || []).length) parts.push('The advertiser supplied ' + brief.images.length + ' product image(s) that will be used as the ad creative imagery.');
    (brief.videos || []).forEach(function (v) {
      if (v.transcript) parts.push('Video transcript ("' + (v.name || 'video') + '", spoken audio):\n' + String(v.transcript).slice(0, 2500));
    });
    if ((brief.videos || []).length) parts.push('The advertiser supplied ' + brief.videos.length + ' product video(s); representative frames are attached for you to look at — use what you actually see in them.');
    return parts.join('\n\n').slice(0, 9000);
  }

  function domain(brief) {
    var u = brief.url || (brief.site && brief.site.finalUrl) || '';
    try { return new URL(/^https?:/i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  /* ---- Fallback copywriter (no API key) ----------------------------------- */
  function sentences(text) {
    return String(text || '').split(/(?<=[.!?])\s+|\n+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length >= 8 && !/^https?:/i.test(s); });
  }
  function splitHeadline(h) {
    h = h.replace(/[.!]$/, '');
    var words = h.split(/\s+/);
    if (words.length < 3) return { start: h, hl: '' };
    var cut = Math.ceil(words.length * 0.55);
    return { start: words.slice(0, cut).join(' '), hl: words.slice(cut).join(' ') };
  }
  var CTAS = ['Learn more', 'Get started', 'See how', 'Try it now', 'Discover more', 'Book a demo', 'Shop now'];
  // navigation / boilerplate lines that read as junk when used as ad headlines
  var JUNK_HEAD = /^(contents?|references?|external links?|see also|navigation|menu|search|sign ?(up|in)|log ?(in|out)|get in touch|contact( us)?|subscribe|newsletter|cookies?( policy)?|privacy( policy)?|terms( of (use|service))?|copyright|all rights reserved|home|about( us)?|faqs?|help|support|categories|archives?|related (articles|posts)|share (this|on)|follow us|read more|learn more|click here|skip to|toggle|language|edit|history|download|donate)\b/i;

  function fallbackCopies(brief, n) {
    var site = brief.site || {};
    var name = site.siteName || '';
    var dom = domain(brief);
    var allText = [brief.text || ''].concat((brief.files || []).map(function (f) { return f.text; })).join('\n');

    // headline candidates: site headings, title, short punchy sentences —
    // minus nav/footer boilerplate that makes embarrassing ad copy
    var heads = (site.headings || []).slice();
    if (site.title) heads.unshift(site.title.replace(/\s*[|\\\-–—·].*$/, ''));
    sentences(allText).forEach(function (s) { if (s.length <= 52) heads.push(s); });
    heads = heads.map(function (h) { return h.trim(); })
      .filter(function (h, i, a) { return h.length >= 8 && h.length <= 60 && !JUNK_HEAD.test(h) && a.indexOf(h) === i; });
    if (!heads.length) heads = [name || dom || 'Your new favourite product'];

    // supporting lines: description + medium sentences
    var subs = [];
    if (site.description) subs.push(site.description);
    sentences(allText).concat(sentences(site.text || '')).forEach(function (s) {
      if (s.length >= 50 && s.length <= 170) subs.push(s);
    });
    subs = subs.filter(function (s, i, a) { return a.indexOf(s) === i; });
    if (!subs.length) subs = [site.description || ('Discover what ' + (name || dom || 'we') + ' can do for you.')];

    var out = [];
    var count = Math.max(1, Math.min(n, Math.max(heads.length * 2, 6)));
    for (var i = 0; i < count; i++) {
      var h = heads[i % heads.length];
      var sub = subs[(i * 3 + Math.floor(i / heads.length)) % subs.length];
      var parts = splitHeadline(h);
      var cta = CTAS[(i * 2) % CTAS.length];
      var hook = subs[(i * 5 + 1) % subs.length];
      var caption = (h + '. ' + (hook === h ? '' : hook)).replace(/\.\./g, '.').trim();
      if (caption.length > 200) caption = caption.slice(0, 198).replace(/\s+\S*$/, '') + '…';
      caption += (dom ? ' → ' + dom : '');
      out.push({
        angle: 'From your content ' + (i + 1),
        source: 'content',                 // literal lines from the material (no AI)
        badge: i % 3 === 0 && name ? name : (i % 3 === 1 && dom ? dom : ''),
        headlineStart: parts.start, headlineHighlight: parts.hl,
        subtext: sub === h ? '' : sub,
        boldPhrases: [],
        cta: cta,
        caption: caption,
        description: (site.description || sub || '').slice(0, 30)
      });
    }
    return out;
  }

  Ads.brief = { ingest: ingest, ingestVideo: ingestVideo, readImage: readImage, readPDF: readPDF, compose: compose, domain: domain, fallbackCopies: fallbackCopies };
})();
