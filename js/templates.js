/* ============================================================================
   ADS HUB — ad template engine
   A registry of Meta-ready creative templates. Each ad is authored at 1080px
   wide; one shared stylesheet (driven by CSS variables) styles every template,
   so the on-screen preview and the exported PNG are pixel-identical.
   Exposes window.Ads.templates.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var esc = Ads.util.escapeHtml;

  /* ---- Formats ----------------------------------------------------------- */
  var FORMATS = {
    square:   { w: 1080, h: 1080, label: 'Square 1:1',   sub: 'Feed' },
    portrait: { w: 1080, h: 1350, label: 'Portrait 4:5', sub: 'Feed (max real estate)' },
    story:    { w: 1080, h: 1920, label: 'Story 9:16',   sub: 'Stories / Reels' }
  };

  /* ---- Backgrounds (value is a valid CSS `background` shorthand) ---------- */
  // theme = default text treatment that reads well on this background.
  var BACKGROUNDS = [
    { id: 'midnight',        label: 'Midnight',  theme: 'dark',  css: function () { return 'linear-gradient(160deg,#12152e 0%,#0a0b18 100%)'; } },
    { id: 'solid-dark',      label: 'Ink',       theme: 'dark',  css: function () { return '#0b0c10'; } },
    { id: 'solid-light',     label: 'Paper',     theme: 'light', css: function () { return '#f4f5f7'; } },
    { id: 'gradient-blue',   label: 'Azure',     theme: 'dark',  css: function () { return 'linear-gradient(135deg,#0b3a6f 0%,#0ea5e9 100%)'; } },
    { id: 'gradient-purple', label: 'Ultra',     theme: 'dark',  css: function () { return 'linear-gradient(135deg,#3b1d6e 0%,#7c3aed 100%)'; } },
    { id: 'gradient-sunset', label: 'Sunset',    theme: 'dark',  css: function (a) { return 'linear-gradient(135deg,#7a1f48 0%,' + (a || '#ff7a3c') + ' 100%)'; } },
    { id: 'gradient-emerald',label: 'Emerald',   theme: 'dark',  css: function () { return 'linear-gradient(135deg,#053b32 0%,#10b981 100%)'; } },
    { id: 'mesh',            label: 'Mesh',      theme: 'dark',  css: function (a) {
        return 'radial-gradient(60rem 60rem at 18% 18%,' + hexA(a || '#ff7a3c', 0.42) + ' 0%,transparent 60%),' +
               'radial-gradient(55rem 55rem at 85% 78%,rgba(99,102,241,0.45) 0%,transparent 58%),' +
               'radial-gradient(45rem 45rem at 80% 8%,rgba(14,165,233,0.40) 0%,transparent 55%),#0a0b14'; } },
    { id: 'dots',            label: 'Dots',      theme: 'dark',  css: function () {
        return 'radial-gradient(rgba(255,255,255,0.10) 2px,transparent 2px) 0 0/34px 34px,linear-gradient(160deg,#171a2e,#0c0d16)'; } },
    { id: 'rainbow',         label: 'Spectrum',  theme: 'dark',  css: function () {
        return 'linear-gradient(115deg,#ff6b6b 0%,#ffd166 28%,#06d6a0 55%,#118ab2 78%,#7c3aed 100%)'; } },
    { id: 'image',           label: 'Image',     theme: 'dark',  css: function () { return '#000'; } }
  ];
  function bgById(id) { for (var i = 0; i < BACKGROUNDS.length; i++) if (BACKGROUNDS[i].id === id) return BACKGROUNDS[i]; return BACKGROUNDS[0]; }
  // hex (#rgb/#rrggbb) → rgba() with alpha
  function hexA(hex, a) {
    hex = String(hex || '#ff7a3c').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16); return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---- Fonts ------------------------------------------------------------- */
  var FONTS = {
    clean: { label: 'Clean (Helvetica)', display: "'Helvetica Neue',Helvetica,Arial,sans-serif", body: "'Helvetica Neue',Helvetica,Arial,sans-serif", weight: 800 },
    brand: { label: 'Brand (Champion)',  display: "'Champion Heavyweight','Helvetica Neue',sans-serif", body: "'Neue Haas Grotesk','Helvetica Neue',sans-serif", weight: 400 }
  };

  /* ---- Template registry ------------------------------------------------- */
  // fields = which control groups the generator should surface for this template
  var LIST = [
    { id: 'comparison',  label: 'Comparison', fields: ['badge', 'headline', 'subtext', 'cta', 'beforeAfter'],
      icon: tplIco('<rect x="3" y="6" width="8" height="12"/><rect x="13" y="6" width="8" height="12"/>') },
    { id: 'phone',       label: 'Device',     fields: ['badge', 'headline', 'subtext', 'cta', 'product'],
      icon: tplIco('<rect x="8" y="3" width="8" height="18" rx="1.5"/><line x1="10.5" y1="18.5" x2="13.5" y2="18.5"/>') },
    { id: 'statement',   label: 'Statement',  fields: ['badge', 'headline', 'subtext', 'cta'],
      icon: tplIco('<line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="12" x2="16" y2="12"/><line x1="4" y1="16" x2="12" y2="16"/>') },
    { id: 'stat',        label: 'Big Stat',   fields: ['badge', 'headline', 'subtext', 'cta', 'stat'],
      icon: tplIco('<text x="5" y="17" font-size="13" font-family="sans-serif" fill="currentColor" stroke="none">3x</text>') },
    { id: 'quote',       label: 'Testimonial',fields: ['badge', 'headline', 'cta', 'quote'],
      icon: tplIco('<path d="M6 7h5v5H8a2 2 0 0 1-2-2z"/><path d="M14 7h4v5h-2a2 2 0 0 1-2-2z"/>') },
    { id: 'feature',     label: 'Features',   fields: ['badge', 'headline', 'subtext', 'cta', 'bullets', 'product'],
      icon: tplIco('<polyline points="4 7 6 9 9 5"/><line x1="12" y1="7" x2="20" y2="7"/><polyline points="4 14 6 16 9 12"/><line x1="12" y1="14" x2="20" y2="14"/>') },
    { id: 'plain-image', label: 'Image + Bar',fields: ['headline', 'cta', 'product'],
      icon: tplIco('<rect x="4" y="4" width="16" height="11"/><circle cx="9" cy="9" r="1.5"/><polyline points="4 14 10 10 14 13 20 8"/><line x1="4" y1="19" x2="20" y2="19"/>') },
    { id: 'overlay',     label: 'Image Overlay', fields: ['badge', 'headline', 'subtext', 'cta', 'product'],
      icon: tplIco('<rect x="4" y="4" width="16" height="16"/><line x1="7" y1="14" x2="14" y2="14"/><line x1="7" y1="17" x2="11" y2="17"/>') }
  ];
  function tplIco(p) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' + p + '</svg>'; }
  function tplById(id) { for (var i = 0; i < LIST.length; i++) if (LIST[i].id === id) return LIST[i]; return LIST[0]; }

  /* ---- Copy helpers ------------------------------------------------------ */
  // Escape subtext, then wrap each bold phrase occurrence in <b>.
  function applyBold(text, phrases) {
    var out = esc(text);
    (phrases || []).forEach(function (p) {
      p = String(p || '').trim(); if (!p) return;
      var e = esc(p);
      var idx = out.toLowerCase().indexOf(e.toLowerCase());
      if (idx >= 0) out = out.slice(0, idx) + '<b>' + out.slice(idx, idx + e.length) + '</b>' + out.slice(idx + e.length);
    });
    return out;
  }
  function headlineHTML(spec) {
    var a = esc(spec.headlineStart || '');
    var b = spec.headlineHighlight ? '<span class="hl">' + esc(spec.headlineHighlight) + '</span>' : '';
    if (a && b) return a + ' ' + b;
    return a || b;
  }
  // Auto-shrink so long taglines never overflow: '' (base) | 'md' | 'sm' by chars.
  function autoSize(spec, boost) {
    var len = ((spec.headlineStart || '') + ' ' + (spec.headlineHighlight || '')).trim().length;
    if (boost === 'xl') return len > 30 ? (len > 48 ? 'md' : '') : 'xl';
    if (len > 56) return 'sm';
    if (len > 34) return 'md';
    return boost || '';
  }
  function density(spec) { return spec.density === 'minimal' || spec.density === 'rich' ? spec.density : 'standard'; }
  function badgeHTML(spec) {
    if (!spec.badge || density(spec) === 'minimal') return '';
    return '<div class="ad-badge"><span class="ad-badge-dots"><i></i><i></i><i></i></span>' + esc(spec.badge) + '</div>';
  }
  function ctaHTML(spec) { return spec.cta ? '<div class="ad-cta">' + esc(spec.cta) + '</div>' : ''; }
  // Compact bullet strip shown in "rich" density on templates without their own list.
  function richExtras(spec) {
    if (density(spec) !== 'rich') return '';
    var bullets = (spec.bullets || []).filter(Boolean).slice(0, 3);
    if (!bullets.length) return '';
    return '<div class="ad-minilist">' + bullets.map(function (b) {
      return '<span class="ad-minilist-item"><i>✓</i>' + esc(b) + '</span>';
    }).join('') + '</div>';
  }
  function brandHTML(spec) {
    if (spec.logo) return '<img class="ad-logo" src="' + spec.logo + '" alt="" />';
    return spec.brand ? '<div class="ad-brandmark">' + esc(spec.brand) + '</div>' : '';
  }

  /* ---- Faux UI building blocks (so templates look real without uploads) -- */
  function fauxCode() {
    var widths = [70, 52, 84, 40, 66, 30, 58, 74, 46];
    return '<div class="fx fx-code">' +
      '<div class="fx-bar"><i></i><i></i><i></i></div>' +
      '<div class="fx-lines">' + widths.map(function (w, i) {
        return '<span style="width:' + w + '%;opacity:' + (0.35 + (i % 3) * 0.22) + '"></span>';
      }).join('') + '</div></div>';
  }
  function fauxDash(accent) {
    var bars = [40, 58, 47, 72, 63, 88, 80];
    return '<div class="fx fx-dash">' +
      '<div class="fx-dash-head"><span class="fx-dash-title">Revenue</span><span class="fx-dash-tag" style="color:' + esc(accent) + '">+24%</span></div>' +
      '<div class="fx-dash-kpis"><div><b>$47.2K</b><em>MRR</em></div><div><b>1,247</b><em>Users</em></div><div><b>2.1%</b><em>Churn</em></div></div>' +
      '<div class="fx-chart">' + bars.map(function (h) { return '<span style="height:' + h + '%"></span>'; }).join('') + '</div>' +
      '</div>';
  }
  function fauxPhone(spec) {
    var inner = spec.images && spec.images.product
      ? '<img class="ph-shot" src="' + spec.images.product + '" alt="" />'
      : '<div class="ph-ui">' + fauxDash(spec.accent) + '</div>';
    return '<div class="ad-phone"><div class="ad-phone-notch"></div>' + inner + '</div>';
  }
  function panel(slot, spec, kind) {
    var img = spec.images && spec.images[slot];
    var caption = (spec.captions && spec.captions[slot]) || '';
    var mark = kind === 'bad' ? '<div class="cmp-mark bad">✕</div>' : '<div class="cmp-mark good">✓</div>';
    var body = img ? '<img class="cmp-img" src="' + img + '" alt="" />' : (kind === 'bad' ? fauxCode() : fauxDash(spec.accent));
    return '<div class="cmp-panel ' + kind + '">' + mark + '<div class="cmp-body">' + body + '</div>' +
      (caption ? '<div class="cmp-cap">' + esc(caption) + '</div>' : '') + '</div>';
  }

  /* ---- Per-template inner content --------------------------------------- */
  // spec.layout shifts media/text placement where the template supports it;
  // spec.density (minimal|standard|rich) controls how much copy is on-image;
  // spec.align (left|center) controls the stack alignment.
  function stackCls(spec, forceCenter) {
    return 'ad-stack' + ((forceCenter || spec.align === 'center') ? ' center' : '');
  }
  var RENDER = {
    comparison: function (spec) {
      return '<div class="' + stackCls(spec) + '">' +
        badgeHTML(spec) +
        '<h1 class="ad-headline ' + autoSize(spec) + '">' + headlineHTML(spec) + '</h1>' +
        subtextBlock(spec) +
        '<div class="cmp-row">' + panel('before', spec, 'bad') + panel('after', spec, 'good') + '</div>' +
        richExtras(spec) +
        ctaHTML(spec) +
      '</div>';
    },
    phone: function (spec) {
      var copyFirst = spec.layout !== 'top'; // 'top' puts the device above the copy
      var copy = badgeHTML(spec) +
        '<h1 class="ad-headline ' + autoSize(spec) + '">' + headlineHTML(spec) + '</h1>' +
        subtextBlock(spec);
      return '<div class="' + stackCls(spec) + '">' +
        (copyFirst ? copy + fauxPhone(spec) : fauxPhone(spec) + copy) +
        richExtras(spec) +
        ctaHTML(spec) +
      '</div>';
    },
    statement: function (spec) {
      return '<div class="' + stackCls(spec, spec.align !== 'left') + '">' +
        badgeHTML(spec) +
        '<h1 class="ad-headline ' + autoSize(spec, 'xl') + '">' + headlineHTML(spec) + '</h1>' +
        subtextBlock(spec) +
        richExtras(spec) +
        ctaHTML(spec) +
        brandFoot(spec) +
      '</div>';
    },
    stat: function (spec) {
      var st = spec.stat || {};
      return '<div class="' + stackCls(spec, spec.align !== 'left') + '">' +
        badgeHTML(spec) +
        '<div class="ad-stat"><span class="ad-stat-val">' + esc(st.value || '3x') + '</span>' +
          (st.label ? '<span class="ad-stat-label">' + esc(st.label) + '</span>' : '') + '</div>' +
        '<h1 class="ad-headline md">' + headlineHTML(spec) + '</h1>' +
        subtextBlock(spec) +
        ctaHTML(spec) +
      '</div>';
    },
    quote: function (spec) {
      var q = spec.quote || {};
      return '<div class="' + stackCls(spec, spec.align !== 'left') + '">' +
        badgeHTML(spec) +
        '<div class="ad-quote-mark">“</div>' +
        '<blockquote class="ad-quote">' + esc(q.text || '') + '</blockquote>' +
        '<div class="ad-quote-by">' +
          '<div class="ad-avatar">' + esc((q.author || 'A').slice(0, 1).toUpperCase()) + '</div>' +
          '<div><div class="ad-quote-author">' + esc(q.author || '') + '</div>' +
          (q.role ? '<div class="ad-quote-role">' + esc(q.role) + '</div>' : '') + '</div>' +
        '</div>' +
        ctaHTML(spec) +
      '</div>';
    },
    feature: function (spec) {
      var bullets = (spec.bullets || []).filter(Boolean);
      var hasImg = spec.images && spec.images.product;
      var mediaLeft = spec.layout === 'left';
      var list = '<ul class="feat-list">' + bullets.map(function (b) {
        return '<li><span class="feat-check">✓</span>' + esc(b) + '</li>';
      }).join('') + '</ul>';
      var media = hasImg ? '<div class="feat-media"><img src="' + spec.images.product + '" alt="" /></div>' : '';
      return '<div class="' + stackCls(spec) + '">' +
        badgeHTML(spec) +
        '<h1 class="ad-headline ' + autoSize(spec) + '">' + headlineHTML(spec) + '</h1>' +
        subtextBlock(spec) +
        '<div class="feat-row' + (hasImg ? ' has-img' : '') + '">' +
          (mediaLeft ? media + list : list + media) +
        '</div>' +
        ctaHTML(spec) +
      '</div>';
    },
    'plain-image': function (spec) {
      var media = spec.images && spec.images.product
        ? '<img src="' + spec.images.product + '" alt="" />'
        : fauxDash(spec.accent);
      var mediaBlock = '<div class="pi-media">' + media + '</div>';
      var textBlock = '<div class="pi-foot">' +
          '<h1 class="ad-headline sm">' + headlineHTML(spec) + '</h1>' +
          ctaHTML(spec) +
        '</div>';
      var textFirst = spec.layout === 'bottom'; // media sits below the text bar
      return '<div class="' + stackCls(spec) + '">' +
        (textFirst ? textBlock + mediaBlock : mediaBlock + textBlock) +
      '</div>';
    },
    overlay: function (spec) {
      var img = spec.images && spec.images.product;
      var pos = spec.layout === 'top' ? 'top' : (spec.layout === 'center' ? 'center' : 'bottom');
      return '<div class="ov-wrap">' +
        (img ? '<img class="ov-img" src="' + img + '" alt="" />' : '<div class="ov-img ov-fallback"></div>') +
        '<div class="ov-shade ov-' + pos + '"></div>' +
        '<div class="ov-content ov-' + pos + (spec.align === 'center' ? ' center' : '') + '">' +
          badgeHTML(spec) +
          '<h1 class="ad-headline ' + autoSize(spec) + '">' + headlineHTML(spec) + '</h1>' +
          subtextBlock(spec) +
          ctaHTML(spec) +
        '</div>' +
      '</div>';
    }
  };
  function subtextBlock(spec) {
    if (!spec.subtext || density(spec) === 'minimal') return '';
    return '<p class="ad-subtext">' + applyBold(spec.subtext, spec.boldPhrases) + '</p>';
  }
  function brandFoot(spec) { var b = brandHTML(spec); return b ? '<div class="ad-foot">' + b + '</div>' : ''; }

  /* ---- Effective colours from theme/background --------------------------- */
  function colors(spec) {
    var bg = bgById(spec.background);
    var theme = spec.theme || bg.theme;
    var light = theme === 'light';
    return {
      bg: spec.background === 'image' && spec.bgImage
        ? '#000 center/cover no-repeat url(' + spec.bgImage + ')'
        : bg.css(spec.accent),
      fg: light ? '#0b0c12' : '#ffffff',
      muted: light ? 'rgba(11,12,18,0.62)' : 'rgba(255,255,255,0.74)',
      panel: light ? 'rgba(11,12,18,0.05)' : 'rgba(255,255,255,0.07)',
      panelLine: light ? 'rgba(11,12,18,0.12)' : 'rgba(255,255,255,0.14)',
      accent: spec.accent || '#ff7a3c',
      onAccent: contrastOn(spec.accent || '#ff7a3c')
    };
  }
  function contrastOn(hex) {
    hex = String(hex).replace('#', ''); if (hex.length === 3) hex = hex.replace(/(.)/g, '$1$1');
    var n = parseInt(hex, 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0b0c12' : '#ffffff';
  }

  /* ---- Public render ----------------------------------------------------- */
  // Returns { html, width, height } — html is a self-contained, XML-well-formed
  // <div class="ad ..."> with all per-ad values supplied as inline CSS vars.
  function renderHTML(spec) {
    var fmt = FORMATS[spec.format] || FORMATS.square;
    var c = colors(spec);
    var font = FONTS[spec.font] || FONTS.clean;
    var inner = (RENDER[spec.template] || RENDER.comparison)(spec);
    var vars = [
      '--ad-bg:' + c.bg, '--ad-fg:' + c.fg, '--ad-muted:' + c.muted,
      '--ad-panel:' + c.panel, '--ad-panel-line:' + c.panelLine,
      '--ad-accent:' + c.accent, '--ad-on-accent:' + c.onAccent,
      '--ad-font-display:' + font.display, '--ad-font-body:' + font.body, '--ad-display-weight:' + font.weight
    ].join(';');
    var html = '<div class="ad ad--' + esc(spec.template) + ' fmt--' + esc(spec.format) +
      ' den--' + esc(spec.density || 'standard') +
      '" style="width:' + fmt.w + 'px;height:' + fmt.h + 'px;' + vars + '">' +
      '<div class="ad-inner' + (spec.template === 'overlay' ? ' is-flush' : '') + '">' + inner + '</div></div>';
    return { html: html, width: fmt.w, height: fmt.h };
  }

  /* ---- The shared ad stylesheet (preview + export use the SAME string) --- */
  function adCSS() {
    return [
      '.ad{box-sizing:border-box;position:relative;overflow:hidden;background:var(--ad-bg);color:var(--ad-fg);',
        'font-family:var(--ad-font-body);-webkit-font-smoothing:antialiased;}',
      '.ad *,.ad *::before,.ad *::after{box-sizing:border-box;}',
      '.ad-inner{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:96px 90px;}',
      '.fmt--story .ad-inner{padding:150px 96px;}',
      '.ad-stack{display:flex;flex-direction:column;gap:38px;}',
      '.ad-stack.center{align-items:center;text-align:center;}',
      // badge
      '.ad-badge{align-self:flex-start;display:inline-flex;align-items:center;gap:14px;background:var(--ad-panel);',
        'border:1px solid var(--ad-panel-line);color:var(--ad-fg);font-size:24px;font-weight:600;letter-spacing:.02em;',
        'padding:14px 26px;border-radius:100px;}',
      '.ad-stack.center .ad-badge{align-self:center;}',
      '.ad-badge-dots{display:inline-flex;gap:5px;}',
      '.ad-badge-dots i{width:12px;height:12px;border-radius:50%;background:var(--ad-accent);display:block;opacity:.9;}',
      '.ad-badge-dots i:nth-child(2){opacity:.6;}.ad-badge-dots i:nth-child(3){opacity:.4;}',
      // headline
      '.ad-headline{margin:0;font-family:var(--ad-font-display);font-weight:var(--ad-display-weight);',
        'font-size:96px;line-height:.98;letter-spacing:-.02em;}',
      '.ad-headline.xl{font-size:128px;}.ad-headline.md{font-size:78px;}.ad-headline.sm{font-size:60px;}',
      '.ad-headline .hl{color:var(--ad-accent);}',
      // subtext
      '.ad-subtext{margin:0;font-size:33px;line-height:1.36;color:var(--ad-muted);max-width:18em;}',
      '.ad-stack.center .ad-subtext{max-width:16em;}',
      '.ad-subtext b{color:var(--ad-fg);font-weight:700;}',
      // cta
      '.ad-cta{align-self:flex-start;background:var(--ad-accent);color:var(--ad-on-accent);font-weight:700;',
        'font-size:31px;letter-spacing:.01em;padding:24px 44px;border-radius:14px;}',
      '.ad-stack.center .ad-cta{align-self:center;}',
      // brand foot
      '.ad-foot{margin-top:18px;}',
      '.ad-brandmark{font-family:var(--ad-font-display);font-weight:var(--ad-display-weight);font-size:34px;letter-spacing:.18em;text-transform:uppercase;opacity:.85;}',
      '.ad-logo{height:54px;width:auto;object-fit:contain;}',
      // comparison
      '.cmp-row{display:flex;gap:34px;}',
      '.cmp-panel{position:relative;flex:1;background:var(--ad-panel);border:1px solid var(--ad-panel-line);border-radius:22px;padding:34px;min-height:330px;display:flex;flex-direction:column;gap:20px;}',
      '.cmp-mark{position:absolute;top:-22px;left:50%;transform:translateX(-50%);width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800;color:#fff;z-index:2;}',
      '.cmp-mark.bad{background:#e5484d;}.cmp-mark.good{background:#30a46c;}',
      '.cmp-body{flex:1;display:flex;flex-direction:column;justify-content:center;}',
      '.cmp-img{width:100%;height:100%;object-fit:cover;border-radius:12px;}',
      '.cmp-cap{text-align:center;font-size:25px;color:var(--ad-muted);font-weight:600;}',
      // faux code
      '.fx{border-radius:14px;overflow:hidden;}',
      '.fx-code{background:#0d1018;border:1px solid rgba(255,255,255,.08);padding:22px;}',
      '.fx-bar{display:flex;gap:9px;margin-bottom:18px;}',
      '.fx-bar i{width:13px;height:13px;border-radius:50%;background:rgba(255,255,255,.25);}',
      '.fx-lines{display:flex;flex-direction:column;gap:13px;}',
      '.fx-lines span{height:11px;border-radius:6px;background:linear-gradient(90deg,#5b9dff,#8a7dff);display:block;}',
      // faux dashboard
      '.fx-dash{background:#fff;color:#0b0c12;border-radius:14px;padding:24px;display:flex;flex-direction:column;gap:18px;box-shadow:0 20px 50px rgba(0,0,0,.25);}',
      '.fx-dash-head{display:flex;justify-content:space-between;align-items:center;}',
      '.fx-dash-title{font-weight:700;font-size:24px;}.fx-dash-tag{font-weight:800;font-size:22px;}',
      '.fx-dash-kpis{display:flex;gap:22px;}',
      '.fx-dash-kpis b{display:block;font-size:30px;font-weight:800;}.fx-dash-kpis em{font-style:normal;font-size:18px;color:#6b7280;}',
      '.fx-chart{display:flex;align-items:flex-end;gap:10px;height:120px;}',
      '.fx-chart span{flex:1;background:linear-gradient(180deg,var(--ad-accent),#c2410c);border-radius:6px 6px 0 0;min-height:8px;}',
      // phone
      '.ad-phone{position:relative;align-self:center;width:430px;height:600px;background:#0b0c12;border:14px solid #1c1f2b;border-radius:54px;box-shadow:0 40px 90px rgba(0,0,0,.45);overflow:hidden;}',
      '.ad-phone-notch{position:absolute;top:18px;left:50%;transform:translateX(-50%);width:130px;height:26px;background:#1c1f2b;border-radius:0 0 18px 18px;z-index:3;}',
      '.ad-phone .ph-shot{width:100%;height:100%;object-fit:cover;}',
      '.ad-phone .ph-ui{position:absolute;inset:0;padding:54px 26px 26px;display:flex;align-items:center;}',
      // stat
      '.ad-stat{display:flex;flex-direction:column;align-items:center;gap:6px;}',
      '.ad-stat-val{font-family:var(--ad-font-display);font-weight:var(--ad-display-weight);font-size:300px;line-height:.86;color:var(--ad-accent);letter-spacing:-.03em;}',
      '.ad-stat-label{font-size:34px;color:var(--ad-muted);font-weight:600;}',
      // quote
      '.ad-quote-mark{font-family:Georgia,serif;font-size:160px;line-height:.5;height:80px;color:var(--ad-accent);}',
      '.ad-quote{margin:0;font-family:var(--ad-font-display);font-weight:var(--ad-display-weight);font-size:62px;line-height:1.12;letter-spacing:-.01em;max-width:15em;}',
      '.ad-quote-by{display:flex;align-items:center;gap:20px;}',
      '.ad-avatar{width:74px;height:74px;border-radius:50%;background:var(--ad-accent);color:var(--ad-on-accent);display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:800;}',
      '.ad-quote-author{font-size:30px;font-weight:700;}.ad-quote-role{font-size:24px;color:var(--ad-muted);}',
      // features
      '.feat-row{display:flex;gap:46px;align-items:center;}',
      '.feat-list{display:flex;flex-direction:column;gap:24px;flex:1;}',
      '.feat-list li{display:flex;align-items:flex-start;gap:18px;font-size:34px;line-height:1.25;}',
      '.feat-check{flex:0 0 auto;width:44px;height:44px;border-radius:50%;background:var(--ad-accent);color:var(--ad-on-accent);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;}',
      '.feat-media{flex:0 0 42%;}.feat-media img{width:100%;border-radius:18px;}',
      // plain image
      '.pi-media{flex:1;border-radius:22px;overflow:hidden;background:var(--ad-panel);display:flex;align-items:center;justify-content:center;}',
      '.pi-media img{width:100%;height:100%;object-fit:cover;}',
      '.pi-foot{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-top:40px;}',
      '.pi-foot .ad-headline{margin:0;}',
      '.ad--plain-image .pi-foot{margin-top:0;margin-bottom:40px;}',
      '.ad--plain-image .pi-media + .pi-foot{margin-top:40px;margin-bottom:0;}',
      // overlay (full-bleed image + gradient shade + copy)
      '.ad-inner.is-flush{padding:0;}',
      '.ov-wrap{position:absolute;inset:0;}',
      '.ov-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}',
      '.ov-fallback{background:radial-gradient(80rem 80rem at 30% 20%,rgba(255,255,255,0.12),transparent 60%),linear-gradient(160deg,#15151c,#08080c);}',
      '.ov-shade{position:absolute;inset:0;}',
      '.ov-shade.ov-bottom{background:linear-gradient(180deg,rgba(5,6,10,0.04) 30%,rgba(5,6,10,0.62) 68%,rgba(5,6,10,0.88) 100%);}',
      '.ov-shade.ov-top{background:linear-gradient(0deg,rgba(5,6,10,0.04) 30%,rgba(5,6,10,0.62) 68%,rgba(5,6,10,0.88) 100%);}',
      '.ov-shade.ov-center{background:radial-gradient(closest-side at 50% 50%,rgba(5,6,10,0.74),rgba(5,6,10,0.28) 75%,rgba(5,6,10,0.1));}',
      '.ov-content{position:absolute;left:0;right:0;display:flex;flex-direction:column;gap:30px;padding:90px;color:#fff;}',
      '.ov-content.ov-bottom{bottom:0;}',
      '.ov-content.ov-top{top:0;}',
      '.ov-content.ov-center{top:50%;transform:translateY(-50%);align-items:center;text-align:center;}',
      '.ov-content.center{align-items:center;text-align:center;}',
      '.ov-content .ad-badge{align-self:flex-start;}',
      '.ov-content.ov-center .ad-badge,.ov-content.center .ad-badge{align-self:center;}',
      '.ov-content .ad-cta{align-self:flex-start;}',
      '.ov-content.ov-center .ad-cta,.ov-content.center .ad-cta{align-self:center;}',
      '.ov-content .ad-subtext{color:rgba(255,255,255,0.86);}',
      // rich-density mini feature strip
      '.ad-minilist{display:flex;flex-wrap:wrap;gap:14px 26px;}',
      '.ad-minilist-item{display:inline-flex;align-items:center;gap:12px;font-size:27px;color:var(--ad-muted);}',
      '.ad-minilist-item i{font-style:normal;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;background:var(--ad-accent);color:var(--ad-on-accent);font-size:18px;font-weight:800;}',
      '.ad-stack.center .ad-minilist{justify-content:center;}'
    ].join('');
  }

  Ads.templates = {
    FORMATS: FORMATS, BACKGROUNDS: BACKGROUNDS, FONTS: FONTS, LIST: LIST,
    bgById: bgById, tplById: tplById,
    renderHTML: renderHTML, adCSS: adCSS
  };
})();
