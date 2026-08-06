/* ============================================================================
   ADS HUB — AI copy client
   Thin wrapper over the server's /api/ai endpoints. Degrades gracefully when no
   ANTHROPIC_API_KEY is configured. Exposes window.Ads.ai.
   ========================================================================== */
window.Ads = window.Ads || {};

(function () {
  'use strict';
  var statusCache = null;

  function status(force) {
    if (statusCache && !force) return Promise.resolve(statusCache);
    return fetch('/api/ai/status').then(function (r) { return r.json(); })
      .then(function (s) { statusCache = s; return s; })
      .catch(function () { statusCache = { enabled: false, model: null, offline: true }; return statusCache; });
  }

  // Hand the local server an API key — saved on this machine so it survives
  // restarts. Empty string clears (and forgets) it.
  function setKey(key) {
    return fetch('/api/ai/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ key: key })
    }).then(function (r) {
      return r.json().then(function (b) {
        if (!r.ok) throw new Error(b && b.message ? b.message : 'Could not set the key');
        statusCache = null;
        return b;
      });
    });
  }

  // Resolves to an array of copy variations, or rejects with a friendly Error.
  function generateCopy(opts) {
    return fetch('/api/ai/copy', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({
        brief: opts.brief, count: opts.count || 6, tone: opts.tone,
        format: opts.format, brand: opts.brand, preferences: opts.preferences,
        frames: opts.frames || [],  // still frames from an uploaded video → Claude vision
        batch: opts.batch || null   // {i,n} when this is one of several batches for the same product
      })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.message ? body.message : ('AI request failed (' + r.status + ')'));
        return body.variations || [];
      });
    });
  }

  // Deep-read all project material → structured dossier object.
  function generateDossier(opts) {
    return fetch('/api/ai/dossier', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({
        site: opts.site, files: opts.files, notes: opts.notes,
        images: opts.images || [], videos: opts.videos || [], brand: opts.brand
      })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.message ? body.message : ('Analysis failed (' + r.status + ')'));
        return body.dossier;
      });
    });
  }

  // Deep market research on a topic → { research: {topic, summary, painPoints[]}, webSearch }.
  function research(opts) {
    return fetch('/api/ai/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ topic: opts.topic, context: opts.context, count: opts.count })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.message ? body.message : ('Research failed (' + r.status + ')'));
        return { research: body.research, webSearch: !!body.webSearch };
      });
    });
  }

  // Landing copy: per-page openings ({subhead, story}) and — when opts.about
  // is true — the shared long-form about body every page carries.
  // Resolves { pages:[{subhead,story}], about:{sections:[...],closer:{...}}|null }.
  function landingContent(opts) {
    return fetch('/api/ai/landing', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ pages: opts.pages, context: opts.context, brand: opts.brand || '', voice: opts.voice || '', about: !!opts.about })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.message ? body.message : ('Landing copy failed (' + r.status + ')'));
        return { pages: body.pages || [], about: body.about || null };
      });
    });
  }

  // Apply a natural-language edit to an ad spec → { changes, note }.
  function editSpec(opts) {
    return fetch('/api/ai/edit', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ instruction: opts.instruction, spec: opts.spec, brand: opts.brand })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.message ? body.message : ('Edit failed (' + r.status + ')'));
        return body;
      });
    });
  }

  // Read a website → structured data (title, copy, brand colour, logo, OG image).
  function scrape(url) {
    return fetch('/api/scrape', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ url: url })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.message ? body.message : ('Could not read that site (' + r.status + ')'));
        return body;
      });
    });
  }

  // Map an AI variation onto a partial ad spec (the generator merges it in).
  function variationToSpec(v) {
    var out = {
      badge: v.badge || '',
      headlineStart: v.headlineStart || '',
      headlineHighlight: v.headlineHighlight || '',
      subtext: v.subtext || '',
      boldPhrases: Array.isArray(v.boldPhrases) ? v.boldPhrases : (v.boldPhrases ? [v.boldPhrases] : []),
      cta: v.cta || '',
      caption: v.caption || '',
      description: v.description || '',
      angle: v.angle || '',
      source: v.source === 'verbatim' ? 'verbatim' : 'original'   // who wrote the headline
    };
    if (v.stat && v.stat.value) out.stat = { value: String(v.stat.value), label: String(v.stat.label || '') };
    if (v.quote && v.quote.text) out.quote = { text: String(v.quote.text), author: String(v.quote.author || ''), role: String(v.quote.role || '') };
    return out;
  }

  // Deep audience analysis: everything the project knows + live web research →
  // { audience: {summary, primary, segments, targeting, avoid}, webSearch }.
  // A LONG call — several minutes when web search digs in.
  function audience(opts) {
    return fetch('/api/ai/audience', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ context: opts.context, brand: opts.brand || '' })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.message ? body.message : ('Audience analysis failed (' + r.status + ')'));
        return { audience: body.audience, webSearch: !!body.webSearch };
      });
    });
  }

  // Media plan: budget + platforms + the round's ads + the audience analysis →
  // a concrete spend plan. Resolves { plan }.
  function mediaPlan(opts) {
    return fetch('/api/ai/mediaplan', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ context: opts.context })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.message ? body.message : ('Planning failed (' + r.status + ')'));
        return body.plan;
      });
    });
  }

  // Art-director image concepts: Claude studies the project + reference images
  // and returns N { label, prompt, why } ideas for ad visuals.
  function imageConcepts(opts) {
    return fetch('/api/ai/imageprompts', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ context: opts.context || '', images: opts.images || [], count: opts.count || 6, brand: opts.brand || {} })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.message ? body.message : ('Image concepts failed (' + r.status + ')'));
        return body.images || [];
      });
    });
  }

  // Nano Banana (Gemini) image generation: render ONE image from a concept
  // prompt (+ reference images so it matches the brand's world). Rejects with
  // err.noKey === true when no Gemini key is configured (client falls back).
  function genImage(opts) {
    return fetch('/api/ai/genimage', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ prompt: opts.prompt, images: opts.images || [] })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (r.status === 501) { var e = new Error(body && body.message || 'No image key'); e.noKey = true; throw e; }
        if (!r.ok) throw new Error(body && body.message ? body.message : ('Image generation failed (' + r.status + ')'));
        return body.dataURL;
      });
    });
  }
  // Batch render: ONE request carries every prompt; the server fires ALL the
  // Nano Banana calls in parallel and streams each image back the moment it's
  // ready (NDJSON lines). opts.onOne({i, ok, dataURL|error}) fires per image;
  // resolves to the full results array (indexed like opts.prompts).
  function genImages(opts) {
    return fetch('/api/ai/genimages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ prompts: opts.prompts || [] })
    }).then(function (r) {
      if (r.status === 501) return r.json().then(function (b) { var e = new Error(b && b.message || 'No image key'); e.noKey = true; throw e; });
      if (!r.ok) return r.json().then(
        function (b) { throw new Error(b && b.message ? b.message : ('Image generation failed (' + r.status + ')')); },
        function () { throw new Error('Image generation failed (' + r.status + ')'); });
      var results = new Array((opts.prompts || []).length);
      function handle(line) {
        line = line.trim(); if (!line) return;
        try { var d = JSON.parse(line); results[d.i] = d; if (opts.onOne) opts.onOne(d); } catch (e) {}
      }
      if (!(r.body && r.body.getReader)) {   // no streaming support → parse when complete
        return r.text().then(function (t) { t.split('\n').forEach(handle); return results; });
      }
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (step) {
          if (step.done) { handle(buf); return results; }
          buf += dec.decode(step.value, { stream: true });
          var nl; while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
          return pump();
        });
      }
      return pump();
    });
  }
  // Animate an AI image into real footage via Veo — long call (30s–5min).
  // Resolves { url } — a durable /pfiles project URL for the mp4.
  function genClip(opts) {
    return fetch('/api/ai/genclip', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' },
      body: JSON.stringify({ project: opts.project, prompt: opts.prompt || '', image: opts.image })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (r.status === 501) { var e = new Error(body && body.message || 'No Gemini key'); e.noKey = true; throw e; }
        if (!r.ok) throw new Error(body && body.message ? body.message : ('Clip generation failed (' + r.status + ')'));
        return body;
      });
    });
  }
  function geminiStatus() {
    return fetch('/api/gemini/status').then(function (r) { return r.json(); }).catch(function () { return { enabled: false }; });
  }
  function setGeminiKey(key) {
    return fetch('/api/gemini/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' }, body: JSON.stringify({ key: key }) })
      .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b && b.message || 'Key error'); return b; }); });
  }
  // Re-check the saved key against Google (free) → { enabled, ok, error }.
  function geminiVerify() {
    return fetch('/api/gemini/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ads-Hub': '1' } })
      .then(function (r) { return r.json(); }).catch(function () { return { enabled: true, ok: false, error: 'Could not reach the key checker' }; });
  }

  Ads.ai = { status: status, setKey: setKey, generateCopy: generateCopy, generateDossier: generateDossier, research: research, audience: audience, landingContent: landingContent, imageConcepts: imageConcepts, genImage: genImage, genImages: genImages, genClip: genClip, geminiStatus: geminiStatus, setGeminiKey: setGeminiKey, geminiVerify: geminiVerify, mediaPlan: mediaPlan, variationToSpec: variationToSpec, scrape: scrape, editSpec: editSpec };
})();
