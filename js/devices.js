/* ============================================================================
   ADS HUB — platform previews
   Renders an ad the way it actually appears in-feed on each platform
   (Facebook, Instagram, Twitter/X, TikTok) inside a phone / tablet / laptop
   frame. The creative slot holds either a static image (post) or the motion
   video (video ad). Exposes window.Ads.devices.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var util = Ads.util, render = Ads.render;
  var esc = util.escapeHtml;

  var VIEWS = [
    { id: 'plain', label: 'Ads only' },
    { id: 'phone', label: 'Phone' },
    { id: 'tablet', label: 'Tablet' },
    { id: 'desktop', label: 'Laptop' }
  ];
  var PLATFORMS = [
    { id: 'facebook', label: 'Facebook' },
    { id: 'instagram', label: 'Instagram' },
    { id: 'twitter', label: 'Twitter / X' },
    { id: 'tiktok', label: 'TikTok / Reels' }
  ];

  function svg(p, vb) { return '<svg viewBox="' + (vb || '0 0 24 24') + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
  var ICONS = {
    like: svg('<path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3zm0 0l3.5-6.5a1.8 1.8 0 0 1 3.4 1L13 10h5.5a2 2 0 0 1 2 2.4l-1.1 5.6a2.5 2.5 0 0 1-2.4 2H7"/>'),
    comment: svg('<path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.7A8 8 0 1 1 21 12z"/>'),
    share: svg('<path d="M14 5l7 7-7 7v-4.2C7 14.8 4.5 17.4 3 20c0-6 3-10.6 11-11V5z"/>'),
    dots: svg('<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
    globe: svg('<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/>'),
    heart: svg('<path d="M12 20s-7-4.3-9.5-8.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 9.5 5.5C19 15.7 12 20 12 20z"/>'),
    igcomment: svg('<path d="M21 11.5a8 8 0 0 1-11.5 7.2L4 20l1.3-4.5A8 8 0 1 1 21 11.5z"/>'),
    send: svg('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>'),
    bookmark: svg('<path d="M6 3h12v18l-6-4-6 4z"/>'),
    reply: svg('<path d="M21 11.5a8 8 0 0 1-11.5 7.2L4 20l1.3-4.5A8 8 0 1 1 21 11.5z"/>'),
    retweet: svg('<path d="M17 3l3 3-3 3"/><path d="M20 6H8a3 3 0 0 0-3 3v2"/><path d="M7 21l-3-3 3-3"/><path d="M4 18h12a3 3 0 0 0 3-3v-2"/>'),
    plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    music: svg('<circle cx="8" cy="18" r="3"/><path d="M11 18V4l8-2v12"/><circle cx="16" cy="14" r="3"/>')
  };

  function truncate(s, n) {
    s = String(s || '');
    if (s.length <= n) return esc(s);
    return esc(s.slice(0, n).replace(/\s+\S*$/, '')) + '… <span class="fbp-more">See more</span>';
  }
  function domainOf(opts, spec) {
    if (opts && opts.domain) return opts.domain;
    return ((spec.brand || 'example') + '.com').replace(/\s+/g, '').toLowerCase();
  }
  function handleOf(spec) { return (spec.brand || 'yourbrand').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function headlineOf(spec) { return ((spec.headlineStart || '') + ' ' + (spec.headlineHighlight || '')).trim() || spec.name || 'Your headline'; }
  function avatarOf(spec, cls) {
    var name = spec.brand || 'Your Page';
    return spec.logo
      ? '<img class="' + cls + '" src="' + spec.logo + '" alt="">'
      : '<div class="' + cls + ' is-letter" style="background:' + esc(spec.accent || '#555') + '">' + esc(String(name).slice(0, 1).toUpperCase()) + '</div>';
  }

  /* ---- Facebook feed post ------------------------------------------------ */
  function fbPost(spec, opts) {
    var name = spec.brand || 'Your Page', caption = spec.caption || '', desc = spec.description || '';
    return '<div class="fbp">' +
      '<div class="fbp-head">' + avatarOf(spec, 'fbp-avatar') +
        '<div class="fbp-id"><span class="fbp-name">' + esc(name) + '</span>' +
        '<span class="fbp-sub">Sponsored · <i class="fbp-globe">' + ICONS.globe + '</i></span></div>' +
        '<span class="fbp-dots">' + ICONS.dots + '</span></div>' +
      (caption ? '<div class="fbp-caption">' + truncate(caption, 125) + '</div>' : '') +
      '<div class="fbp-creative" data-ad-slot></div>' +
      '<div class="fbp-link"><div class="fbp-link-main">' +
        '<span class="fbp-domain">' + esc(domainOf(opts, spec).toUpperCase()) + '</span>' +
        '<span class="fbp-headline">' + esc(headlineOf(spec).slice(0, 58)) + '</span>' +
        (desc ? '<span class="fbp-desc">' + esc(desc.slice(0, 40)) + '</span>' : '') +
      '</div><button class="fbp-cta" type="button" tabindex="-1">' + esc(spec.cta || 'Learn more') + '</button></div>' +
      '<div class="fbp-actions"><span>' + ICONS.like + 'Like</span><span>' + ICONS.comment + 'Comment</span><span>' + ICONS.share + 'Share</span></div>' +
    '</div>';
  }

  /* ---- Instagram feed post ---------------------------------------------- */
  function igPost(spec, opts) {
    var handle = handleOf(spec), caption = spec.caption || '';
    return '<div class="igp">' +
      '<div class="igp-head">' + avatarOf(spec, 'igp-avatar') +
        '<div class="igp-id"><span class="igp-name">' + esc(handle) + '</span><span class="igp-sub">Sponsored</span></div>' +
        '<span class="igp-dots">' + ICONS.dots + '</span></div>' +
      '<div class="igp-creative" data-ad-slot></div>' +
      '<div class="igp-cta"><span>' + esc(spec.cta || 'Learn more') + '</span><span class="igp-chev">›</span></div>' +
      '<div class="igp-actions"><span class="igp-left">' + ICONS.heart + ICONS.igcomment + ICONS.send + '</span><span class="igp-save">' + ICONS.bookmark + '</span></div>' +
      (caption ? '<div class="igp-caption"><b>' + esc(handle) + '</b> ' + truncate(caption, 100) + '</div>' : '') +
    '</div>';
  }

  /* ---- Twitter / X post -------------------------------------------------- */
  function xPost(spec, opts) {
    var name = spec.brand || 'Your Brand', handle = handleOf(spec), caption = spec.caption || '';
    return '<div class="xp">' +
      '<div class="xp-head">' + avatarOf(spec, 'xp-avatar') +
        '<div class="xp-id"><span class="xp-name">' + esc(name) + '</span><span class="xp-handle">@' + esc(handle) + ' · Promoted</span></div>' +
        '<span class="xp-dots">' + ICONS.dots + '</span></div>' +
      (caption ? '<div class="xp-text">' + truncate(caption, 180) + '</div>' : '') +
      '<div class="xp-creative" data-ad-slot></div>' +
      '<div class="xp-card"><span class="xp-domain">' + esc(domainOf(opts, spec)) + '</span>' +
        '<span class="xp-headline">' + esc(headlineOf(spec).slice(0, 60)) + '</span></div>' +
      '<div class="xp-actions"><span>' + ICONS.reply + '</span><span>' + ICONS.retweet + '</span><span>' + ICONS.heart + '</span><span class="xp-cta">' + esc(spec.cta || 'Learn more') + '</span></div>' +
    '</div>';
  }

  /* ---- TikTok / Reels full-screen --------------------------------------- */
  function tiktokPost(spec, opts) {
    var handle = handleOf(spec), caption = spec.caption || '';
    return '<div class="ttp">' +
      '<div class="ttp-creative" data-ad-slot></div>' +
      '<div class="ttp-top"><span>Following</span><span class="is-active">For You</span></div>' +
      '<div class="ttp-rail">' +
        '<span class="ttp-av">' + avatarOf(spec, 'ttp-avatar') + '<i class="ttp-plus">' + ICONS.plus + '</i></span>' +
        '<span class="ttp-icon">' + ICONS.heart + '<em>12.4k</em></span>' +
        '<span class="ttp-icon">' + ICONS.igcomment + '<em>318</em></span>' +
        '<span class="ttp-icon">' + ICONS.send + '<em>Share</em></span>' +
        '<span class="ttp-disc">' + ICONS.music + '</span>' +
      '</div>' +
      '<div class="ttp-bottom">' +
        '<div class="ttp-user">@' + esc(handle) + ' · <span class="ttp-sponsored">Sponsored</span></div>' +
        (caption ? '<div class="ttp-cap">' + truncate(caption, 90) + '</div>' : '') +
        '<div class="ttp-cta">' + esc(spec.cta || 'Learn more') + ' <span class="igp-chev">›</span></div>' +
      '</div>' +
    '</div>';
  }

  var POSTS = { facebook: fbPost, instagram: igPost, twitter: xPost, tiktok: tiktokPost };
  var FEEDBAR = { facebook: 'facebook', instagram: 'Instagram', twitter: '𝕏', tiktok: '' };

  /* ---- Plain (no device, no platform chrome): creative + caption ---------- */
  function plainAd(spec) {
    var caption = spec.caption || '';
    return '<div class="plain-ad">' +
      '<div class="plain-creative" data-ad-slot></div>' +
      (caption ? '<div class="plain-caption">' + esc(caption) + '</div>' : '') +
    '</div>';
  }

  /* ---- Frames ------------------------------------------------------------ */
  function shell(view, platform, spec, opts) {
    if (view === 'plain') return plainAd(spec);
    platform = POSTS[platform] ? platform : 'facebook';
    var post = POSTS[platform](spec, opts);

    // TikTok / Reels is always a full-bleed phone
    if (platform === 'tiktok') {
      return '<div class="dev dev--phone dev--full"><div class="dev-notch"></div>' +
        '<div class="dev-screen dev-screen--full">' + post + '</div></div>';
    }

    var bar = FEEDBAR[platform] ? '<div class="dev-feedbar plat--' + platform + '">' + FEEDBAR[platform] + '</div>' : '';
    if (view === 'tablet') {
      return '<div class="dev dev--tablet"><div class="dev-screen">' + bar + '<div class="dev-feed">' + post + '</div></div></div>';
    }
    if (view === 'desktop') {
      return '<div class="dev dev--laptop"><div class="dev-screen"><div class="dev-browser"><span class="db-dot"></span><span class="db-dot"></span><span class="db-dot"></span><span class="db-url">' + esc(platform === 'twitter' ? 'x.com' : platform + '.com') + '</span></div>' +
        '<div class="dev-page"><div class="dev-feed">' + post + '</div></div></div><div class="dev-base"></div></div>';
    }
    return '<div class="dev dev--phone"><div class="dev-notch"></div><div class="dev-screen">' + bar + '<div class="dev-feed">' + post + '</div></div></div>';
  }

  // Mount the creative into the slot. Returns a controller ({stop, poster}) for
  // video creatives, or null for static. opts.animate → play video loop.
  function mountCreative(rootEl, spec, opts) {
    var slot = rootEl.querySelector('[data-ad-slot]');
    if (!slot) return null;
    if (spec.kind === 'video' && Ads.video) {
      return Ads.video.mount(slot, spec, !!(opts && opts.animate));
    }
    // clientWidth can be a few px mid-layout (e.g. the DAM iframe still
    // settling when the app renders) — a truthy-but-tiny width used to
    // produce a scale(~0.003) creative that looked like "text but no visual"
    var w = slot.clientWidth;
    if (!w || w < 40) w = 250;
    render.thumb(slot, spec, w, null);
    return null;
  }

  Ads.devices = { VIEWS: VIEWS, PLATFORMS: PLATFORMS, shell: shell, mountCreative: mountCreative };
})();
