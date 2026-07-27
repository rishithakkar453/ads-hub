/* ============================================================================
   ADS HUB — message-matched landing pages
   ONE landing page per ad (each ad is tracked separately through its page).
   Every page opens with the same headline + creative as its ad, then continues
   in the brand's OWN first-person voice — AI-written from an understanding of
   the project, wearing the source site's real fonts + colour scheme so it feels
   like part of that site. Deliverables per ad: a self-contained index.html, a
   React component (Landing.jsx) and the ad visual (ad.png) — hosted live under
   /pfiles + /p and zipped for download. Exposes window.Ads.landing.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var util = Ads.util;
  var esc = util.escapeHtml;

  /* ---- distinct hooks (for batching the AI copy) ------------------------- */
  // Ads that share a headline share one landing "story", so the AI writes copy
  // once per distinct hook; every ad still gets its OWN page (see buildItems).
  function distinctHooks(results, removed) {
    var groups = [], byKey = {};
    (results || []).forEach(function (s, i) {
      if (removed && removed[i]) return;
      var headline = ((s.headlineStart || '') + ' ' + (s.headlineHighlight || '')).trim();
      if (!headline) return;
      var key = headline.toLowerCase().replace(/\s+/g, ' ');
      if (!byKey[key]) { byKey[key] = { headline: headline, hook: s.caption || s.subtext || '', specs: [] }; groups.push(byKey[key]); }
      byKey[key].specs.push(s);
    });
    return groups;
  }

  /* ---- site design: fonts (from scrape) + scheme (from the hero image) ---- */
  function loadImage(src) {
    return new Promise(function (res) {
      if (!src) return res(null);
      var im = new Image();
      im.onload = function () { res(im); }; im.onerror = function () { res(null); };
      im.src = src;
    });
  }
  // Sample a representative site image to decide dark vs light. Site images are
  // data-URIs / same-origin files, so the canvas is never tainted.
  function schemeFromImage(src) {
    return loadImage(src).then(function (im) {
      if (!im) return null;
      try {
        var n = 24, c = document.createElement('canvas'); c.width = n; c.height = n;
        var g = c.getContext('2d'); g.drawImage(im, 0, 0, n, n);
        var d = g.getImageData(0, 0, n, n).data, lum = 0, cnt = 0;
        for (var i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) continue;
          lum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; cnt++;
        }
        if (!cnt) return null;
        return { dark: (lum / cnt) < 118 };
      } catch (e) { return null; }
    });
  }
  // Merge server-extracted fonts + real scheme with an image fallback.
  // The server reads the site's ACTUAL painted background (from the <body>
  // classes / CSS vars), which is definitive; the hero image is only a
  // fallback when the CSS gave nothing (frameworks default bg to #fff even on
  // a black page, so the image alone mis-reads dark sites as light).
  // opts: { site, images } → Promise<{ fonts, fontLinks, bodyFont, headingFont, dark, bg, text }>
  function resolveDesign(opts) {
    var sd = (opts.site && opts.site.design) || null;
    var base = {
      fonts: (sd && sd.fonts) || [], fontLinks: (sd && sd.fontLinks) || [],
      bodyFont: (sd && sd.bodyFont) || null, headingFont: (sd && sd.headingFont) || null,
      dark: false, bg: (sd && sd.bg) || null, text: (sd && sd.text) || null
    };
    if (sd && sd.dark != null) { base.dark = !!sd.dark; return Promise.resolve(base); }
    var src = (opts.images || []).filter(function (u) { return /^data:/i.test(u); })[0] ||
      (opts.site && (opts.site.ogImage || (opts.site.images || [])[0])) || null;
    if (!src) return Promise.resolve(base);
    return schemeFromImage(src).then(function (sc) { if (sc) base.dark = sc.dark; return base; });
  }

  /* ---- palette + typography helpers -------------------------------------- */
  var SYS = '-apple-system,"Segoe UI",Helvetica,Arial,sans-serif';
  function fontStack(f) { f = String(f || '').trim(); if (!f) return SYS; return /,|serif|sans-serif|monospace|system-ui/i.test(f) ? f : (f + ',' + SYS); }
  function hexL(hex) {
    hex = String(hex || '').replace('#', ''); if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return isNaN(r) ? 128 : 0.299 * r + 0.587 * g + 0.114 * b;
  }
  function onColor(hex) { return hexL(hex) > 150 ? '#111114' : '#ffffff'; }
  function rgbOf(v) {
    v = String(v || '').trim().toLowerCase();
    if (v === 'black') v = '#000'; else if (v === 'white') v = '#fff';
    var hm = /^#([0-9a-f]{3,8})$/i.exec(v);
    if (hm) { var h = hm[1]; if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
    var rm = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(v);
    return rm ? [+rm[1], +rm[2], +rm[3]] : null;
  }
  function rgba(rgb, a) { return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')'; }
  // Build the page palette. When the site gave us its real bg/text, wear those
  // exact colours and derive muted/line/panel tints from the text colour so the
  // page reads as part of that site; otherwise use a clean dark or light default.
  function palette(design, A) {
    var dark = !!design.dark;
    var bg = design.bg || (dark ? '#0a0a0c' : '#ffffff');
    var text = design.text || (dark ? '#f3f2ef' : '#121317');
    var txRGB = rgbOf(text) || (dark ? [243, 242, 239] : [18, 19, 23]);
    return {
      A: A, onA: onColor(A), bg: bg, text: text,
      bg2: rgba(txRGB, dark ? 0.06 : 0.04),
      muted: rgba(txRGB, 0.66),
      line: rgba(txRGB, dark ? 0.15 : 0.12),
      shadow: dark ? 'rgba(0,0,0,.55)' : 'rgba(15,16,21,.10)',
      ctaEnd: dark ? '#0a0a0c' : '#17181f'
    };
  }

  /* ---- page model (one per ad) ------------------------------------------- */
  function fallbackSections(d, site) {
    // no-AI degraded path only (the app runs with AI on). Keep it first-person-ish.
    var out = [];
    if (d && d.product) out.push({ kicker: 'What we do', title: 'Made for the moments that matter', body: d.product });
    else if (site && site.description) out.push({ kicker: 'What we do', title: 'Here’s what we’re about', body: site.description });
    return out;
  }
  // item: { spec, adKey, headline, hook, slug, content }
  function pageModel(item, opts) {
    var s = item.spec, content = item.content || {}, d = (opts.dossier && opts.dossier.sections) || {}, site = opts.site || {};
    var url = (opts.url || '').trim(); if (url && !/^https?:/i.test(url)) url = 'https://' + url;
    var secs = (Array.isArray(content.sections) && content.sections.length) ? content.sections : fallbackSections(d, site);
    return {
      slug: item.slug,
      headline: item.headline,
      subhead: content.subhead || item.hook || site.description || '',
      intro: content.intro || '',
      sections: secs,
      cta: content.cta || s.cta || 'Visit us',
      accent: /^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent : '#ff7a3c',
      brand: s.brand || opts.brandName || (site.siteName || '') || 'Us',
      url: url || '#',
      badge: s.badge || ''
    };
  }

  function pageCSS(m, design) {
    design = design || {};
    var A = m.accent, P = palette(design, A);
    var body = fontStack(design.bodyFont), head = fontStack(design.headingFont || design.bodyFont);
    var imports = (design.fontLinks || []).map(function (u) { return '@import url(' + JSON.stringify(u) + ');'; }).join('');
    var faces = (design.fonts || []).map(function (f) {
      return '@font-face{font-family:' + JSON.stringify(f.family) + ';src:url(' + JSON.stringify(f.url) + ') format("woff2");font-weight:' + (f.weight || '400') + ';font-style:' + (f.style || 'normal') + ';font-display:swap}';
    }).join('');
    return imports + faces +
      '*{box-sizing:border-box;margin:0}' +
      'body{font-family:' + body + ';color:' + P.text + ';background:' + P.bg + ';line-height:1.6;-webkit-font-smoothing:antialiased}' +
      'h1,h2,h3{font-family:' + head + ';font-weight:500;letter-spacing:-.02em;line-height:1.08}' +
      'img{max-width:100%}' +
      '.wrap{max-width:1120px;margin:0 auto;padding:0 28px}' +
      'header{padding:22px 0;position:relative;z-index:2}' +
      '.nav{display:flex;align-items:center;justify-content:space-between}' +
      '.brand{font-family:' + head + ';font-weight:500;letter-spacing:.01em;font-size:20px}' +
      '.navcta{border:1px solid ' + P.line + ';color:' + P.text + ';text-decoration:none;font-size:14px;padding:9px 20px;border-radius:99px;transition:all .2s}' +
      '.navcta:hover{background:' + A + ';border-color:' + A + ';color:' + P.onA + '}' +
      // hero
      '.hero-band{position:relative;overflow:hidden;background:radial-gradient(120% 90% at 82% -12%,' + A + '26 0%,' + A + '00 55%),linear-gradient(180deg,' + P.bg2 + ' 0%,' + P.bg + ' 100%)}' +
      '.hero{position:relative;z-index:1;display:grid;grid-template-columns:1.05fr .95fr;gap:56px;align-items:center;padding:52px 0 82px}' +
      '.badge{display:inline-block;color:' + A + ';border:1px solid ' + A + '55;padding:6px 15px;border-radius:99px;font-size:12px;letter-spacing:.07em;text-transform:uppercase;margin-bottom:22px}' +
      'h1{font-size:60px;margin-bottom:20px}' +
      '.hook{font-size:20px;color:' + P.muted + ';margin-bottom:20px;max-width:52ch;line-height:1.5}' +
      '.lead-intro{font-size:16.5px;color:' + P.muted + ';margin-bottom:30px;max-width:52ch;line-height:1.65}' +
      '.cta-row{display:flex;align-items:center;gap:22px;flex-wrap:wrap}' +
      '.cta{display:inline-block;background:' + A + ';color:' + P.onA + ';padding:16px 34px;border-radius:12px;font-weight:600;text-decoration:none;font-size:16px;transition:filter .2s}' +
      '.cta:hover{filter:brightness(1.08)}' +
      '.ghostlink{color:' + P.text + ';font-weight:500;text-decoration:none;border-bottom:1px solid ' + A + '66;padding-bottom:2px;font-size:15px}' +
      // staged creative
      '.stage{position:relative;padding:14px}' +
      '.stage:after{content:"";position:absolute;inset:22px 4px -14px 26px;background:radial-gradient(ellipse at center,' + A + '3d 0%,' + A + '00 70%);z-index:0;filter:blur(12px)}' +
      '.stage img{position:relative;z-index:1;display:block;width:100%;border-radius:18px;box-shadow:0 40px 90px ' + P.shadow + ',0 8px 24px ' + A + '22}' +
      // content sections
      'section{padding:66px 0;border-top:1px solid ' + P.line + '}' +
      '.band-tint{background:' + P.bg2 + '}' +
      '.kicker{font-size:12px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:' + A + ';margin-bottom:12px}' +
      'h2{font-size:34px;margin-bottom:16px;max-width:20ch}' +
      '.lead{color:' + P.muted + ';font-size:17.5px;line-height:1.7;max-width:68ch}' +
      // gallery
      '.gal{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}' +
      '.gal img{width:100%;border-radius:14px;box-shadow:0 18px 40px ' + P.shadow + '}' +
      // closing cta
      '.closing{border-top:none}' +
      '.cta-band{position:relative;overflow:hidden;background:linear-gradient(135deg,' + A + ' 0%,' + P.ctaEnd + ' 145%);border-radius:24px;padding:64px 44px;text-align:center}' +
      '.cta-band h2{color:' + P.onA + ';font-size:38px;margin:0 auto 14px;max-width:24ch}' +
      '.cta-band p{color:' + P.onA + 'cc;margin:0 auto 30px;font-size:17px;max-width:56ch}' +
      '.cta-band .cta{background:' + P.onA + ';color:' + A + '}' +
      // footer
      'footer{padding:34px 0;color:' + P.muted + ';font-size:14px;border-top:1px solid ' + P.line + '}' +
      'footer a{color:' + A + ';text-decoration:none}' +
      '@media(max-width:860px){.hero{grid-template-columns:1fr;gap:34px;padding:36px 0 54px}h1{font-size:40px}h2{font-size:28px}.stage{max-width:440px;margin:0 auto}}';
  }

  // shared section builder; t(text) renders a text node per flavour; imgTag =
  // the staged hero creative; galleryTags = real site imagery
  function sections(m, t, imgTag, galleryTags) {
    galleryTags = galleryTags || [];
    var h = '';
    h += '<div class="hero-band"><header><div class="wrap"><div class="nav">' +
      '<div class="brand">' + t(m.brand) + '</div>' +
      '<a class="navcta" href="' + esc(m.url) + '">' + t(m.cta) + '</a>' +
    '</div></div></header>' +
    '<div class="wrap"><div class="hero"><div>' +
      (m.badge ? '<div class="badge">' + t(m.badge) + '</div>' : '') +
      '<h1>' + t(m.headline) + '</h1>' +
      (m.subhead ? '<p class="hook">' + t(m.subhead) + '</p>' : '') +
      (m.intro ? '<p class="lead-intro">' + t(m.intro) + '</p>' : '') +
      '<div class="cta-row"><a class="cta" href="' + esc(m.url) + '">' + t(m.cta) + '</a>' +
        (m.sections.length ? '<a class="ghostlink" href="#more">' + t('Read on ↓') + '</a>' : '') +
      '</div>' +
      '</div><div class="stage">' + imgTag + '</div></div></div></div>';
    // AI-written, first-person sections
    m.sections.forEach(function (sec, i) {
      h += '<section' + (i % 2 === 0 ? ' class="band-tint"' : '') + (i === 0 ? ' id="more"' : '') + '><div class="wrap">' +
        (sec.kicker ? '<div class="kicker">' + t(sec.kicker) + '</div>' : '') +
        (sec.title ? '<h2>' + t(sec.title) + '</h2>' : '') +
        (sec.body ? '<p class="lead">' + t(sec.body) + '</p>' : '') +
      '</div></section>';
    });
    // real imagery from the site
    if (galleryTags.length) {
      h += '<section><div class="wrap"><div class="kicker">' + t('See for yourself') + '</div>' +
        '<div class="gal">' + galleryTags.join('') + '</div></div></section>';
    }
    // closing call to action
    h += '<section class="closing"><div class="wrap"><div class="cta-band">' +
      '<h2>' + t(m.headline) + '</h2>' +
      (m.subhead ? '<p>' + t(m.subhead) + '</p>' : '') +
      '<a class="cta" href="' + esc(m.url) + '">' + t(m.cta) + '</a></div></div></section>';
    h += '<footer><div class="wrap">' + t(m.brand) + (m.url !== '#' ? ' · <a href="' + esc(m.url) + '">' + t(m.url.replace(/^https?:\/\//, '')) + '</a>' : '') + '</div></footer>';
    return h;
  }

  /* ---- measurement beacon -------------------------------------------------
     Baked into every generated page. Cookieless: a per-visit random id in
     sessionStorage only. Reports to the collector (`track.url`, falling back
     to the page's own origin — pages served from /p/ hit the same server):
       view  — page opened (carries ?aid= so the visit credits the exact ad)
       beat  — +5s heartbeats while the tab is visible; final beat adds max
               scroll depth on leave
       out   — a click that leaves for another site (the "went on to the main
               website" signal); outbound links also get UTM-tagged per ad so
               the main site's own analytics can attribute the traffic     */
  function beaconJS(m, track) {
    var base = String((track && track.url) || '').replace(/\/+$/, '');
    return '<script>(function(){try{' +
      'var B=' + JSON.stringify(base) + '||location.origin;' +
      'var P=' + JSON.stringify(m.slug) + ';' +
      'var q=new URLSearchParams(location.search);' +
      'var aid=(q.get("aid")||"").toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,48);' +
      'var src=(q.get("s")||"").toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,16);' +
      'var vid;try{vid=sessionStorage.getItem("ah_vid")||"";}catch(e){vid="";}' +
      'if(!vid){vid=Math.random().toString(36).slice(2,12);try{sessionStorage.setItem("ah_vid",vid);}catch(e){}}' +
      'function send(o){o.aid=aid;o.page=P;o.s=src;o.vid=vid;var d=JSON.stringify(o);' +
        'try{if(navigator.sendBeacon&&navigator.sendBeacon(B+"/t",new Blob([d],{type:"text/plain"})))return;}catch(e){}' +
        'try{fetch(B+"/t",{method:"POST",body:d,keepalive:true});}catch(e){}}' +
      'send({t:"view",ref:document.referrer||""});' +
      'var mx=0;addEventListener("scroll",function(){var h=document.documentElement;' +
        'var p=Math.round(100*(h.scrollTop+innerHeight)/Math.max(1,h.scrollHeight));if(p>mx)mx=p;},{passive:true});' +
      'setInterval(function(){if(!document.hidden)send({t:"beat",sec:5});},5000);' +
      'addEventListener("pagehide",function(){send({t:"beat",sec:0,pct:mx});});' +
      'document.addEventListener("click",function(e){' +
        'var a=e.target&&e.target.closest?e.target.closest("a"):null;if(!a)return;' +
        'var href=a.href||"";if(!/^https?:/i.test(href)||a.host===location.host)return;' +
        'try{var u=new URL(href);if(aid&&!u.searchParams.get("utm_source")){' +
          'u.searchParams.set("utm_source",src||"ads");u.searchParams.set("utm_medium","landing");' +
          'u.searchParams.set("utm_campaign",P);u.searchParams.set("utm_content",aid);a.href=u.toString();}}catch(e2){}' +
        'send({t:"out",href:href.slice(0,300)});},true);' +
    '}catch(e){}})();</script>';
  }

  // self-contained page: inline CSS + the ad creative and gallery as data-URIs
  function pageHTML(m, imgDataURL, galleryDataURLs, design, track) {
    var img = imgDataURL ? '<img src="' + imgDataURL + '" alt="' + esc(m.headline) + '">' : '';
    var gal = (galleryDataURLs || []).map(function (g) { return '<img src="' + g + '" alt="' + esc(m.brand) + '">'; });
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + esc(m.headline) + ' — ' + esc(m.brand) + '</title>\n' +
      '<style>' + pageCSS(m, design) + '</style>\n</head>\n<body>\n' +
      sections(m, function (x) { return esc(String(x)); }, img, gal) +
      '\n' + beaconJS(m, track) +
      '\n</body>\n</html>\n';
  }

  // React flavour: same content, text nodes emitted as {"..."} so any
  // characters are safe inside JSX; images imported from the page folder
  function pageJSX(m, galleryFiles, design) {
    function t(x) { return '{' + JSON.stringify(String(x)) + '}'; }
    var img = '<img src={adImage} alt={' + JSON.stringify(m.headline) + '} />';
    var galImports = (galleryFiles || []).map(function (f, i) { return 'import gallery' + (i + 1) + ' from "./' + f + '";'; }).join('\n');
    var gal = (galleryFiles || []).map(function (_, i) { return '<img src={gallery' + (i + 1) + '} alt={' + JSON.stringify(m.brand) + '} />'; });
    var bodyMarkup = sections(m, t, img, gal).replace(/class="/g, 'className="');
    return '/* ' + m.slug + ' — message-matched landing page (generated by Ads Hub).\n' +
      '   Usage: keep ad.png' + (galleryFiles && galleryFiles.length ? ' + ' + galleryFiles.join(', ') : '') + ' next to this file and render <LandingPage />. */\n' +
      'import adImage from "./ad.png";\n' + (galImports ? galImports + '\n' : '') + '\n' +
      'const css = ' + JSON.stringify(pageCSS(m, design)) + ';\n\n' +
      'export default function LandingPage() {\n' +
      '  return (\n    <>\n      <style>{css}</style>\n      ' + bodyMarkup + '\n    </>\n  );\n}\n';
  }

  /* ---- generation orchestrator ------------------------------------------- */
  function blobToDataURL(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result)); };
      r.onerror = function () { rej(new Error('could not read the creative')); };
      r.readAsDataURL(blob);
    });
  }
  function creativeBlob(spec) {
    if (spec.kind === 'video' && Ads.video) return Ads.video.posterBlob(spec);
    return Ads.render.exportPNG(spec);
  }
  function dataURLBytes(durl) {
    var mm = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(durl || ''));
    if (!mm) return null;
    try {
      var bin = atob(mm[2]); var a = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
      var ext = (mm[1].split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
      return { bytes: a, ext: ext || 'png', dataURL: durl };
    } catch (e) { return null; }
  }
  function upload(projectId, name, blob) {
    return fetch('/api/upload?project=' + encodeURIComponent(projectId) + '&name=' + encodeURIComponent(name), {
      method: 'POST', headers: { 'X-Ads-Hub': '1' }, body: blob
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.url) || null; });
  }

  /* ======================================================================
     CUMULUS house template ("1B split hero")
     A fixed, brand-locked landing layout the user supplied for the Cumulus
     project: nav → split hero (headline beside ONE B&W photo) → body prose →
     footer. Any ad whose site is cumulus.world uses this instead of the
     generic site-matched design. Structure + tokens are frozen; only the
     content (headline, subhead, body, image, links) changes per ad.
     ====================================================================== */
  // real Cumulus wordmark, recoloured to ink so it reads on the light sky bg
  var CUMULUS_LOGO = '<svg class="nav-logo" width="122" height="30" viewBox="0 0 122 30" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.97335 5.00514C4.15856 3.16605 7.19898 3.25501 9.27581 4.68828C12.2743 6.51152 14.7011 10.3335 18.5275 9.40807C19.841 9.09052 20.8861 8.27234 20.9274 7.2004C20.9588 6.39084 20.4568 5.63714 19.8379 5.20443C14.6794 1.59831 7.71644 6.6015 4.59735 11.4261C2.7394 14.2999 0.881791 18.6497 3.56383 21.4532C9.43909 27.0042 13.6714 17.6519 17.5429 14.294C20.1837 11.6133 24.5618 12.2667 24.9817 16.369C25.2974 20.7929 21.4763 25 17.1891 25C12.0718 25 8.79925 21.739 6.07281 18.9866C4.95433 17.8574 1.97055 14.1658 1.60344 13.6207C-0.39787 11.0772 -0.794355 7.33487 1.97335 5.00514ZM3.90508 8.13373C1.98768 10.6676 2.72611 14.6819 7.1745 19.0579C12.712 24.5056 19.7386 23.4154 21.5994 18.9549C22.7465 16.2048 20.0722 14.6643 17.9104 16.8986C16.1643 18.7028 14.3186 20.9005 11.9113 22.9092C9.36916 25.0307 4.29772 24.62 2.30585 21.2253C-1.26426 15.1419 6.64551 6.25844 12.2376 3.9563C15.1378 2.71921 19.7309 2.43166 22.1749 4.62277C23.6685 5.96227 24.1034 8.08822 22.8591 9.85146C21.3693 11.9622 18.309 12.1215 16.1416 10.9855C12.7015 9.34945 6.88151 4.20041 3.90508 8.13373Z" fill="#0D0E10"/><path d="M41.3602 22.4711C36.5362 22.4711 33.0562 19.1591 33.0562 13.7111C33.0562 8.28711 36.8482 4.95111 41.3602 4.95111C45.8722 4.95111 48.2242 7.80711 48.7522 10.4231H45.6562C45.2482 9.07911 43.9522 7.56711 41.4322 7.56711C38.4322 7.56711 36.2482 9.79911 36.2482 13.7111C36.2482 17.6231 38.4562 19.8551 41.4322 19.8551C43.9522 19.8551 45.2482 18.3431 45.6562 16.9991H48.7522C48.2242 19.6151 45.8722 22.4711 41.3602 22.4711ZM53.751 22.4711C51.351 22.4711 49.671 20.9351 49.671 17.9591V9.84711H52.551V17.5271C52.551 19.1591 53.151 20.1191 54.591 20.1191C55.863 20.1191 57.159 19.1111 57.159 16.6391V9.84711H60.015V22.1111H57.231V20.5991C56.559 21.8231 55.359 22.4711 53.751 22.4711ZM64.6891 22.1111H61.8331V9.84711H64.5931V11.3351C65.2891 10.1351 66.5371 9.48711 67.9771 9.48711C69.4651 9.48711 70.6411 10.2311 71.2411 11.5031C71.9611 10.3031 73.2811 9.48711 75.0091 9.48711C77.4811 9.48711 79.2331 11.0471 79.2331 13.8791V22.1111H76.3531V14.2871C76.3531 12.7271 75.7291 11.8631 74.4331 11.8631C72.8971 11.8631 71.9611 12.9431 71.9611 15.0551V22.1111H69.1051V14.3351C69.1051 12.7751 68.4571 11.8631 67.1611 11.8631C65.6491 11.8631 64.6891 12.9911 64.6891 15.0551V22.1111ZM85.1713 22.4711C82.7713 22.4711 81.0913 20.9351 81.0913 17.9591V9.84711H83.9713V17.5271C83.9713 19.1591 84.5713 20.1191 86.0113 20.1191C87.2833 20.1191 88.5793 19.1111 88.5793 16.6391V9.84711H91.4353V22.1111H88.6513V20.5991C87.9793 21.8231 86.7793 22.4711 85.1713 22.4711ZM96.1095 22.1111H93.2535V5.31111H96.1095V22.1111ZM102.178 22.4711C99.7775 22.4711 98.0975 20.9351 98.0975 17.9591V9.84711H100.978V17.5271C100.978 19.1591 101.578 20.1191 103.018 20.1191C104.29 20.1191 105.586 19.1111 105.586 16.6391V9.84711H108.442V22.1111H105.658V20.5991C104.986 21.8231 103.786 22.4711 102.178 22.4711ZM115.06 22.4711C111.508 22.4711 109.42 20.7431 109.204 18.2951H112.3C112.492 19.5191 113.428 20.3591 115.18 20.3591C116.596 20.3591 117.58 19.7831 117.58 18.7751C117.58 17.9351 116.932 17.5271 115.204 17.1671L113.764 16.8551C111.1 16.2791 109.66 15.2471 109.66 13.2071C109.66 11.0471 111.724 9.51111 114.7 9.51111C117.964 9.51111 119.764 11.1671 120.028 13.1591H117.172C116.908 12.1751 116.044 11.5991 114.652 11.5991C113.428 11.5991 112.54 12.1511 112.54 13.0391C112.54 13.8311 113.14 14.1671 114.508 14.4551L115.972 14.7911C118.684 15.3911 120.484 16.3511 120.484 18.4871C120.484 20.9351 118.156 22.4711 115.06 22.4711Z" fill="#0D0E10"/></svg>';

  function lHost(u) { try { return new URL(/^https?:/i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  // Cumulus project → its house template; everything else → the generic design
  function landingStyle(opts) {
    var site = opts.site || {};
    return [opts.url, site.finalUrl, site.url].some(function (u) { return lHost(u) === 'cumulus.world'; }) ? 'cumulus' : 'default';
  }
  // the real Cumulus destinations (nav + footer link back to the live site)
  function cumulusLinks(opts) {
    var origin = 'https://www.cumulus.world';   // canonical (bare cumulus.world 301s to www)
    var cands = [(opts.site && opts.site.finalUrl), opts.url, (opts.site && opts.site.url)];
    for (var ci = 0; ci < cands.length; ci++) {
      if (!cands[ci]) continue;
      try { var o = new URL(/^https?:/i.test(cands[ci]) ? cands[ci] : 'https://' + cands[ci]).origin; if (/cumulus\.world/i.test(o)) { origin = o; break; } } catch (e) {}
    }
    return {
      home: origin + '/', product: origin + '/product', people: origin + '/people',
      partners: origin + '/partners', press: origin + '/press',
      login: 'https://app.cumulus.world/login', signup: 'https://app.cumulus.world/sign-up',
      learn: origin + '/'
    };
  }
  // the ONE hero photo: the ad's own visual (data-URI), else a site photo, else
  // the composed creative — grayscaled to the archival look by CSS. Placeholder
  // swatches (no real image model yet) are skipped so a published page never
  // shows the "connect an image model" watermark as its hero.
  function cumulusHero(spec, gallery, fallbackDataURL, placeholders) {
    var p = spec && spec.images && spec.images.product;
    if (p && /^data:/i.test(p) && (placeholders || []).indexOf(p) < 0) return p;
    if (gallery && gallery.length) return gallery[0].dataURL;
    return fallbackDataURL || null;
  }
  // frozen design tokens — verbatim from the supplied 1B template
  function cumulusCSS() {
    return ':root{--sky-100:#E3FBFF;--sky-300:#9AE1ED;--sky-500:#3FA9D1;--sky-600:#2C89AF;--sky-700:#216A88;--ink-950:#0D0E10;--gray-200:#E4E6E9;--gray-500:#8A8D93;--white:#FFFFFF;--accent:var(--sky-500);--accent-soft:var(--sky-100);--text-strong:var(--ink-950);--text-body:#26282C;--text-muted:var(--gray-500);--link:var(--sky-600);--link-hover:var(--sky-700);--border-subtle:var(--gray-200);--border-card:rgba(13,14,16,.07);--radius-lg:20px;--radius-md:16px;--radius-pill:999px;--shadow-card:0 12px 40px rgba(13,14,16,.10);--font:\'Hanken Grotesk\',ui-sans-serif,system-ui,-apple-system,\'Segoe UI\',Roboto,sans-serif;--ls-tight:-0.02em;--ls-wide:0.08em;--lh-body:1.55;--gradient-sky:radial-gradient(120% 90% at 50% 118%,rgba(154,225,237,.62) 0%,#E3FBFF 48%,rgba(227,251,255,0) 100%),#FFFFFF}' +
      '*{box-sizing:border-box}' +
      'body{margin:0;background:var(--gradient-sky);min-height:100vh;font-family:var(--font);color:var(--text-body);-webkit-font-smoothing:antialiased}' +
      '.page{max-width:1120px;margin:0 auto;background:transparent}' +
      '.nav{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:22px 40px}' +
      '.nav-logo{height:26px;width:auto;color:var(--ink-950);display:block}' +
      '.nav-links{display:flex;align-items:center;gap:28px}' +
      '.nav-links a{color:var(--text-strong);font-weight:500;font-size:15px;text-decoration:none;opacity:.82}' +
      '.nav-links a:hover{opacity:1}' +
      '.nav-cta{display:flex;align-items:center;gap:10px}' +
      '.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-family:var(--font);font-weight:600;line-height:1;letter-spacing:-.005em;border-radius:var(--radius-pill);border:1px solid transparent;cursor:pointer;text-decoration:none;padding:9px 18px;font-size:14px;transition:filter .12s ease,transform .12s ease}' +
      '.btn:active{transform:scale(.97)}' +
      '.btn-ghost{background:transparent;color:var(--text-strong)}' +
      '.btn-ghost:hover{background:rgba(13,14,16,.05)}' +
      '.btn-primary{background:var(--accent);color:#fff}' +
      '.btn-primary:hover{filter:brightness(.94)}' +
      '.hero{display:grid;grid-template-columns:1fr 1fr;gap:44px;align-items:center;padding:36px 40px 52px}' +
      '.eyebrow{font-size:13px;font-weight:600;letter-spacing:var(--ls-wide);text-transform:uppercase;color:var(--sky-600);margin:0 0 18px}' +
      '.headline{font-size:48px;line-height:1.05;font-weight:700;letter-spacing:var(--ls-tight);color:var(--text-strong);margin:0 0 18px;text-wrap:balance}' +
      '.subhead{font-size:19px;font-weight:500;line-height:1.25;color:var(--text-body);margin:0}' +
      '.hero-media{position:relative;aspect-ratio:5/4;border-radius:var(--radius-lg);overflow:hidden;box-shadow:var(--shadow-card)}' +
      '.hero-media img{width:100%;height:100%;object-fit:cover;display:block;filter:grayscale(1)}' +
      '.hero-image--placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:#eef1f3;color:var(--text-muted);font-size:14px;font-weight:500}' +
      '.body{padding:8px 40px 40px}' +
      '.prose{max-width:620px;display:flex;flex-direction:column;gap:18px}' +
      '.prose p{margin:0;font-size:16px;line-height:var(--lh-body);color:var(--text-body);text-wrap:pretty}' +
      '.prose h2{margin:14px 0 0;font-size:22px;font-weight:700;letter-spacing:-.01em;color:var(--text-strong)}' +
      '.foot{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin:0 40px;padding:26px 0 34px;border-top:1px solid var(--border-subtle)}' +
      '.foot-links{display:flex;align-items:center;gap:24px;flex-wrap:wrap}' +
      '.foot-links a{color:var(--link);font-size:14px;font-weight:500;text-decoration:none}' +
      '.foot-links a:hover{color:var(--link-hover);text-decoration:underline}' +
      '.learn{display:inline-flex;align-items:center;gap:8px;background:var(--accent-soft);color:var(--sky-700);font-size:14.5px;font-weight:600;padding:11px 20px;border-radius:var(--radius-pill);text-decoration:none}' +
      '.learn:hover{filter:brightness(.96)}' +
      '.learn svg{width:16px;height:16px}' +
      '@media (max-width:720px){.hero{grid-template-columns:1fr;gap:28px;padding:24px 22px 36px}.headline{font-size:36px}.nav-links{display:none}.nav,.body,.foot{padding-left:22px;padding-right:22px}.foot{margin:0 22px}}';
  }
  // fill the fixed 1B structure with this ad's content. t() escapes per flavour.
  function cumulusMarkup(m, t, heroImgTag, L) {
    var secs = m.sections || [];
    var eyebrow = (secs[0] && secs[0].kicker) || m.badge || 'The promise';
    var prose = '';
    if (m.intro) prose += '<p>' + t(m.intro) + '</p>';
    secs.forEach(function (s) {
      if (s.title) prose += '<h2>' + t(s.title) + '</h2>';
      if (s.body) prose += '<p>' + t(s.body) + '</p>';
    });
    if (!prose) prose = '<p>' + t(m.subhead || m.hook || '') + '</p>';
    return '<main class="page">' +
      '<nav class="nav">' +
        '<a href="' + esc(L.home) + '" aria-label="Cumulus home">' + CUMULUS_LOGO + '</a>' +
        '<div class="nav-links">' +
          '<a href="' + esc(L.product) + '">Product</a><a href="' + esc(L.people) + '">People</a>' +
          '<a href="' + esc(L.partners) + '">Partners</a><a href="' + esc(L.press) + '">Press</a>' +
        '</div>' +
        '<div class="nav-cta"><a class="btn btn-ghost" href="' + esc(L.login) + '">Log In</a>' +
          '<a class="btn btn-primary" href="' + esc(L.signup) + '">Sign Up</a></div>' +
      '</nav>' +
      '<section class="hero"><div class="hero-copy">' +
        '<p class="eyebrow">' + t(eyebrow) + '</p>' +
        '<h1 class="headline">' + t(m.headline) + '</h1>' +
        (m.subhead ? '<p class="subhead">' + t(m.subhead) + '</p>' : '') +
      '</div><div class="hero-media">' + heroImgTag + '</div></section>' +
      '<section class="body"><div class="prose">' + prose + '</div></section>' +
      '<footer class="foot"><div class="foot-links">' +
        '<a href="' + esc(L.home) + '">&larr; Back to Cumulus</a>' +
        '<a href="' + esc(L.product) + '">Product</a><a href="' + esc(L.people) + '">People</a>' +
      '</div>' +
      '<a class="learn" href="' + esc(L.learn) + '">Learn more <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>' +
      '</footer></main>';
  }
  function cumulusPageHTML(m, heroDataURL, opts, track) {
    var L = cumulusLinks(opts);
    var heroImg = heroDataURL
      ? '<img src="' + heroDataURL + '" alt="' + esc(m.headline || 'Cumulus') + '">'
      : '<div class="hero-image--placeholder">A memory worth keeping</div>';
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + esc(m.headline) + ' · Cumulus</title>\n' +
      '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
      '<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400;1,500&display=swap" rel="stylesheet">\n' +
      '<style>' + cumulusCSS() + '</style>\n</head>\n<body>\n' +
      cumulusMarkup(m, function (x) { return esc(String(x)); }, heroImg, L) +
      '\n' + beaconJS(m, track) +
      '\n</body>\n</html>\n';
  }

  // opts: { items:[{spec,adKey,headline,hook,slug,content}], projectId, url,
  //         site, dossier, brandName, images, track, onProgress }
  // → { pages:[{slug, headline, adKey, adName, adCount:1, adKeys, files, tracked, publicPath}], failed, zipBlob }
  function generate(opts) {
    var items = opts.items || [];
    var style = landingStyle(opts);        // 'cumulus' → house template; else the generic design
    return resolveDesign(opts).then(function (design) {
      var zipFiles = [], pages = [], failed = [], usedSlugs = {};
      var gallery = (opts.images || []).map(dataURLBytes).filter(Boolean).slice(0, 3);
      var galleryNames = gallery.map(function (gd, gi) { return 'gallery-' + (gi + 1) + '.' + gd.ext; });
      var i = 0;
      function uniqSlug(s) { var b = s, k = 1; while (usedSlugs[s]) s = b + '-' + (++k); usedSlugs[s] = 1; return s; }
      function next() {
        if (i >= items.length) return Promise.resolve({ pages: pages, failed: failed, zipBlob: Ads.render.zipStore(zipFiles) });
        var item = items[i];
        var m = pageModel(item, opts);
        m.slug = uniqSlug(m.slug); item.slug = m.slug;
        if (opts.onProgress) opts.onProgress(i + 1, items.length, m.headline);
        return creativeBlob(item.spec).then(function (png) {
          return blobToDataURL(png).then(function (dataURL) {
            var html, jsx;
            if (style === 'cumulus') {
              // ONE B&W photo (the ad's own visual), the fixed house layout, HTML only
              html = cumulusPageHTML(m, cumulusHero(item.spec, gallery, dataURL, opts.placeholders), opts, opts.track);
              jsx = null;
            } else {
              html = pageHTML(m, dataURL, gallery.map(function (gd) { return gd.dataURL; }), design, opts.track);
              jsx = pageJSX(m, galleryNames, design);
            }
            return png.arrayBuffer().then(function (buf) {
              return Promise.all([
                upload(opts.projectId, 'landing-' + m.slug + '.html', new Blob([html], { type: 'text/html' })),
                jsx ? upload(opts.projectId, 'landing-' + m.slug + '.jsx', new Blob([jsx], { type: 'text/plain' })) : Promise.resolve(null),
                upload(opts.projectId, 'landing-' + m.slug + '.png', png)
              ]).then(function (urls) {
                if (!urls[0] && !urls[2]) throw new Error('upload failed');
                // publish to the tracking collector: makes /p/<slug>/ live and
                // registers THIS ad's key so its /a/<key> link resolves. One ad
                // per page → one key per page. Best-effort.
                var reg = item.adKey ? [{ key: item.adKey, name: item.spec.name || '', headline: m.headline }] : [];
                return fetch('/api/track/publish', {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
                  body: JSON.stringify({ slug: m.slug, html: html, ads: reg })
                }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
                .then(function (pub) {
                  zipFiles.push({ name: m.slug + '/index.html', bytes: new TextEncoder().encode(html) });
                  if (jsx) zipFiles.push({ name: m.slug + '/Landing.jsx', bytes: new TextEncoder().encode(jsx) });
                  zipFiles.push({ name: m.slug + '/ad.png', bytes: new Uint8Array(buf) });
                  gallery.forEach(function (gd, gi) { zipFiles.push({ name: m.slug + '/' + galleryNames[gi], bytes: gd.bytes }); });
                  pages.push({
                    slug: m.slug, headline: m.headline, adCount: 1,
                    adKey: item.adKey || null, adName: item.spec.name || '',
                    adKeys: item.adKey ? [item.adKey] : [],
                    files: { html: urls[0], jsx: urls[1], png: urls[2] },
                    tracked: !!pub, publicPath: pub ? pub.url : null,
                    createdAt: util.nowISO()
                  });
                  i++; return next();
                });
              });
            });
          });
        }).catch(function () { failed.push(m.headline); i++; return next(); });
      }
      return next();
    });
  }

  Ads.landing = { distinctHooks: distinctHooks, resolveDesign: resolveDesign, generate: generate, pageHTML: pageHTML, pageJSX: pageJSX, pageModel: pageModel };
})();
