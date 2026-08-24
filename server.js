/* ============================================================================
   ADS HUB — zero-dependency Node server
   - Serves the static SPA from ads-hub/ on PORT (default 3003)
   - POST /api/ai/copy   → proxies to the Anthropic Messages API (Claude) to
                           generate Meta ad copy variations. Needs ANTHROPIC_API_KEY.
   - GET  /api/ai/status → reports whether AI is configured (+ which model)
   - GET  /api/store     → returns the persisted data snapshot (data/store.json)
   - PUT  /api/store      → writes the data snapshot to disk (durable backup)

   Start (PowerShell):
     $env:ANTHROPIC_API_KEY="sk-ant-..."; $env:PORT="3003"; node ads-hub/server.js
   Start (bash):
     ANTHROPIC_API_KEY=sk-ant-... PORT=3003 node ads-hub/server.js

   AI is optional — without a key the app is fully usable (manual copy, templates,
   bulk, rendering, performance). The AI buttons just report that a key is needed.
   ========================================================================== */
'use strict';

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var url = require('url');
var zlib = require('zlib');
var crypto = require('crypto');

var ROOT = __dirname;
var PORT = parseInt(process.env.PORT, 10) || 3003;
var API_KEY = process.env.ANTHROPIC_API_KEY || '';
// The key entered in the UI is saved to a local file (git-ignored, this
// machine only) so it survives restarts. ANTHROPIC_API_KEY always wins.
var KEY_FILE = path.join(__dirname, 'data', 'secret.key');
var runtimeKey = '';
var keyPersisted = false;
if (!API_KEY) {
  try {
    var savedKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (savedKey) { runtimeKey = savedKey; keyPersisted = true; }
  } catch (e) { /* no saved key */ }
}
function effectiveKey() { return API_KEY || runtimeKey; }
function keySource() { return API_KEY ? 'env' : (runtimeKey ? (keyPersisted ? 'saved' : 'session') : 'none'); }
var MODEL = process.env.ADS_AI_MODEL || 'claude-opus-4-8';

// --- Nano Banana (Google Gemini) image generation key — separate, same pattern ---
var GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
var GEMINI_KEY_FILE = path.join(__dirname, 'data', 'gemini.key');
var geminiRuntimeKey = '';
var geminiKeyPersisted = false;
if (!GEMINI_API_KEY) {
  try { var gk = fs.readFileSync(GEMINI_KEY_FILE, 'utf8').trim(); if (gk) { geminiRuntimeKey = gk; geminiKeyPersisted = true; } } catch (e) {}
}
function effectiveGeminiKey() { return GEMINI_API_KEY || geminiRuntimeKey; }
function geminiKeySource() { return GEMINI_API_KEY ? 'env' : (geminiRuntimeKey ? (geminiKeyPersisted ? 'saved' : 'session') : 'none'); }
// Last known real failure from Google (e.g. a blocked/restricted key) so the UI
// can show WHY images fell back to placeholders instead of failing silently.
var geminiLastError = '';
var GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
var GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';
var STORE_FILE = path.join(ROOT, 'data', 'store.json');

// --- Instagram direct posting (Instagram API with Instagram Login) ----------
// The token is an Instagram User access token from the user's Meta developer
// app ("API setup with Instagram business login"). Long-lived (60 days) and
// auto-refreshed below. No Facebook Page or Business Manager involved.
var IG_ENV_TOKEN = process.env.IG_ACCESS_TOKEN || '';
var IG_TOKEN_FILE = path.join(__dirname, 'data', 'meta.key');
var igRuntimeToken = '';
var igTokenPersisted = false;
if (!IG_ENV_TOKEN) {
  try { var _igt = fs.readFileSync(IG_TOKEN_FILE, 'utf8').trim(); if (_igt) { igRuntimeToken = _igt; igTokenPersisted = true; } } catch (e) {}
}
function effectiveIgToken() {
  if (IG_ENV_TOKEN) return IG_ENV_TOKEN;
  // two instances share this file (docker + host tunnel) — if the OTHER one
  // saved the token, pick it up lazily instead of waiting for a restart
  if (!igRuntimeToken) {
    try { var t = fs.readFileSync(IG_TOKEN_FILE, 'utf8').trim(); if (t) { igRuntimeToken = t; igTokenPersisted = true; } } catch (e) {}
  }
  return igRuntimeToken;
}
function igTokenSource() { return IG_ENV_TOKEN ? 'env' : (igRuntimeToken ? (igTokenPersisted ? 'saved' : 'session') : 'none'); }
var igLastError = '';
var igUser = null;                 // { id, username } from the last verify
var IG_GRAPH_HOST = 'graph.instagram.com';
var IG_API_VERSION = process.env.IG_API_VERSION || 'v26.0';
// Meta's servers fetch staged media from here; must be publicly reachable
var PUBLIC_BASE = (process.env.ADS_PUBLIC_BASE || 'https://sm.partisans.ca').replace(/\/+$/, '');
var PUB_DIR = path.join(ROOT, 'data', 'pub');
// in-flight/finished publish jobs, keyed by the client's idempotency id
// (adKey+round) so retries can never double-post. Swept hourly below.
var igJobs = {};

// --- Meta Marketing API (DARK ADS) — separate System User token -------------
// Paid, targeted ads that never appear on the profile. Independent of the
// organic Instagram connection above; everything is created PAUSED so money
// can only start moving when the user activates ads in Ads Manager.
var MADS_ENV_TOKEN = process.env.META_ADS_TOKEN || '';
var MADS_TOKEN_FILE = path.join(__dirname, 'data', 'meta-ads.key');
var MADS_CONF_FILE = path.join(__dirname, 'data', 'meta-ads.json');
var madsRuntimeToken = '';
var madsTokenPersisted = false;
if (!MADS_ENV_TOKEN) {
  try { var _mt = fs.readFileSync(MADS_TOKEN_FILE, 'utf8').trim(); if (_mt) { madsRuntimeToken = _mt; madsTokenPersisted = true; } } catch (e) {}
}
function effectiveMadsToken() {
  if (MADS_ENV_TOKEN) return MADS_ENV_TOKEN;
  if (!madsRuntimeToken) {
    try { var t = fs.readFileSync(MADS_TOKEN_FILE, 'utf8').trim(); if (t) { madsRuntimeToken = t; madsTokenPersisted = true; } } catch (e) {}
  }
  return madsRuntimeToken;
}
function madsTokenSource() { return MADS_ENV_TOKEN ? 'env' : (madsRuntimeToken ? (madsTokenPersisted ? 'saved' : 'session') : 'none'); }
var madsLastError = '';
var madsConf = null;   // { adAccountId, adAccountName, currency, pageId, pageName, igUserId, igUsername, accounts[], pages[] }
try { madsConf = JSON.parse(fs.readFileSync(MADS_CONF_FILE, 'utf8')); } catch (e) {}
function saveMadsConf() {
  try { fs.mkdirSync(path.dirname(MADS_CONF_FILE), { recursive: true }); fs.writeFileSync(MADS_CONF_FILE, JSON.stringify(madsConf)); } catch (e) {}
}
var FB_GRAPH_HOST = 'graph.facebook.com';
// Durable ledger of every dark-ads run, keyed by round id. In-memory jobs die
// on restart/GC while the created Meta objects live on — this file is what
// prevents a retry from ever building a second identical campaign.
var MADS_RUNS_FILE = path.join(__dirname, 'data', 'mads-runs.json');
var madsRuns = {};
try { madsRuns = JSON.parse(fs.readFileSync(MADS_RUNS_FILE, 'utf8')) || {}; } catch (e) {}
function saveMadsRuns() {
  try { fs.mkdirSync(path.dirname(MADS_RUNS_FILE), { recursive: true }); fs.writeFileSync(MADS_RUNS_FILE, JSON.stringify(madsRuns)); } catch (e) {}
}
// Meta budgets are in the account currency's MINOR unit — offset 100 for
// USD/CAD/EUR etc, but 1 for zero-decimal currencies. Hardcoding ×100 would
// be a 100× overspend on a JPY/KRW/TWD… account.
var MADS_OFFSET_ONE = { CLP: 1, COP: 1, CRC: 1, HUF: 1, ISK: 1, IDR: 1, JPY: 1, KRW: 1, PYG: 1, TWD: 1, VND: 1 };

// A project "has content" when it holds real work (saved ads, landing pages,
// a dossier, generated images, or research). Used to guard against a wipe: a
// fresh/empty browser state must never overwrite projects full of work on disk.
function projectHasContent(p) {
  if (!p || typeof p !== 'object') return false;
  return (Array.isArray(p.savedAds) && p.savedAds.length > 0) ||
         (Array.isArray(p.landings) && p.landings.length > 0) ||
         (Array.isArray(p.genImages) && p.genImages.length > 0) ||
         (Array.isArray(p.results) && p.results.length > 0) ||
         (p.research && Array.isArray(p.research.painPoints) && p.research.painPoints.length > 0) ||
         !!p.dossier;
}
function storeContentIds(store) {
  var out = {};
  var ps = (store && Array.isArray(store.projects)) ? store.projects : [];
  ps.forEach(function (p) { if (projectHasContent(p)) out[p.id || ('#' + ps.indexOf(p))] = true; });
  return out;
}
// Keep only the newest N rescue snapshots so blocked-wipe backups can't pile up.
function pruneRescues(keep) {
  try {
    var dir = path.dirname(STORE_FILE), base = path.basename(STORE_FILE) + '.rescue-';
    var files = fs.readdirSync(dir).filter(function (f) { return f.indexOf(base) === 0; }).sort();
    while (files.length > keep) { try { fs.rmSync(path.join(dir, files.shift()), { force: true }); } catch (e) {} }
  } catch (e) {}
}

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json'
};

function send(res, status, body, headers) {
  headers = headers || {};
  res.writeHead(status, headers);
  res.end(body);
}
function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

// decodeURIComponent throws URIError on malformed escapes ("%zz") — never let
// a stray URL take the process down
function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return null; } }

// Cross-site POSTs are "simple requests" browsers happily send from any page;
// requiring this custom header forces a CORS preflight no foreign origin can
// pass, so only our own app can hit state-changing endpoints.
function requireAppHeader(req, res) {
  if (req.headers['x-ads-hub']) return true;
  sendJSON(res, 403, { error: 'forbidden', message: 'Missing app header' });
  return false;
}

function readBody(req, cb, maxBytes) {
  var chunks = [];
  var size = 0;
  var cap = maxBytes || 25 * 1024 * 1024;
  var over = false;
  req.on('data', function (c) {
    if (over) return;
    size += c.length;
    if (size > cap) { over = true; chunks = []; return; }
    chunks.push(c);
  });
  req.on('end', function () {
    if (over) return cb(null, size);         // caller must answer with a 413
    cb(Buffer.concat(chunks).toString('utf8'));
  });
}

/* ---- Static files -------------------------------------------------------- */
function serveStatic(req, res, pathname) {
  var rel = safeDecode(pathname);
  if (rel == null) return send(res, 400, 'Bad request');
  if (rel === '/' || rel === '') rel = '/index.html';
  // prevent path traversal (compare against ROOT + separator so a sibling
  // directory like ads-hub-backup can never prefix-match)
  var filePath = path.normalize(path.join(ROOT, rel));
  if (filePath !== ROOT && filePath.indexOf(ROOT + path.sep) !== 0) { send(res, 403, 'Forbidden'); return; }
  // secrets and user data are never static assets: data/ holds the API keys,
  // the Instagram token and store.json; .git would leak the repo. Anything in
  // there is reachable only via its dedicated route (/pub/, /pfiles/, APIs).
  var relNorm = filePath.slice(ROOT.length).replace(/\\/g, '/');
  if (/^\/(data|\.git)(\/|$)/.test(relNorm) || /\.key$/i.test(relNorm)) { send(res, 404, 'Not found'); return; }

  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      // SPA fallback for unknown non-asset routes
      if (rel.indexOf('/api/') !== 0 && rel.indexOf('.') === -1) {
        return fs.readFile(path.join(ROOT, 'index.html'), function (e2, buf) {
          if (e2) return send(res, 404, 'Not found');
          send(res, 200, buf, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        });
      }
      return send(res, 404, 'Not found');
    }
    var ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, function (e3, buf) {
      if (e3) return send(res, 500, 'Read error');
      // app code (html/js/css) must never be served stale — no-store forces a
      // fresh fetch every load so an updated tool is picked up on reload
      var noStore = ext === '.html' || ext === '.js' || ext === '.css';
      send(res, 200, buf, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': noStore ? 'no-store' : 'no-cache' });
    });
  });
}

/* ---- Project file storage ------------------------------------------------ */
var PROJECTS_DIR = path.join(ROOT, 'data', 'projects');
// one path segment, no traversal: keep [a-zA-Z0-9._-], cap length
function safeSeg(s) { return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120); }

// Serve a stored project file with Range support (video seeking needs 206s).
function serveProjectFile(req, res, pid, name) {
  return serveFileRange(req, res, path.join(PROJECTS_DIR, safeSeg(pid), 'files', safeSeg(name)));
}
function serveFileRange(req, res, fp) {
  fs.stat(fp, function (err, stat) {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');
    var type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
    var m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      var start = m[1] ? parseInt(m[1], 10) : Math.max(0, stat.size - parseInt(m[2], 10));
      var end = (m[1] && m[2]) ? parseInt(m[2], 10) : stat.size - 1;
      if (isNaN(start) || isNaN(end) || start > end || start >= stat.size) {
        return send(res, 416, '', { 'Content-Range': 'bytes */' + stat.size });
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
        'Content-Length': end - start + 1
      });
      return fs.createReadStream(fp, { start: start, end: end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    fs.createReadStream(fp).pipe(res);
  });
}

/* ---- Anthropic proxy ----------------------------------------------------- */
function callAnthropic(payload, cb, timeoutMs) {
  var data = JSON.stringify(payload);
  var options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': effectiveKey(),
      'anthropic-version': '2023-06-01',
      'content-length': Buffer.byteLength(data)
    }
  };
  // Transient API failures (529 overloaded, 429 rate-limit, 5xx blips, dropped
  // sockets) retry automatically with backoff — the user should never see
  // "Overloaded" for a condition that clears in seconds. Deadline timeouts do
  // NOT retry: they'd double an already-long wait.
  var attempt = 0, MAX_ATTEMPTS = 4, BACKOFF = [2000, 5000, 11000];
  function retryable(status) { return status === 529 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504; }
  function once() {
    attempt++;
    var r = https.request(options, function (resp) {
      var body = '';
      resp.on('data', function (c) { body += c; });
      resp.on('end', function () {
        if (retryable(resp.statusCode) && attempt < MAX_ATTEMPTS) {
          var wait = BACKOFF[attempt - 1] || 11000;
          var ra = parseInt(resp.headers['retry-after'], 10);
          if (resp.statusCode === 429 && ra > 0 && ra <= 60) wait = ra * 1000;
          console.log('[ads-hub] Anthropic ' + resp.statusCode + ' — retrying in ' + Math.round(wait / 1000) + 's (attempt ' + attempt + '/' + (MAX_ATTEMPTS - 1) + ')');
          return setTimeout(once, wait);
        }
        cb(null, resp.statusCode, body);
      });
    });
    // a stalled upstream must surface as an error, not hang the client forever.
    // Non-streaming calls send nothing until done, so this is a per-call deadline;
    // web-search research turns run long and pass a bigger budget.
    r.setTimeout(timeoutMs || 180000, function () { r.destroy(new Error('Anthropic API timed out')); });
    r.on('error', function (e) {
      if (attempt < MAX_ATTEMPTS && !/timed out/i.test(String(e.message))) {
        var wait = BACKOFF[attempt - 1] || 11000;
        console.log('[ads-hub] Anthropic connection error (' + e.message + ') — retrying in ' + Math.round(wait / 1000) + 's');
        return setTimeout(once, wait);
      }
      cb(e);
    });
    r.write(data);
    r.end();
  }
  once();
}

// Build the prompt that asks Claude for structured Meta ad copy variations.
function buildCopyRequest(input) {
  var brief = String(input.brief || '').slice(0, 30000);  // dossier + full research (20+ pain points) must fit — the model has ample context
  var count = Math.max(1, Math.min(20, parseInt(input.count, 10) || 6));
  var brand = input.brand || {};
  var tone = input.tone || 'confident, punchy, benefit-led';
  var format = input.format || 'square';
  var product = brand.name ? ('Brand/product: ' + brand.name + '. ') : '';
  var voice = brand.voice ? ('Brand voice: ' + brand.voice + '. ') : '';

  // Learned preferences: examples the advertiser previously liked / disliked.
  function prefBlock(pref) {
    if (!pref || (!(pref.liked || []).length && !(pref.disliked || []).length)) return '';
    function fmt(arr) {
      return arr.slice(-8).map(function (s) {
        var h = (s.headline || '').trim();
        var a = s.angle ? (' [' + s.angle + ']') : '';
        return h ? ('- "' + h + '"' + a) : (s.angle ? ('- angle: ' + s.angle) : '');
      }).filter(Boolean).join('\n');
    }
    var liked = fmt(pref.liked || []), disliked = fmt(pref.disliked || []);
    var out = '\nLEARNED PREFERENCES — the advertiser reviewed past ads and reacted:\n';
    if (liked) out += 'LIKED (lean INTO this style, tone and angle; make more like these):\n' + liked + '\n';
    if (disliked) out += 'DISLIKED (AVOID these angles, phrasings and vibe):\n' + disliked + '\n';
    out += 'Prioritise the liked direction and steer clear of the disliked one while keeping every variation distinct.\n';
    return out;
  }
  var prefs = prefBlock(input.preferences);
  // When the advertiser wants many ads, the client splits the ask into several
  // batches for the SAME product — nudge each batch toward fresh angles so the
  // batches together read as one big, non-repeating set.
  var batch = input.batch;
  var batchHint = (batch && +batch.n > 1)
    ? '\nIMPORTANT: this is batch ' + (+batch.i) + ' of ' + (+batch.n) + ' being written for the SAME product. Take ENTIRELY FRESH angles, hooks and headline structures — assume the other batches already used the obvious ones. Reach for less-obvious pains, outcomes, identities and framings so all batches together read as one large, non-repeating set.\n'
    : '';

  var system =
    'You are a senior Meta (Facebook/Instagram) performance ad copywriter. ' +
    'You write scroll-stopping, conversion-focused static feed ads. Rules you always follow:\n' +
    '- Headlines are tagline-style, benefit-led, ACTIVE voice, <= 40 characters total ' +
    '(headlineStart <= 5 words, headlineHighlight <= 4 words). Numbers beat adjectives.\n' +
    '- caption = the Facebook PRIMARY TEXT shown above the creative. The hook must land in the ' +
    'first ~100 characters (a question, bold claim, pain-point or number). 1-3 short sentences, ' +
    '90-220 characters total, ending with a soft call-to-action. No hashtag spam (max 1), at most one emoji.\n' +
    '- description = the small line under the headline in the link card, <= 30 characters.\n' +
    '- subtext is one or two tight sentences for ON-IMAGE copy; keep it minimal (creatives with less text perform better).\n' +
    '- Every variation takes a DIFFERENT angle: pain-point, outcome, social proof, curiosity, ' +
    'question, statistic, objection-handling, urgency, comparison, identity ("for X people").\n' +
    '- VARIETY IS NON-NEGOTIABLE: no two variations may share a headline, opening words, hook ' +
    'structure or caption phrasing. If two drafts feel similar, rewrite one from a different angle.\n' +
    '- NEVER invent statistics, customer names or testimonials. Only include a "stat" or "quote" field ' +
    'if a real number or real quote appears in the brief.\n' +
    'You ONLY output valid JSON.';

  // Mix of copy sources: some ads quote the material's strongest real lines
  // as-is; most are freshly authored by the model from its understanding.
  var verbatimN = Math.max(1, Math.round(count / 3));
  var instruction =
    product + voice +
    'Write ' + count + ' distinct ad variations for this product. Tone: ' + tone + '. ' +
    'Creative format: ' + format + '. \n\n' +
    'Product brief:\n"""\n' + brief + '\n"""\n' +
    prefs + batchHint + '\n' +
    'COPY SOURCES — produce a MIX and label each variation:\n' +
    '- Exactly ' + verbatimN + ' variation(s) with "source":"verbatim": the headline is a REAL line taken ' +
    'word-for-word (or lightly trimmed) from the brief material — its single strongest hook, claim or ' +
    'promise. Pick lines that could stop a scroll; NEVER navigation labels, section headings or footer text. ' +
    'If the material has no strong quotable lines, use fewer verbatim variations.\n' +
    '- All other variations with "source":"original": copy written entirely by YOU in fresh language — ' +
    'grounded in the brief\'s facts but never copying its sentences. This is where you show your craft: ' +
    'sharp, specific, unexpected phrasings a human copywriter would be proud of.\n\n' +
    'Return ONLY a JSON object of the exact shape:\n' +
    '{"variations":[{' +
    '"source":"original" /* or "verbatim" */,' +
    '"angle":"short label for the marketing angle",' +
    '"badge":"tiny eyebrow / social-proof pill, <= 5 words, omit if nothing real to say",' +
    '"headlineStart":"first part of the headline",' +
    '"headlineHighlight":"the accented part of the headline",' +
    '"subtext":"1-2 short on-image sentences",' +
    '"boldPhrases":["phrases from subtext to embolden"],' +
    '"cta":"button label, <= 3 words",' +
    '"caption":"Facebook primary text, 90-220 chars, hook first",' +
    '"description":"link-card description, <= 30 chars",' +
    '"stat":{"value":"3.2x","label":"what it measures"} /* ONLY if grounded in the brief, else omit */,' +
    '"quote":{"text":"...","author":"...","role":"..."} /* ONLY if a real quote is in the brief, else omit */' +
    '}]}\n' +
    'No markdown, no commentary — JSON only.';

  // Vision: still frames extracted from an uploaded video. Claude "watches" the
  // footage and grounds the copy in what it actually sees.
  var frames = Array.isArray(input.frames) ? input.frames.slice(0, 4) : [];
  var imgBlocks = [];
  frames.forEach(function (f) {
    var m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(f || ''));
    if (m && m[2].length < 3500000) imgBlocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  });

  var content;
  if (imgBlocks.length) {
    var hasBrief = !!(brief && brief.trim());
    var visionNote =
      'The advertiser gave you a product VIDEO — below are ' + imgBlocks.length + ' representative still ' +
      'frames from it. Study them closely: identify the product or service, who it is for, the setting and ' +
      'mood, and any visible on-screen text or branding. Ground every ad in what you can actually SEE in ' +
      'these frames' + (hasBrief ? ', combined with the brief below.' : ' — there is no other brief, so the frames are your only source. Do not invent facts you cannot see.') + '\n\n';
    content = [{ type: 'text', text: visionNote + instruction }].concat(imgBlocks);
  } else {
    content = instruction;
  }

  return {
    model: MODEL,
    // up to 20 full copy objects — 4096 truncated the JSON mid-array and the
    // parse failed; the model stops on its own when the array is done
    max_tokens: 16384,
    system: system,
    messages: [{ role: 'user', content: content }]
  };
}

// Pull the model's text out of a Messages API response and parse the JSON.
function parseCopyResponse(body) {
  var json = JSON.parse(body);
  if (json.type === 'error') throw new Error((json.error && json.error.message) || 'API error');
  var text = '';
  (json.content || []).forEach(function (b) { if (b.type === 'text') text += b.text; });
  text = text.trim();
  // tolerate accidental ```json fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  var data = null;
  try { data = JSON.parse(text); }
  catch (e) {
    // truncated or trailing-prose response — salvage every COMPLETE variation
    // object rather than throwing the whole batch away
    var salvaged = salvageVariations(text);
    if (salvaged.length) return salvaged;
    if (json.stop_reason === 'max_tokens') throw new Error('The copy response was cut off (too long). Try fewer variations.');
    throw new Error('Could not parse the AI copy: ' + e.message);
  }
  return Array.isArray(data) ? data : (data.variations || []);
}
// Best-effort recovery: pull whole {...} objects out of a (possibly truncated)
// "variations" array so a cut-off last item never sinks the whole response.
function salvageVariations(text) {
  var start = text.indexOf('[');
  if (start < 0) return [];
  var out = [], depth = 0, objStart = -1, inStr = false, esc = false;
  for (var i = start; i < text.length; i++) {
    var c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) objStart = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && objStart >= 0) { try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch (e) {} objStart = -1; } }
  }
  return out;
}

/* ---- AI edit ("tell the AI what to change") ------------------------------ */
// Strip heavy/non-editable fields before sending the spec to the model.
function pruneSpecForEdit(s) {
  var keep = ['template', 'format', 'theme', 'font', 'background', 'accent', 'badge', 'headlineStart',
    'headlineHighlight', 'subtext', 'boldPhrases', 'cta', 'brand', 'captions', 'bullets', 'stat', 'quote', 'name',
    'caption', 'description', 'layout', 'density', 'align'];
  var o = {}; keep.forEach(function (k) { if (s && s[k] != null) o[k] = s[k]; }); return o;
}
function buildEditRequest(input) {
  var instruction = String(input.instruction || '').slice(0, 1200);
  var spec = pruneSpecForEdit(input.spec || {});
  var system =
    'You edit ONE advertising creative described by a JSON "spec". Apply the user\'s instruction and ' +
    'return ONLY a JSON object {"changes":{...},"note":"one short sentence on what you changed"}, where ' +
    '"changes" contains just the spec fields to update (omit anything unchanged). Keep copy concise and ' +
    'ad-appropriate. Allowed fields and values:\n' +
    '- template: comparison | phone | statement | stat | quote | feature | plain-image | overlay ' +
    '(shown as Comparison, Device, Statement, Big Stat, Testimonial, Features, Image+Bar, Image Overlay)\n' +
    '- format: square | portrait | story\n- theme: dark | light\n- font: clean | brand\n' +
    '- layout: auto | top | bottom | left | right | center (media/text placement, where the template supports it)\n' +
    '- density: minimal | standard | rich (how much copy shows on the creative)\n' +
    '- align: left | center\n' +
    '- caption: the Facebook primary text shown above the creative (90-220 chars, hook first)\n' +
    '- description: link-card description under the headline, <= 30 chars\n' +
    '- background: midnight | solid-dark | solid-light | gradient-blue | gradient-purple | gradient-sunset | gradient-emerald | mesh | dots | rainbow\n' +
    '- accent: a hex colour e.g. #ff7a3c\n' +
    '- badge, headlineStart, headlineHighlight, subtext, cta: short strings\n' +
    '- boldPhrases: array of substrings that occur in subtext\n- bullets: array of short strings (Features)\n' +
    '- stat: {value,label} ; quote: {text,author,role} ; captions: {before,after}\n' +
    'Never include image fields. If you change the background, also set a matching theme for legibility. JSON only.';
  var user = 'Current spec:\n' + JSON.stringify(spec) + '\n\nInstruction: ' + instruction;
  return { model: MODEL, max_tokens: 1024, system: system, messages: [{ role: 'user', content: user }] };
}
function parseEditResponse(body) {
  var json = JSON.parse(body);
  if (json.type === 'error') throw new Error((json.error && json.error.message) || 'API error');
  var text = ''; (json.content || []).forEach(function (b) { if (b.type === 'text') text += b.text; });
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  var data = JSON.parse(text);
  return { changes: data.changes || (data.note ? {} : data) || {}, note: data.note || '' };
}

/* ---- Project dossier (deep read of ALL uploaded material) ----------------- */
// The model reads everything the user gave us — site copy, documents, notes,
// plus images/video frames via vision — and writes a thorough, grounded
// dossier. That dossier then becomes the brief every ad is written from.
function buildDossierRequest(input) {
  var site = input.site || {};
  var files = Array.isArray(input.files) ? input.files.slice(0, 12) : [];
  var notes = String(input.notes || '').slice(0, 6000);
  var brand = input.brand || {};

  var parts = [];
  if (site.title || site.text) {
    parts.push('=== WEBSITE (' + (site.finalUrl || site.url || '') + ') ===\n' +
      'Title: ' + (site.title || '') + '\nMeta description: ' + (site.description || '') + '\n' +
      (site.headings && site.headings.length ? 'Headings: ' + site.headings.slice(0, 30).join(' | ') + '\n' : '') +
      'Page copy:\n' + String(site.text || '').slice(0, 14000));
  }
  files.forEach(function (f) {
    parts.push('=== DOCUMENT: ' + (f.name || 'file') + ' ===\n' + String(f.text || '').slice(0, 10000));
  });
  // full transcripts of uploaded videos — what the footage SAYS, not just shows
  (Array.isArray(input.videos) ? input.videos.slice(0, 4) : []).forEach(function (v) {
    if (v && v.transcript) parts.push('=== VIDEO TRANSCRIPT (spoken audio of "' + (v.name || 'video') + '") ===\n' + String(v.transcript).slice(0, 9000));
  });
  if (notes) parts.push('=== ADVERTISER NOTES ===\n' + notes);

  var imgBlocks = [];
  (Array.isArray(input.images) ? input.images.slice(0, 14) : []).forEach(function (f) {
    var m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(f || ''));
    if (m && m[2].length < 3500000) imgBlocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  });

  var system =
    'You are a senior brand and product strategist doing a DEEP READ of everything an advertiser has ' +
    'provided about their product before an ad campaign. Be thorough and take your time: read every ' +
    'section of text (including full video transcripts — what the footage actually SAYS), study every ' +
    'image (many are frames sampled across the advertiser\'s video — treat them as watching it), and ' +
    'extract everything a copywriter would need. Rules:\n' +
    '- Ground EVERY claim in the provided material. Never invent stats, quotes, customers or features.\n' +
    '- If the material is thin on something (e.g. no pricing, no testimonials), say so in that section.\n' +
    '- Write in plain, specific language — no marketing fluff of your own.\n' +
    'You ONLY output valid JSON.';

  var instruction =
    (brand.name ? 'Brand/product name: ' + brand.name + '. ' : '') +
    'Study ALL the material below' + (imgBlocks.length ? ' and the ' + imgBlocks.length + ' attached image(s)/video frame(s)' : '') +
    ', then produce a detailed project dossier as JSON of the exact shape:\n' +
    '{"summary":"one tight paragraph: what this product/site is and why it matters",' +
    '"product":"detailed: what it is, what it does, how it works, pricing/offer if stated",' +
    '"audience":"who it is for: segments, situations, pains they feel (grounded in the material)",' +
    '"benefits":["outcome-focused benefit statements"],' +
    '"features":["concrete features/capabilities found in the material"],' +
    '"proof":["ONLY real numbers, quotes, names, awards found in the material — empty array if none"],' +
    '"objections":["likely customer objections + how the material answers them"],' +
    '"tone":"the brand voice you observe (word choice, energy, formality)",' +
    '"visuals":"what the images/video frames actually show and the visual style to lean into",' +
    '"keywords":["search/topic keywords this project is about"],' +
    '"researchQuery":"the single best real-world market-research search topic for finding the audience\'s pain points this product answers — a natural search phrase a strategist would google, e.g. \'frustrations preserving memories of loved ones who have died\' or \'why home espresso machines disappoint people\'. Focus on the PROBLEM/desire in the market, not the brand name."}\n' +
    'Make it LONG and specific — this dossier is the single source every ad will be written from.\n\n' +
    'MATERIAL:\n\n' + parts.join('\n\n').slice(0, 45000) + '\n\nJSON only.';

  var content = imgBlocks.length ? [{ type: 'text', text: instruction }].concat(imgBlocks) : instruction;
  return { model: MODEL, max_tokens: 8192, system: system, messages: [{ role: 'user', content: content }] };
}
function parseDossierResponse(body) {
  var json = JSON.parse(body);
  if (json.type === 'error') throw new Error((json.error && json.error.message) || 'API error');
  if (json.stop_reason === 'max_tokens') throw new Error('The dossier hit the output limit — remove some material and re-analyze');
  var text = ''; (json.content || []).forEach(function (b) { if (b.type === 'text') text += b.text; });
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // survive stray prose around the JSON object
  var a = text.indexOf('{'), z = text.lastIndexOf('}');
  if (a >= 0 && z > a) text = text.slice(a, z + 1);
  var d = JSON.parse(text);
  if (!d || typeof d !== 'object' || !d.summary) throw new Error('Dossier came back empty');
  // normalise the shape — the model may hand back strings where we asked for
  // arrays; downstream code must never see a surprise type
  function arr(v) { return Array.isArray(v) ? v.map(function (x) { return String(x); }) : (v ? [String(v)] : []); }
  function str(v) { return v == null ? '' : String(v); }
  return {
    summary: str(d.summary), product: str(d.product), audience: str(d.audience),
    benefits: arr(d.benefits), features: arr(d.features), proof: arr(d.proof),
    objections: arr(d.objections), tone: str(d.tone), visuals: str(d.visuals), keywords: arr(d.keywords),
    researchQuery: str(d.researchQuery)
  };
}

/* ---- Market research (pain points via Claude web search) ------------------ */
// Deep market research on a topic: Claude searches the web for complaints,
// reviews and forum threads, then distils distinct PAIN POINTS — each with an
// ad-ready hook, headline, tagline and description. If the org doesn't have
// web search enabled we retry on model knowledge alone (labelled as such).
// Media plan: given a budget, chosen platforms, the audience analysis and the
// round's actual ads, produce a concrete spend plan the advertiser can approve.
function buildMediaPlanRequest(input) {
  var context = String(input.context || '').slice(0, 24000);
  var system =
    'You are a senior paid-social media buyer. An advertiser gives you a fixed budget, the platforms they ' +
    'want, the exact ads they will run, and a researched audience analysis. You return a concrete, ' +
    'executable plan — never generic advice. Rules: allocate the REAL budget numbers (they must sum to the ' +
    'total); match specific ads to the specific audience segments they resonate with (use the analysis); ' +
    'respect the advertiser’s extra instructions; be honest about what this budget can and cannot achieve; ' +
    'plan checkpoints where underperformers get cut. You ONLY output valid JSON.';
  var instruction = context +
    '\n\nReturn ONLY a JSON object of this exact shape:\n' +
    '{"strategy":"the game plan in one tight paragraph — where the money goes and why",' +
    '"duration":"recommended run length and pacing",' +
    '"perPlatform":[{"platform":"","budget":"amount with currency","share":"e.g. 60%","why":"","placements":["..."],"targeting":"who to aim at there, from the audience analysis"}],' +
    '"adPlan":[{"ad":"the ad angle/name EXACTLY as given","platforms":["..."],"budget":"","segment":"which audience segment this ad speaks to","note":"format/scheduling note"}],' +
    '"schedule":"when to launch what, in plain words",' +
    '"expectations":"realistic outcomes for this budget (ranges, not promises)",' +
    '"checkpoints":"when to check results and what to kill or scale",' +
    '"warnings":"anything the advertiser should know before spending"}';
  return { model: MODEL, max_tokens: 6000, system: system, messages: [{ role: 'user', content: instruction }] };
}
function parseMediaPlanResponse(body) {
  var json = JSON.parse(body);
  if (json.type === 'error') throw new Error((json.error && json.error.message) || 'API error');
  if (json.stop_reason === 'max_tokens') throw new Error('The plan hit the output limit — try again');
  var text = '';
  (json.content || []).forEach(function (b) { if (b.type === 'text') text += b.text; });
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  var a = text.indexOf('{'), z = text.lastIndexOf('}');
  if (a >= 0 && z > a) text = text.slice(a, z + 1);
  var d = JSON.parse(text);
  function str(v, n) { return v == null ? '' : String(v).slice(0, n || 700); }
  function arr(v, n, len) { return Array.isArray(v) ? v.slice(0, n || 8).map(function (x) { return str(x, len || 120); }).filter(Boolean) : []; }
  var plan = {
    strategy: str(d.strategy, 1200),
    duration: str(d.duration, 200),
    perPlatform: (Array.isArray(d.perPlatform) ? d.perPlatform : []).slice(0, 6).map(function (x) {
      x = x || {};
      return { platform: str(x.platform, 40), budget: str(x.budget, 60), share: str(x.share, 20), why: str(x.why, 500), placements: arr(x.placements), targeting: str(x.targeting, 400) };
    }),
    adPlan: (Array.isArray(d.adPlan) ? d.adPlan : []).slice(0, 40).map(function (x) {
      x = x || {};
      return { ad: str(x.ad, 140), platforms: arr(x.platforms), budget: str(x.budget, 60), segment: str(x.segment, 120), note: str(x.note, 300) };
    }),
    schedule: str(d.schedule, 700),
    expectations: str(d.expectations, 700),
    checkpoints: str(d.checkpoints, 700),
    warnings: str(d.warnings, 500)
  };
  if (!plan.strategy && !plan.perPlatform.length) throw new Error('No usable plan came back — try again');
  return plan;
}

// Audience analysis: study EVERY piece of project material, then research the
// live market, and answer the one question that decides ad spend — WHO should
// these ads be shown to (age, gender, regions, platforms), and with which ads.
function buildAudienceRequest(input, useWebSearch) {
  var context = String(input.context || '').slice(0, 42000);
  var brand = String(input.brand || 'the brand').slice(0, 80);

  var system =
    'You are a senior audience strategist and media planner for paid social. Brands hand you everything ' +
    'they have, and you tell them exactly WHO to put their ads in front of — grounded, specific, honest.\n' +
    'Method — in this order, taking your time:\n' +
    '1) STUDY the supplied material end to end: what the product truly is, what it costs emotionally and ' +
    'practically, every audience clue in the site copy, documents, research pain points (and WHO voices ' +
    'each one), the saved ad angles that the advertiser chose to keep, and what the imagery portrays.\n' +
    (useWebSearch
      ? '2) RESEARCH the live market: demographic studies and surveys for this category, who actually buys ' +
        'and who decides, platform usage by age and gender, regional and cultural patterns, competitor ' +
        'audiences. Ground your numbers in what you find and note sources.\n'
      : '2) Web search is unavailable — draw on your market knowledge and say so honestly in "evidence".\n') +
    '3) SYNTHESIZE: distinct buyer segments (different motivations, not rephrasings), ranked by likelihood ' +
    'to convert for THIS product, each mapped to the saved ad angles that would resonate with it.\n' +
    'Rules: be specific (not "adults 18-65"); genders as honest splits, not defaults; regions concrete ' +
    '(countries/metros and why); platforms where THIS segment actually is; never invent statistics — if ' +
    'evidence is thin, say so. You ONLY output valid JSON (after any research).';

  var instruction =
    'Everything ' + brand + ' knows about itself, its market and its ads (study ALL of it first):\n"""\n' + context + '\n"""\n\n' +
    'Now do your research and return ONLY a JSON object of this exact shape:\n' +
    '{"summary":"one tight paragraph: who this product is really for and the single most important targeting insight",' +
    '"primary":{"name":"segment name","who":"2-3 sentences describing them as real people","age":"e.g. 45-65","gender":"honest split e.g. ~65% female","regions":["..."],"platforms":["..."],"why":"why they convert best, grounded in the material + research"},' +
    '"segments":[{"name":"","who":"","age":"","gender":"","regions":["..."],"income":"","platforms":["..."],"why":"","adAngles":["which saved ad angles/hooks fit this segment"],"evidence":"the strongest supporting finding + where it came from","priority":1}],' +
    '"targeting":{"ageRange":"e.g. 35-64","genders":"e.g. all, skew female","locations":["countries/metros to start with"],"interests":["Meta interest/behavior targets"],"placements":["e.g. Instagram Feed, Facebook Feed, Reels"],"budgetSplit":"how to split spend across segments to start","notes":"practical launch advice in 2-3 sentences"},' +
    '"avoid":"who NOT to spend on, and why"}\n' +
    'Include 3-5 segments, priority 1 = best. JSON only after your research.';

  var req = {
    model: MODEL, max_tokens: 12000, system: system,
    messages: [{ role: 'user', content: instruction }]
  };
  if (useWebSearch) req.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }];
  return req;
}
function parseAudienceResponse(body, priorText) {
  var json = JSON.parse(body);
  if (json.type === 'error') throw new Error((json.error && json.error.message) || 'API error');
  if (json.stop_reason === 'max_tokens') throw new Error('The analysis hit the output limit — try again');
  var text = String(priorText || '');
  (json.content || []).forEach(function (b) { if (b.type === 'text') text += b.text; });
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  var a = text.indexOf('{'), z = text.lastIndexOf('}');
  if (a >= 0 && z > a) text = text.slice(a, z + 1);
  var d = JSON.parse(text);
  function str(v, n) { return v == null ? '' : String(v).slice(0, n || 600); }
  function arr(v, n, len) { return Array.isArray(v) ? v.slice(0, n || 8).map(function (x) { return str(x, len || 120); }).filter(Boolean) : []; }
  function seg(s) {
    s = s || {};
    return {
      name: str(s.name, 80), who: str(s.who, 700), age: str(s.age, 40), gender: str(s.gender, 80),
      regions: arr(s.regions), income: str(s.income, 120), platforms: arr(s.platforms),
      why: str(s.why, 700), adAngles: arr(s.adAngles, 10, 160), evidence: str(s.evidence, 400),
      priority: Math.max(1, Math.min(9, parseInt(s.priority, 10) || 9))
    };
  }
  var t = d.targeting || {};
  // a syntactically-valid but EMPTY answer must fail loudly, not silently
  // overwrite a stored analysis with nothing (mirrors the research guard)
  var segsIn = Array.isArray(d.segments) ? d.segments : [];
  if (!String(d.summary || '').trim() && !segsIn.length && !(d.primary && d.primary.name)) {
    throw new Error('No usable audience analysis came back — try again');
  }
  return {
    summary: str(d.summary, 900),
    primary: seg(d.primary),
    segments: segsIn.slice(0, 6).map(seg)
      .sort(function (x, y) { return x.priority - y.priority; }),
    targeting: {
      ageRange: str(t.ageRange, 40), genders: str(t.genders, 80), locations: arr(t.locations, 10),
      interests: arr(t.interests, 14, 80), placements: arr(t.placements, 8),
      budgetSplit: str(t.budgetSplit, 300), notes: str(t.notes, 500)
    },
    avoid: str(d.avoid, 400)
  };
}
function buildResearchRequest(input, useWebSearch) {
  var topic = String(input.topic || '').slice(0, 300);
  var context = String(input.context || '').slice(0, 2500);
  var count = Math.max(4, Math.min(24, parseInt(input.count, 10) || 20));

  var system =
    'You are a market research analyst for direct-response advertising. Your specialty is finding the ' +
    'REAL pain points a market feels — the complaints, frustrations and unmet desires people voice in ' +
    'reviews, forums and social threads — and turning each one into ad-ready messaging. Rules:\n' +
    '- Each pain point must be DISTINCT (different root frustration, not rephrasings).\n' +
    '- Capture the market\'s OWN language: how people actually complain, not marketing speak.\n' +
    '- hooks/headlines must be scroll-stopping and specific; taglines short; descriptions 1-2 tight sentences ' +
    'that expand the hook and set up the product as the answer.\n' +
    (useWebSearch
      ? '- SEARCH THE WEB before answering: reviews, Reddit/forums, comparison threads, complaint sites. Ground every pain point in what you actually find and note where it came from.\n'
      : '- Web search is unavailable: draw on your knowledge of this market. Be honest in "source" that it is market knowledge, not a live citation.\n') +
    'You ONLY output valid JSON (after any research).';

  var instruction =
    'Research the market around: "' + topic + '"\n' +
    (context ? '\nContext — the product these ads will promote (find pain points this product can answer):\n"""\n' + context + '\n"""\n' : '') +
    '\nIdentify the ' + count + ' strongest pain points in this market, then return ONLY a JSON object of the exact shape:\n' +
    '{"topic":' + JSON.stringify(topic) + ',' +
    '"summary":"one tight paragraph: the state of this market and what buyers are frustrated by",' +
    '"painPoints":[{' +
    '"pain":"the pain point in plain words",' +
    '"who":"who feels it most",' +
    '"quote":"the market\'s own language — a representative complaint, short",' +
    '"hook":"scroll-stopping ad hook line built on this pain",' +
    '"headline":"ad headline, <= 40 characters",' +
    '"tagline":"supporting tagline, <= 60 characters",' +
    '"description":"1-2 sentences under the hook: expand the pain, point to the answer",' +
    '"source":"where this came from (site/forum name)' + (useWebSearch ? '' : ' or \'market knowledge\'') + '"' +
    '}]}\nJSON only after your research.';

  var req = {
    model: MODEL, max_tokens: 8192, system: system,
    messages: [{ role: 'user', content: instruction }]
  };
  if (useWebSearch) req.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];
  return req;
}
function parseResearchResponse(body, priorText) {
  var json = JSON.parse(body);
  if (json.type === 'error') throw new Error((json.error && json.error.message) || 'API error');
  if (json.stop_reason === 'max_tokens') throw new Error('Research hit the output limit — try a narrower topic');
  var text = String(priorText || '');
  (json.content || []).forEach(function (b) { if (b.type === 'text') text += b.text; });
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  var a = text.indexOf('{'), z = text.lastIndexOf('}');
  if (a >= 0 && z > a) text = text.slice(a, z + 1);
  var d = JSON.parse(text);
  function str(v) { return v == null ? '' : String(v); }
  var pts = Array.isArray(d.painPoints) ? d.painPoints : [];
  pts = pts.map(function (p) {
    p = p || {};
    return { pain: str(p.pain), who: str(p.who), quote: str(p.quote), hook: str(p.hook),
      headline: str(p.headline), tagline: str(p.tagline), description: str(p.description), source: str(p.source) };
  }).filter(function (p) { return p.pain && (p.hook || p.headline); });
  if (!pts.length) throw new Error('No usable pain points came back — try rephrasing the topic');
  return { topic: str(d.topic), summary: str(d.summary), painPoints: pts };
}

/* ---- AI image concepts (art-directed prompts for ad visuals) --------------
   Claude studies the dossier + market research + the advertiser's reference
   images (vision) and invents N distinct image CONCEPTS that would make
   powerful ad visuals — each a detailed generation prompt + a short label.
   A dedicated image model turns these into pixels (not wired yet). */
function buildImageConceptsRequest(input) {
  var brand = input.brand || {};
  var context = String(input.context || '').slice(0, 16000);
  var count = Math.max(1, Math.min(25, parseInt(input.count, 10) || 6));
  var refs = Array.isArray(input.images) ? input.images.slice(0, 6) : [];
  var imgBlocks = [];
  refs.forEach(function (f) {
    var m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(f || ''));
    if (m && m[2].length < 3500000) imgBlocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  });
  // Roughly half the concepts stay in the reference images' visual world (new
  // scenes, never recreations); the rest are blue-sky ideas from the dossier +
  // research alone. Without references, everything is invented fresh.
  var worldN = imgBlocks.length ? Math.ceil(count / 2) : 0;
  var freshN = count - worldN;
  var system =
    'You are a world-class advertising ART DIRECTOR and photographic prompt-writer' + (brand.name ? ' working for ' + brand.name : '') + '. ' +
    'Your job: invent the AD IMAGERY that makes people stop scrolling — images with an idea in them, not decoration. ' +
    'You are handed a deep project dossier and real market research (buyer pain points in their own words). You turn that ' +
    'understanding into image concepts a text-to-image model will render.\n\n' +
    'HOW YOU WORK:\n' +
    '1. UNDERSTAND FIRST. Read the dossier and research like a strategist: who is this buyer, what do they ache for, ' +
    'what moment of their life does this product enter? The strongest ad image dramatizes a PAIN, a DESIRE, or the ' +
    'MOMENT OF RELIEF — it tells a one-frame story the audience recognizes as their own. Tie concepts to specific pain ' +
    'points and audience truths from the material, and let several concepts show PEOPLE living those moments.\n' +
    '2. NEVER COPY THE REFERENCES. If reference images are attached, study them only to learn the brand\'s visual world — ' +
    'palette, light, grade, mood, the kinds of places and objects that belong. Then invent scenes that do NOT exist in ' +
    'any reference: different subjects, different rooms, different people, different moments. Describing a reference ' +
    'image back, or a near-variation of one, is a FAILURE. Every scene must be one the camera has never taken.\n' +
    '3. RANGE IS THE JOB. Across the set, deliberately vary EVERY axis:\n' +
    '   - Subject: people (different ages, genders, skin tones, solo/pairs/groups), hands & objects, environments, ' +
    'still-life, abstract/metaphorical images that capture the FEELING.\n' +
    '   - Emotion: longing, relief, joy, quiet intimacy, awe, humour, nostalgia — not one note.\n' +
    '   - Scale & framing: extreme close-up / macro detail, waist-up portrait, wide environmental shot, overhead ' +
    'flat-lay, aerial — never the same framing twice in a row.\n' +
    '   - Light & time: golden hour, blue hour, harsh noon, candlelight, window light, neon night, overcast soft.\n' +
    '   - Genre: candid documentary, editorial portraiture, cinematic still, product-in-life, fine-art conceptual.\n' +
    '4. WRITE PROMPTS LIKE A DP BRIEFS A PHOTOGRAPHER. Each prompt is 60–120 words, one paragraph, concrete and ' +
    'renderable: the SUBJECT and what they are doing/feeling → the SETTING and time of day → COMPOSITION and camera ' +
    '(lens feel, angle, depth of field) → LIGHT → PALETTE/grade → MOOD → photographic genre. Name real, specific ' +
    'things ("a father\'s weathered hands closing a tin of photographs" not "a person with memories"). ' +
    'Absolutely no text, words, letters, numbers, logos, watermarks or UI in the image — say so implicitly by never ' +
    'asking for them; NEVER put brand names or written words in the scene.\n' +
    '5. TASTE. Real, human, specific, a little imperfect — never stocky, never staged-corporate, never clichéd ' +
    '(no lightbulbs for ideas, no handshakes, no generic smiling-at-laptop).\n' +
    'You ONLY output valid JSON.';
  var user =
    'THE PROJECT — dossier + market research (read deeply; every concept must be grounded here):\n"""\n' + context + '\n"""\n\n' +
    (imgBlocks.length
      ? 'Attached: ' + imgBlocks.length + ' reference image(s) showing the brand\'s existing visual world.\n\n' +
        'Produce EXACTLY ' + count + ' concepts in two modes:\n' +
        '- ' + worldN + ' concepts with "mode":"world" — they LIVE in the same visual world as the references (same palette family, ' +
        'light quality, level of realism) but are COMPLETELY NEW SCENES: new subjects, new settings, new moments that appear in NO reference. ' +
        'Do not restage, crop, recolour or riff on any reference composition.\n' +
        '- ' + freshN + ' concepts with "mode":"fresh" — ignore the references entirely. Invent from the dossier and pain points alone: ' +
        'the images YOU believe would be the highest-performing ads for this project, even if they look nothing like the brand\'s current imagery.\n\n'
      : 'Produce EXACTLY ' + count + ' concepts, all with "mode":"fresh" — invented from the dossier and pain points alone: ' +
        'the images YOU believe would be the highest-performing ads for this project.\n\n') +
    'Cover different pain points across the set — do not hang every concept on the same insight.\n' +
    'Return ONLY {"images":[{"label":"2-4 word name","mode":"world|fresh","prompt":"the full 60-120 word image-generation prompt","why":"one line: which pain/desire it dramatizes and why it stops the scroll"}]} with exactly ' + count + ' entries.';
  var content = imgBlocks.length ? [{ type: 'text', text: user }].concat(imgBlocks) : user;
  return { model: MODEL, max_tokens: 16384, system: system, messages: [{ role: 'user', content: content }] };
}
function parseImageConceptsResponse(body) {
  var json = JSON.parse(body);
  if (json.type === 'error') throw new Error((json.error && json.error.message) || 'API error');
  var text = ''; (json.content || []).forEach(function (b) { if (b.type === 'text') text += b.text; });
  text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  var a = text.indexOf('{'), z = text.lastIndexOf('}');
  if (a >= 0 && z > a) text = text.slice(a, z + 1);
  var d = JSON.parse(text);
  function str(v) { return v == null ? '' : String(v); }
  var imgs = (Array.isArray(d.images) ? d.images : []).map(function (x) {
    x = x || {}; return { label: str(x.label).slice(0, 60), mode: x.mode === 'world' ? 'world' : 'fresh', prompt: str(x.prompt).slice(0, 2200), why: str(x.why).slice(0, 200) };
  }).filter(function (x) { return x.prompt; });
  if (!imgs.length) throw new Error('No image concepts came back');
  return imgs;
}

// The quality wrapper every concept prompt is rendered through — shared by the
// single and batch endpoints so both produce identical results.
function wrapImagePrompt(prompt, hasRefs) {
  return 'Photograph this scene as a single, original, high-end advertising image:\n\n' + prompt +
    '\n\nRender it photorealistic with true-to-life skin, materials and optics — natural imperfections, believable ' +
    'depth of field, no plastic AI sheen. Square 1:1 composition with clean space around the subject so it crops ' +
    'well as a social ad. This is a NEW scene invented from the description above — not a recreation of any ' +
    'existing photo. Strictly NO text, words, letters, numbers, captions, logos, watermarks or user-interface ' +
    'elements anywhere in the image.' +
    (hasRefs ? '\n\nAny attached image is a loose style reference for palette and light ONLY — do not reuse, recreate, edit or closely echo its content.' : '');
}

// Render one image with Nano Banana (Gemini) → data URI. Reference images are
// passed as inline_data so the model can match the brand's visual world.
function geminiGenerate(prompt, refs, cb) {
  var key = effectiveGeminiKey();
  if (!key) return cb(new Error('no_gemini_key'));
  var parts = [{ text: prompt }];
  (refs || []).slice(0, 3).forEach(function (u) {
    var m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(u || ''));
    if (m && m[2].length < 3500000) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  });
  var payload = JSON.stringify({ contents: [{ parts: parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } });
  var reqOpts = {
    hostname: 'generativelanguage.googleapis.com',
    path: '/' + GEMINI_API_VERSION + '/models/' + encodeURIComponent(GEMINI_IMAGE_MODEL) + ':generateContent',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'Content-Length': Buffer.byteLength(payload) }
  };
  var greq = https.request(reqOpts, function (resp) {
    var chunks = [];
    resp.on('data', function (c) { chunks.push(c); });
    resp.on('end', function () {
      var body = Buffer.concat(chunks).toString('utf8');
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        var msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {}
        return cb(new Error('Gemini ' + resp.statusCode + ': ' + String(msg).slice(0, 300)));
      }
      var j; try { j = JSON.parse(body); } catch (e) { return cb(new Error('Bad Gemini response')); }
      var cand = (j.candidates || [])[0];
      var pr = (cand && cand.content && cand.content.parts) || [];
      for (var i = 0; i < pr.length; i++) {
        var d = pr[i].inline_data || pr[i].inlineData;
        if (d && d.data) { geminiLastError = ''; return cb(null, 'data:' + (d.mime_type || d.mimeType || 'image/png') + ';base64,' + d.data); }
      }
      var fr = cand && (cand.finishReason || cand.finish_reason);
      cb(new Error('No image came back' + (fr ? ' (' + fr + ')' : '') + ' — the prompt may have been blocked'));
    });
  });
  greq.on('error', function (e) { cb(e); });
  greq.setTimeout(120000, function () { greq.destroy(new Error('Gemini request timed out')); });
  greq.write(payload); greq.end();
}

/* ---- Veo (Gemini API) image-to-video --------------------------------------
   Animates one of the tool's AI-generated stills into REAL footage: start a
   predictLongRunning job (prompt + inline image), poll the operation until
   done, download the mp4. Same key as Nano Banana. ~8s vertical clip. */
var VEO_MODEL = process.env.ADS_VEO_MODEL || 'veo-3.1-fast-generate-preview';
function veoRequest(method, apiPath, payload, cb) {
  var data = payload ? JSON.stringify(payload) : null;
  var r = https.request({
    hostname: 'generativelanguage.googleapis.com', path: apiPath, method: method,
    headers: Object.assign({ 'x-goog-api-key': effectiveGeminiKey() },
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
  }, function (resp) {
    var body = '';
    resp.on('data', function (c) { body += c; });
    resp.on('end', function () {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        var msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {}
        return cb(new Error('Veo ' + resp.statusCode + ': ' + String(msg).slice(0, 300)));
      }
      var j; try { j = JSON.parse(body); } catch (e) { return cb(new Error('Bad Veo response')); }
      cb(null, j);
    });
  });
  r.on('error', cb);
  r.setTimeout(60000, function () { r.destroy(new Error('Veo request timed out')); });
  if (data) r.write(data);
  r.end();
}
function veoDownload(uri, cb, hops) {
  hops = hops || 0;
  if (hops > 4) return cb(new Error('Too many redirects downloading the clip'));
  var r = https.get(uri, { headers: { 'x-goog-api-key': effectiveGeminiKey() } }, function (resp) {
    if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
      resp.resume(); return veoDownload(resp.headers.location, cb, hops + 1);
    }
    if (resp.statusCode < 200 || resp.statusCode >= 300) { resp.resume(); return cb(new Error('Clip download failed (' + resp.statusCode + ')')); }
    var chunks = [], size = 0;
    resp.on('data', function (c) { size += c.length; if (size > 200 * 1024 * 1024) { r.destroy(); return; } chunks.push(c); });
    resp.on('end', function () { cb(null, Buffer.concat(chunks)); });
  });
  r.on('error', cb);
  r.setTimeout(180000, function () { r.destroy(new Error('Clip download timed out')); });
}
function veoGenerate(prompt, imageDataURL, cb) {
  if (!effectiveGeminiKey()) return cb(new Error('no_gemini_key'));
  var m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(imageDataURL || ''));
  if (!m) return cb(new Error('The image must be an inline data URL'));
  function start(imageField, isRetry) {
    veoRequest('POST', '/v1beta/models/' + encodeURIComponent(VEO_MODEL) + ':predictLongRunning', {
      instances: [{ prompt: prompt, image: imageField }],
      parameters: { aspectRatio: '9:16', resolution: '720p' }
    }, function (err, j) {
      if (err) {
        // some API versions want the older image encoding — try both once
        if (!isRetry && /400/.test(err.message) && /image|inline|unknown|invalid/i.test(err.message)) {
          return start({ bytesBase64Encoded: m[2], mimeType: m[1] }, true);
        }
        return cb(err);
      }
      if (!j.name) return cb(new Error('Veo did not return an operation id'));
      var waited = 0;
      (function poll() {
        setTimeout(function () {
          waited += 8;
          veoRequest('GET', '/v1beta/' + j.name, null, function (perr, op) {
            if (perr) return cb(perr);
            if (!op.done) {
              if (waited > 420) return cb(new Error('Veo is taking too long — try again in a few minutes'));
              return poll();
            }
            if (op.error) return cb(new Error('Veo: ' + String(op.error.message || 'generation failed').slice(0, 300)));
            var r2 = op.response || {};
            var sample = (((r2.generateVideoResponse || {}).generatedSamples) || [])[0] ||
                         ((r2.generatedVideos || [])[0]) || ((r2.videos || [])[0]) || null;
            var uri = sample && ((sample.video && (sample.video.uri || sample.video.url)) || sample.uri || sample.url);
            if (!uri) return cb(new Error('Veo finished but returned no video (the image may have been blocked)'));
            veoDownload(uri, cb);
          });
        }, 8000);
      })();
    });
  }
  start({ inlineData: { mimeType: m[1], data: m[2] } }, false);
}

// Cheap, free key check: ListModels uses the same key + auth path as image
// generation, so a 403/blocked here means the key can't reach the Gemini API at
// all (usually API restrictions on the key). Remembers the reason in
// geminiLastError so /api/gemini/status can surface it.
function geminiVerify(cb) {
  var key = effectiveGeminiKey();
  if (!key) return cb(new Error('no_gemini_key'));
  var req = https.request({
    hostname: 'generativelanguage.googleapis.com',
    path: '/' + GEMINI_API_VERSION + '/models', method: 'GET',
    headers: { 'x-goog-api-key': key }
  }, function (resp) {
    var chunks = []; resp.on('data', function (c) { chunks.push(c); });
    resp.on('end', function () {
      var body = Buffer.concat(chunks).toString('utf8');
      if (resp.statusCode >= 200 && resp.statusCode < 300) { geminiLastError = ''; return cb(null, true); }
      var msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {}
      geminiLastError = 'Gemini ' + resp.statusCode + ': ' + String(msg).slice(0, 300);
      cb(new Error(geminiLastError));
    });
  });
  req.on('error', function (e) { geminiLastError = e.message; cb(e); });
  req.setTimeout(15000, function () { req.destroy(new Error('Gemini check timed out')); });
  req.end();
}

/* ---- Instagram Graph API (Instagram-Login flavor, graph.instagram.com) ---- */
function igRequest(method, apiPath, params, cb, timeoutMs) {
  var qs = Object.keys(params || {}).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var p = apiPath.indexOf('/') === 0 ? '/' + IG_API_VERSION + apiPath : '/' + apiPath;   // 'refresh_access_token' is unversioned
  var body = null;
  if (method === 'GET') { if (qs) p += '?' + qs; } else body = qs;
  var called = false;
  function done(err, j) { if (called) return; called = true; cb(err, j); }   // end + a late socket error must not fire cb twice
  var rq = https.request({
    hostname: IG_GRAPH_HOST, path: p, method: method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body || '') }
  }, function (resp) {
    var chunks = []; resp.on('data', function (c) { chunks.push(c); });
    resp.on('end', function () {
      var txt = Buffer.concat(chunks).toString('utf8');
      var j = null; try { j = JSON.parse(txt); } catch (e) {}
      if (resp.statusCode >= 200 && resp.statusCode < 300 && j) return done(null, j);
      var msg = 'Instagram ' + resp.statusCode;
      if (j && j.error) msg += ': ' + (j.error.error_user_msg || j.error.message || JSON.stringify(j.error).slice(0, 200));
      else if (txt) msg += ': ' + txt.slice(0, 200);
      done(new Error(msg));
    });
  });
  rq.on('error', function (e) { done(new Error('Instagram request failed: ' + e.message)); });
  rq.setTimeout(timeoutMs || 60000, function () { rq.destroy(new Error('Instagram request timed out')); });
  if (body) rq.write(body);
  rq.end();
}

// Free check: /me proves the token reaches the API and names the account.
function igVerify(cb) {
  var tok = effectiveIgToken();
  if (!tok) return cb(new Error('no_ig_token'));
  igRequest('GET', '/me', { fields: 'user_id,username,account_type', access_token: tok }, function (err, j) {
    if (err) { igLastError = err.message; igUser = null; return cb(err); }
    igUser = { id: String(j.user_id || j.id || ''), username: j.username || '' };
    igLastError = '';
    cb(null, igUser);
  });
}

// Long-lived Instagram tokens expire after 60 days; a daily refresh keeps the
// saved one alive forever. (Refreshing a token younger than 24h is rejected by
// Meta — that error is expected and harmless.)
function igRefresh() {
  var tok = effectiveIgToken();
  if (!tok || IG_ENV_TOKEN) return;
  igRequest('GET', 'refresh_access_token', { grant_type: 'ig_refresh_token', access_token: tok }, function (err, j) {
    if (err || !j.access_token) {
      if (err && !/24 hours|too soon/i.test(err.message)) console.log('[ads-hub] IG token refresh: ' + (err ? err.message : 'no token in response'));
      return;
    }
    igRuntimeToken = j.access_token;
    fs.mkdir(path.dirname(IG_TOKEN_FILE), { recursive: true }, function () {
      fs.writeFile(IG_TOKEN_FILE, j.access_token, function (werr) {
        igTokenPersisted = !werr;
        console.log('[ads-hub] IG token refreshed (expires in ' + Math.round((j.expires_in || 0) / 86400) + 'd)');
      });
    });
  });
}

// Publish flow: create a media container, wait for Meta to ingest the media
// (it cURLs the /pub/ URL), then publish. Images are usually ready in seconds;
// Reels can take a couple of minutes to process.
function igPublish(kind, publicURL, caption, cb) {
  var tok = effectiveIgToken();
  if (!tok) return cb(new Error('no_ig_token'));
  // publish against the VERIFIED IG user id — /me/media is not documented for
  // this flavor. igUser is set by boot/save verify; re-verify lazily if the
  // process restarted without one.
  if (!igUser || !igUser.id) {
    return igVerify(function (verr) {
      if (verr) return cb(verr);
      igPublish(kind, publicURL, caption, cb);
    });
  }
  var params = kind === 'video'
    ? { media_type: 'REELS', video_url: publicURL, caption: caption || '', share_to_feed: 'true', access_token: tok }
    : { image_url: publicURL, caption: caption || '', access_token: tok };
  igRequest('POST', '/' + igUser.id + '/media', params, function (err, j) {
    if (err) return cb(err);
    var containerId = j.id;
    if (!containerId) return cb(new Error('Instagram returned no container id'));
    var pollMs = kind === 'video' ? 10000 : 5000;
    var tries = 0, maxTries = kind === 'video' ? 36 : 12;   // 6 min / 60s
    function publishNow() {
      igRequest('POST', '/me/media_publish', { creation_id: containerId, access_token: tok }, function (uerr, uj) {
        if (uerr) return cb(uerr);
        var mediaId = uj.id;
        igRequest('GET', '/' + mediaId, { fields: 'permalink', access_token: tok }, function (lerr, lj) {
          cb(null, { mediaId: String(mediaId), permalink: (lj && lj.permalink) || '' });
        });
      });
    }
    (function poll() {
      igRequest('GET', '/' + containerId, { fields: 'status_code,status', access_token: tok }, function (perr, pj) {
        // some image containers don't expose status — just publish them
        if (perr) { if (kind !== 'video') return publishNow(); return cb(perr); }
        var sc = pj.status_code || '';
        if (sc === 'FINISHED') return publishNow();
        if (sc === 'ERROR' || sc === 'EXPIRED') {
          return cb(new Error('Instagram could not process the media (' + sc + (pj.status ? ': ' + pj.status : '') + '). Check the media specs — images must be JPEG, reels MP4 (H.264).'));
        }
        // publish was never called on this path — the container just expires,
        // so the post did NOT go out and a retry is safe
        if (++tries >= maxTries) return cb(new Error('Instagram never finished processing the media — the post did NOT go out. Retrying is safe.'));
        setTimeout(poll, pollMs);
      });
    })();
  });
}

/* ---- Meta Marketing API (graph.facebook.com) — dark ads ------------------- */
function fbRequest(method, apiPath, params, cb, timeoutMs) {
  var qs = Object.keys(params || {}).map(function (k) {
    var v = params[k];
    if (v != null && typeof v === 'object') v = JSON.stringify(v);
    return encodeURIComponent(k) + '=' + encodeURIComponent(v);
  }).join('&');
  var p = '/' + IG_API_VERSION + apiPath;
  var body = null;
  if (method === 'GET') { if (qs) p += '?' + qs; } else body = qs;
  var called = false;
  function done(err, j) { if (called) return; called = true; cb(err, j); }
  var rq = https.request({
    hostname: FB_GRAPH_HOST, path: p, method: method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body || '') }
  }, function (resp) {
    var chunks = []; resp.on('data', function (c) { chunks.push(c); });
    resp.on('end', function () {
      var txt = Buffer.concat(chunks).toString('utf8');
      var j = null; try { j = JSON.parse(txt); } catch (e) {}
      if (resp.statusCode >= 200 && resp.statusCode < 300 && j) return done(null, j);
      var msg = 'Meta ' + resp.statusCode;
      if (j && j.error) msg += ': ' + (j.error.error_user_msg || j.error.message || JSON.stringify(j.error).slice(0, 250));
      else if (txt) msg += ': ' + txt.slice(0, 250);
      var em = new Error(msg);
      if (j && j.error) {
        em.fb = j.error;   // full structured error — handlers can self-heal (e.g. deprecated interests)
        // diagnosis trail: Meta's blunt user-facing strings hide the real
        // code/subcode — keep them in the server log
        console.log('[mads] ' + method + ' ' + apiPath + ' → code=' + j.error.code + ' subcode=' + (j.error.error_subcode || '-') + ' type=' + (j.error.type || '-') + ' | ' + String(j.error.message || '').slice(0, 200));
      }
      done(em);
    });
  });
  rq.on('error', function (e) { done(new Error('Meta request failed: ' + e.message)); });
  rq.setTimeout(timeoutMs || 120000, function () { rq.destroy(new Error('Meta request timed out')); });
  if (body) rq.write(body);
  rq.end();
}

// Verify the System User token and discover what it can reach: ad accounts,
// Pages, and each Page's connected Instagram identity. Auto-selects when
// there is exactly one of each; otherwise the client offers a picker.
function madsVerify(cb) {
  var tok = effectiveMadsToken();
  if (!tok) return cb(new Error('no_mads_token'));
  fbRequest('GET', '/me', { fields: 'id,name', access_token: tok }, function (err, me) {
    if (err) { madsLastError = err.message; return cb(err); }
    fbRequest('GET', '/me/adaccounts', { fields: 'name,account_status,currency', limit: 25, access_token: tok }, function (aerr, aj) {
      if (aerr) { madsLastError = aerr.message; return cb(aerr); }
      fbRequest('GET', '/me/accounts', { fields: 'name,instagram_business_account{id,username},connected_instagram_account{id,username}', limit: 25, access_token: tok }, function (perr, pj) {
        // tokens minted without instagram_basic can't read the IG sub-fields —
        // degrade to plain Page names rather than failing the whole verify
        if (perr) {
          return fbRequest('GET', '/me/accounts', { fields: 'name', limit: 25, access_token: tok }, function (perr2, pj2) {
            if (perr2) { madsLastError = perr.message; return cb(perr); }
            finish(pj2, 'Token can’t read Instagram links (regenerate it with instagram_basic for @-handle delivery)');
          });
        }
        finish(pj, '');
        function finish(pjX, igFieldError) {
        pj = pjX;
        var accounts = (aj.data || []).map(function (a) { return { id: a.id, name: a.name || a.id, currency: a.currency || 'USD', status: a.account_status }; });
        var pages = (pj.data || []).map(function (pg) {
          var ig = pg.instagram_business_account || pg.connected_instagram_account || null;
          return { id: pg.id, name: pg.name || pg.id, igUserId: ig ? String(ig.id) : '', igUsername: ig ? (ig.username || '') : '' };
        });
        var prev = madsConf || {};
        madsConf = {
          user: me.name || me.id, accounts: accounts, pages: pages,
          adAccountId: prev.adAccountId && accounts.some(function (a) { return a.id === prev.adAccountId; }) ? prev.adAccountId : (accounts.length === 1 ? accounts[0].id : ''),
          pageId: prev.pageId && pages.some(function (p) { return p.id === prev.pageId; }) ? prev.pageId : (pages.length === 1 ? pages[0].id : '')
        };
        var acct = accounts.filter(function (a) { return a.id === madsConf.adAccountId; })[0];
        var page = pages.filter(function (p) { return p.id === madsConf.pageId; })[0];
        madsConf.adAccountName = acct ? acct.name : ''; madsConf.currency = acct ? acct.currency : 'USD';
        madsConf.pageName = page ? page.name : ''; madsConf.igUserId = page ? page.igUserId : ''; madsConf.igUsername = page ? page.igUsername : '';
        madsConf.igFieldError = igFieldError || '';
        saveMadsConf();
        madsLastError = '';
        cb(null, madsConf);
        }
      });
    });
  });
}

// The dark-ads chain for one round: campaign → ad set (budget + targeting,
// Instagram placements) → per ad: media upload → creative → ad. EVERYTHING is
// created with status PAUSED — this code can never start spending money.
function madsDarkRun(jobId, input) {
  var tok = effectiveMadsToken();
  var job = igJobs[jobId];
  var rid = String(input.roundId || '');
  var out = { campaignId: '', adsetId: '', ads: {} };
  // the partial result rides on the job even when the chain fails — a created
  // campaign must never become invisible; the ledger also records it durably
  function ledger(state) {
    if (!rid) return;
    madsRuns[rid] = { campaignId: out.campaignId, adsetId: out.adsetId, ads: out.ads, at: Date.now(), state: state };
    saveMadsRuns();
  }
  function fail(e) {
    if (job) { job.state = 'error'; job.error = String(e && e.message || e).slice(0, 400); job.result = out; }
    if (out.campaignId) ledger('error');
  }
  function note(t) { if (job) { job.note = t; job.at = Date.now(); } }   // keep the sweeper away while progressing
  if (!tok) return fail(new Error('no_mads_token'));
  if (!madsConf || !madsConf.adAccountId || !madsConf.pageId) return fail(new Error('Pick the ad account and Page first (Performance → Instagram → Dark ads).'));
  var mult = MADS_OFFSET_ONE[String(madsConf.currency || 'USD').toUpperCase()] ? 1 : 100;
  // TOTAL budget over a fixed window: lifetime_budget + end_time gives a hard
  // spend cap and an automatic stop — no open-ended daily drip
  var totalMinor = Math.round((parseFloat(input.budget) || 0) * mult);
  var days = Math.min(90, Math.max(1, parseInt(input.days, 10) || 1));
  if (!(totalMinor > 0)) return fail(new Error('bad budget'));
  var act = '/' + madsConf.adAccountId;
  var ads = input.ads || [];
  // a failed earlier attempt may have left a usable paused campaign/adset —
  // reuse them instead of manufacturing lookalike orphans. "Failed" includes
  // runs that finished but with per-ad errors (e.g. the dev-mode creative
  // block): those RESUME too; only a fully-successful run means a new
  // campaign on the next deliberate re-run.
  var rec = rid ? madsRuns[rid] : null;
  var recHasFailures = !!(rec && rec.ads && Object.keys(rec.ads).some(function (k) { return !(rec.ads[k] && rec.ads[k].adId); }));
  var reuse = (rec && rec.campaignId && (rec.state === 'error' || recHasFailures)) ? rec : null;
  function withCampaign(cb2) {
    function proceed() {
      if (reuse && reuse.campaignId) { out.campaignId = reuse.campaignId; note('reusing the campaign from the failed attempt…'); return cb2(); }
      createCampaign();
    }
    // the recorded objects may have been archived/deleted in Ads Manager since
    // — validate before resuming; a dead record means build fresh
    if (reuse) {
      return fbRequest('GET', '/' + (reuse.adsetId || reuse.campaignId), { fields: 'effective_status', access_token: tok }, function (verr, vj) {
        var st = vj && vj.effective_status;
        if (verr || st === 'ARCHIVED' || st === 'DELETED') {
          note('the previous campaign was archived/deleted in Ads Manager — starting fresh…');
          reuse = null;
          if (rid && madsRuns[rid]) { delete madsRuns[rid]; saveMadsRuns(); }
        }
        proceed();
      });
    }
    proceed();
    function createCampaign() {
    note('creating campaign…');
    fbRequest('POST', act + '/campaigns', {
      name: 'Ads Hub — ' + (input.roundName || 'round') + ' — ' + new Date().toISOString().slice(0, 10),
      objective: 'OUTCOME_TRAFFIC', special_ad_categories: [], status: 'PAUSED',
      // required (v24+) whenever the budget lives on the ad set instead of the
      // campaign; false = the round's ad set keeps its budget strictly to itself
      is_adset_budget_sharing_enabled: false,
      access_token: tok
    }, function (cerr, cj) {
      if (cerr) return fail(cerr);
      out.campaignId = cj.id;
      ledger('running');
      cb2();
    });
    }
  }
  withCampaign(function () {
    var targeting = {
      geo_locations: { countries: input.countries && input.countries.length ? input.countries : ['CA'] },
      age_min: Math.max(18, parseInt(input.ageMin, 10) || 18),
      age_max: Math.min(65, parseInt(input.ageMax, 10) || 65),
      publisher_platforms: input.includeFb ? ['instagram', 'facebook'] : ['instagram'],
      instagram_positions: ['stream', 'story', 'reels']
    };
    if (input.includeFb) targeting.facebook_positions = ['feed'];
    // required flag: explicitly DISABLE Advantage+ audience expansion — the
    // whole point of this targeting is precision, Meta must not widen it
    targeting.targeting_automation = { advantage_audience: 0 };
    // precision aim: gender + detailed-targeting interests resolved against
    // Meta's catalog client-side ({id,name} pairs from /api/mads/interests)
    if (Array.isArray(input.genders) && input.genders.length) targeting.genders = input.genders.map(function (g) { return parseInt(g, 10); }).filter(Boolean);
    var ints = (Array.isArray(input.interests) ? input.interests : []).filter(function (x) { return x && x.id && x.name; })
      .map(function (x) { return { id: String(x.id), name: String(x.name).slice(0, 80) }; }).slice(0, 25);
    if (ints.length) targeting.interests = ints;
    function runAds() {
      var i = 0;
      (function nextAd() {
        if (i >= ads.length) {
          if (job) { job.state = 'done'; job.result = out; }
          ledger('done');
          return;
        }
        var ad = ads[i++];
        // already created by the failed attempt we're resuming — never remake it
        if (out.ads[ad.adKey] && out.ads[ad.adKey].adId) return nextAd();
        note('ad ' + i + '/' + ads.length + ': uploading media…');
        function makeCreative(storySpec) {
          note('ad ' + i + '/' + ads.length + ': creating creative…');
          fbRequest('POST', act + '/adcreatives', {
            name: 'Ads Hub — ' + (ad.name || ad.adKey),
            object_story_spec: storySpec,
            url_tags: 'utm_source=ig&utm_campaign=adshub&utm_content=' + encodeURIComponent(ad.adKey),
            access_token: tok
          }, function (crerr, crj) {
            if (crerr) { out.ads[ad.adKey] = { error: crerr.message.slice(0, 200) }; return nextAd(); }
            note('ad ' + i + '/' + ads.length + ': creating ad (PAUSED)…');
            fbRequest('POST', act + '/ads', {
              name: (ad.name || 'Ad') + ' [' + ad.adKey + ']',
              adset_id: out.adsetId, creative: { creative_id: crj.id }, status: 'PAUSED', access_token: tok
            }, function (aderr, adj) {
              if (aderr) out.ads[ad.adKey] = { error: aderr.message.slice(0, 200) };
              else out.ads[ad.adKey] = { adId: adj.id, creativeId: crj.id };
              nextAd();
            });
          });
        }
        function withImageHash(b64, cb2) {
          fbRequest('POST', act + '/adimages', { bytes: b64, access_token: tok }, function (ierr, ij) {
            if (ierr) return cb2(ierr);
            var imgs = ij.images || {};
            var first = imgs.bytes || imgs[Object.keys(imgs)[0]];
            if (!first || !first.hash) return cb2(new Error('Meta returned no image hash'));
            cb2(null, first.hash);
          });
        }
        if (ad.kind === 'video' && ad.videoUrl) {
          fbRequest('POST', act + '/advideos', { file_url: PUBLIC_BASE + ad.videoUrl, access_token: tok }, function (verr, vj) {
            if (verr) { out.ads[ad.adKey] = { error: verr.message.slice(0, 200) }; return nextAd(); }
            var videoId = vj.id, vtries = 0;
            (function pollVideo() {
              fbRequest('GET', '/' + videoId, { fields: 'status', access_token: tok }, function (perr2, pj2) {
                var st = pj2 && pj2.status && pj2.status.video_status;
                if (!perr2 && st === 'ready') {
                  return withImageHash(ad.thumbB64, function (therr, thash) {
                    if (therr) { out.ads[ad.adKey] = { error: therr.message.slice(0, 200) }; return nextAd(); }
                    makeCreative({
                      page_id: madsConf.pageId,
                      instagram_user_id: madsConf.igUserId || undefined,
                      video_data: { video_id: videoId, image_hash: thash, message: ad.caption || '', call_to_action: { type: 'LEARN_MORE', value: { link: ad.link } } }
                    });
                  });
                }
                if (!perr2 && st === 'error') { out.ads[ad.adKey] = { error: 'Meta could not process the video' }; return nextAd(); }
                if (++vtries > 36) { out.ads[ad.adKey] = { error: 'video processing timed out' }; return nextAd(); }
                note('ad ' + i + '/' + ads.length + ': video processing…');
                setTimeout(pollVideo, 5000);
              });
            })();
          }, 300000);
        } else {
          withImageHash(ad.imageB64, function (ierr, hash) {
            if (ierr) { out.ads[ad.adKey] = { error: ierr.message.slice(0, 200) }; return nextAd(); }
            makeCreative({
              page_id: madsConf.pageId,
              instagram_user_id: madsConf.igUserId || undefined,
              link_data: { link: ad.link, message: ad.caption || '', image_hash: hash, call_to_action: { type: 'LEARN_MORE', value: { link: ad.link } } }
            });
          });
        }
      })();
    }
    if (reuse && reuse.adsetId) {
      out.adsetId = reuse.adsetId;
      Object.keys(reuse.ads || {}).forEach(function (k) { if (reuse.ads[k] && reuse.ads[k].adId) out.ads[k] = reuse.ads[k]; });
      note('resuming the failed attempt — reusing its paused campaign and ad set…');
      return runAds();
    }
    // Meta retires interest ids constantly (their own search can return ones
    // already deprecated) — when the ad set is rejected for that, strip the
    // named ids and retry instead of surfacing an unfixable error.
    function createAdset(tg, attempt) {
      note(attempt ? 'creating ad set (retry without deprecated interests)…' : 'creating ad set…');
      fbRequest('POST', act + '/adsets', {
        name: 'Ads Hub — ' + (input.roundName || 'round'),
        campaign_id: out.campaignId,
        lifetime_budget: totalMinor,
        start_time: new Date().toISOString(),
        end_time: new Date(Date.now() + days * 86400 * 1000).toISOString(),
        billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: tg, status: 'PAUSED', access_token: tok
      }, function (serr, sj) {
        if (serr) {
          var raw = JSON.stringify(serr.fb || {}) + ' ' + serr.message;
          if (attempt < 2 && tg.interests && tg.interests.length && /deprecated/i.test(raw)) {
            var dep = [];
            raw.replace(/deprecated_interest_id[^0-9]*([0-9]{5,})/g, function (mm, id) { dep.push(id); return mm; });
            var kept = dep.length
              ? tg.interests.filter(function (x) { return dep.indexOf(String(x.id)) < 0; })
              : [];   // unparseable deprecation error → drop all interests rather than stay stuck
            if (kept.length < tg.interests.length) {
              var dropped = tg.interests.length - kept.length;
              note('Meta retired ' + dropped + ' interest' + (dropped === 1 ? '' : 's') + ' — retrying without ' + (kept.length ? 'them' : 'interest targeting') + '…');
              var tg2 = {}; Object.keys(tg).forEach(function (k2) { tg2[k2] = tg[k2]; });
              if (kept.length) tg2.interests = kept; else delete tg2.interests;
              return createAdset(tg2, attempt + 1);
            }
          }
          return fail(serr);
        }
        out.adsetId = sj.id;
        ledger('running');
        runAds();
      });
    }
    createAdset(targeting, 0);
  });
}

/* ---- Transcription proxy (local transcribe-hub on :3004) ------------------ */
// The uploaded project video is already on disk — stream it to the local
// whisper tool and let the client poll for the transcript. Nothing leaves
// the machine.
var TRANSCRIBE_PORT = parseInt(process.env.TRANSCRIBE_PORT, 10) || 3004;
function startTranscribeJob(filePath, name, cb) {
  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) return cb(new Error('Video file not found on the project'));
    var req2 = http.request({
      hostname: '127.0.0.1', port: TRANSCRIBE_PORT,
      path: '/api/transcribe?save=0&name=' + encodeURIComponent(name),
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': stat.size }
    }, function (resp) {
      var body = '';
      resp.on('data', function (c) { body += c; });
      resp.on('end', function () {
        try {
          var j = JSON.parse(body);
          if (j.jobId) return cb(null, j.jobId);
          cb(new Error(j.message || 'transcribe-hub refused the job'));
        } catch (e) { cb(new Error('Bad response from transcribe-hub')); }
      });
    });
    req2.on('error', function () { cb(new Error('transcribe-hub is not running on :' + TRANSCRIBE_PORT)); });
    req2.setTimeout(30000, function () { req2.destroy(new Error('transcribe-hub timed out')); });
    fs.createReadStream(filePath).pipe(req2);
  });
}
function pollTranscribeJob(jobId, cb) {
  var req2 = http.request({ hostname: '127.0.0.1', port: TRANSCRIBE_PORT, path: '/api/result/' + encodeURIComponent(jobId), method: 'GET' }, function (resp) {
    var body = '';
    resp.on('data', function (c) { body += c; });
    resp.on('end', function () {
      if (resp.statusCode === 409) return cb(null, { ready: false });
      if (resp.statusCode >= 300) {
        var msg = body; try { msg = JSON.parse(body).message; } catch (e) {}
        return cb(new Error(msg || ('transcription failed (' + resp.statusCode + ')')));
      }
      try { var j = JSON.parse(body); cb(null, { ready: true, text: String(j.text || '') }); }
      catch (e) { cb(new Error('Bad transcript response')); }
    });
  });
  req2.on('error', function () { cb(new Error('transcribe-hub is not running')); });
  req2.setTimeout(20000, function () { req2.destroy(new Error('transcribe-hub timed out')); });
  req2.end();
}

/* ---- Website scraper (for "generate ads from a URL") --------------------- */
// Fetch a URL with redirect-following + gzip/deflate/brotli decompression.
function httpGet(target, opts, cb, depth) {
  opts = opts || {}; depth = depth || 0;
  if (depth > 5) return cb(new Error('Too many redirects'));
  var u; try { u = new URL(target); } catch (e) { return cb(new Error('Invalid URL')); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb(new Error('Only http(s) URLs are supported'));
  var lib = u.protocol === 'https:' ? https : http;
  var maxBytes = opts.maxBytes || 3 * 1024 * 1024;
  // cb MUST fire exactly once. Destroying a request without an error emits
  // neither 'end' nor 'error', so an over-cap or reset response would otherwise
  // hang the caller forever (and any barrier waiting on it) — settle guards it.
  var settled = false;
  function fail(err) { if (settled) return; settled = true; cb(err); }
  var req = lib.request({
    method: 'GET', hostname: u.hostname, port: u.port || undefined, path: (u.pathname || '/') + (u.search || ''),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AdsHubBot/1.0)',
      'Accept': opts.accept || '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  }, function (resp) {
    if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
      resp.resume();
      var next; try { next = new URL(resp.headers.location, u).toString(); } catch (e) { return fail(new Error('Bad redirect')); }
      if (settled) return; settled = true;               // hand the callback to the redirect target
      return httpGet(next, opts, cb, depth + 1);
    }
    var chunks = [], total = 0, aborted = false;
    function finish() {
      if (settled) return; settled = true;
      var buf = Buffer.concat(chunks);
      var enc = (resp.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc.indexOf('br') >= 0) buf = zlib.brotliDecompressSync(buf);
        else if (enc.indexOf('gzip') >= 0) buf = zlib.gunzipSync(buf);
        else if (enc.indexOf('deflate') >= 0) buf = zlib.inflateSync(buf);
      } catch (e) { /* fall back to raw bytes */ }
      cb(null, { statusCode: aborted ? 200 : resp.statusCode, headers: resp.headers, body: buf, finalUrl: u.toString(), contentType: resp.headers['content-type'] || '' });
    }
    resp.on('data', function (c) {
      if (aborted) return;
      total += c.length;
      if (total > maxBytes) { aborted = true; try { req.destroy(); } catch (e) {} return finish(); }  // return the truncated body, don't hang
      chunks.push(c);
    });
    resp.on('end', finish);
    resp.on('aborted', finish);                          // reset mid-stream → return what we have
    resp.on('error', finish);
  });
  req.on('error', fail);
  req.setTimeout(opts.timeout || 12000, function () { try { req.destroy(new Error('Request timed out')); } catch (e) {} fail(new Error('Request timed out')); });
  req.end();
}

function htmlAttr(tag, name) {
  var m = tag.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i'));
  if (!m) return null; return m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function (_, n) { try { return String.fromCharCode(+n); } catch (e) { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { try { return String.fromCharCode(parseInt(n, 16)); } catch (e) { return ''; } });
}
function stripTags(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function parseMetas(html) {
  var metas = {}, re = /<meta\b[^>]*>/gi, m;
  while ((m = re.exec(html))) {
    var tag = m[0], key = (htmlAttr(tag, 'property') || htmlAttr(tag, 'name') || '').toLowerCase(), content = htmlAttr(tag, 'content');
    if (key && content != null && metas[key] == null) metas[key] = decodeEntities(content);
  }
  return metas;
}
function extractTitle(html) { var m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m ? stripTags(m[1]) : ''; }
function extractHeadings(html) {
  var out = [], re = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, m;
  while ((m = re.exec(html)) && out.length < 14) { var t = stripTags(m[1]); if (t && t.length < 160) out.push(t); }
  return out;
}
function visibleText(html) {
  var h = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  return stripTags(h);
}
function absUrl(href, base) { try { return new URL(href, base).toString(); } catch (e) { return null; } }
function findFavicon(html, base) {
  var re = /<link\b[^>]*>/gi, m, icon = null, apple = null;
  while ((m = re.exec(html))) {
    var tag = m[0], rel = (htmlAttr(tag, 'rel') || '').toLowerCase();
    if (rel.indexOf('icon') >= 0) { var href = htmlAttr(tag, 'href'); if (href) { if (rel.indexOf('apple') >= 0) apple = href; else icon = icon || href; } }
  }
  return absUrl(apple || icon || '/favicon.ico', base);
}
function validHex(s) { return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(s || '').trim()); }
function fetchImageDataURL(target, maxBytes, cb, minBytes) {
  if (!target) return cb(null);
  httpGet(target, { accept: 'image/*', maxBytes: maxBytes || 2 * 1024 * 1024, timeout: 7000 }, function (err, r) {
    if (err || !r || r.statusCode >= 400 || !r.body.length) return cb(null);
    var ct = (r.contentType || '').split(';')[0].trim().toLowerCase();
    // strict token match: a malicious server could smuggle quotes/attributes
    // through the header into a data-URI that lands in an <img src="..."> (XSS)
    if (!/^image\/[a-z0-9.+-]+$/.test(ct)) return cb(null);
    if (minBytes && r.body.length < minBytes) return cb(null);          // skip tiny icons/pixels
    if (ct.indexOf('svg') >= 0 && r.body.length > 300000) return cb(null);
    cb('data:' + ct + ';base64,' + r.body.toString('base64'));
  });
}

// Candidate content-image URLs on the page: OG/twitter, <img> (incl. srcset /
// lazy attrs), CSS background-image, and preloaded images. Filters out obvious
// icons/logos/sprites/pixels; resolves to absolute URLs, de-duped.
function extractImageUrls(html, base, metas) {
  var urls = [], seen = {};
  function add(u) {
    if (!u) return;
    u = String(u).trim().split(/\s+/)[0];               // drop srcset descriptors
    if (!u || /^data:/i.test(u)) return;
    var a = absUrl(u, base);
    if (!a || !/^https?:/i.test(a) || seen[a]) return;
    if (/(sprite|favicon|\bicon\b|logo|pixel|tracking|1x1|blank\.|spacer|avatar|badge|emoji)/i.test(a)) return;
    seen[a] = 1; urls.push(a);
  }
  ['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].forEach(function (k) { if (metas[k]) add(metas[k]); });
  var re = /<img\b[^>]*>/gi, m;
  while ((m = re.exec(html)) && urls.length < 40) {
    var tag = m[0];
    var ss = htmlAttr(tag, 'srcset') || htmlAttr(tag, 'data-srcset');
    if (ss) { var parts = ss.split(','); add(parts[parts.length - 1]); }   // largest candidate
    add(htmlAttr(tag, 'src') || htmlAttr(tag, 'data-src') || htmlAttr(tag, 'data-lazy-src') || htmlAttr(tag, 'data-original'));
  }
  var bg = /background(?:-image)?\s*:\s*[^;"'}]*url\((['"]?)([^)'"]+)\1\)/gi, b;
  while ((b = bg.exec(html)) && urls.length < 60) add(b[2]);
  var pl = /<link\b[^>]*>/gi, p;
  while ((p = pl.exec(html))) { var t = p[0]; if (/rel=["']?preload/i.test(t) && /as=["']?image/i.test(t)) add(htmlAttr(t, 'href')); }
  return urls;
}
// Fetch up to `want` real images (>= minBytes) from the candidate list.
function fetchGallery(urls, want, maxTry, minBytes, cb) {
  var out = [], i = 0, tries = 0;
  (function next() {
    if (out.length >= want || i >= urls.length || tries >= maxTry) return cb(out);
    var u = urls[i++]; tries++;
    fetchImageDataURL(u, 3 * 1024 * 1024, function (d) { if (d) out.push(d); next(); }, minBytes);
  })();
}
function composeBrief(site) {
  var p = ['Website: ' + site.finalUrl];
  if (site.siteName) p.push('Brand / site name: ' + site.siteName);
  if (site.title) p.push('Page title: ' + site.title);
  if (site.description) p.push('Meta description: ' + site.description);
  if (site.headings && site.headings.length) p.push('Key on-page headings: ' + site.headings.slice(0, 12).join(' | '));
  if (site.text) p.push('Page copy (excerpt): ' + site.text.slice(0, 2600));
  return p.join('\n');
}

/* ---- Design extraction --------------------------------------------------
   Read a site's OWN typography so a landing page can wear the same fonts and
   feel like part of the site. Best-effort: any failure just returns null and
   the landing falls back to its default stack. */
var ICON_FONT_RE = /icon|glyph|fontawesome|font\s*awesome|material|feather|ionicon|webflow-icons|entypo|linearicons/i;
// scraped design flows into a PUBLIC landing page's CSS — every field is
// sanitized to a canonical, injection-proof form (a hostile site must not be
// able to break out of url()/font-family/color into arbitrary CSS or JS).
function safeFontFamily(f) { return String(f || '').replace(/[^a-zA-Z0-9 ,"'\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120); }
function safeFontURL(u) { u = String(u || ''); return /^https?:\/\/[^\s"'()<>;\\]+\.(woff2|woff|ttf|otf)(\?[^\s"'()<>;\\]*)?$/i.test(u) ? u : null; }
function safeFontLink(u) { u = String(u || ''); return /^https:\/\/fonts\.googleapis\.com\/[^\s"'()<>;\\]*$/i.test(u) ? u : null; }
function safeWord(v, max) { return String(v || '').replace(/[^a-z0-9 ]/gi, '').trim().slice(0, max || 12); }
// any CSS colour → a canonical #rrggbb (or null); anchored so no trailing
// "#000;}evil{" or "rgb(0,0,0);x" can smuggle extra declarations through
function safeColor(v) {
  v = String(v || '').trim().toLowerCase();
  if (v === 'black') return '#000000'; if (v === 'white') return '#ffffff'; if (v === 'transparent') return null;
  var hm = /^#([0-9a-f]{3})$/i.exec(v) || /^#([0-9a-f]{6})$/i.exec(v);
  if (hm) { var h = hm[1]; if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join(''); return '#' + h.toLowerCase(); }
  var rm = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(v);
  if (rm) return '#' + [rm[1], rm[2], rm[3]].map(function (x) { return ('0' + Math.min(255, +x).toString(16)).slice(-2); }).join('');
  return null;
}
function colorLum(hex) { var h = hex.replace('#', ''); return 0.299 * parseInt(h.slice(0, 2), 16) + 0.587 * parseInt(h.slice(2, 4), 16) + 0.114 * parseInt(h.slice(4, 6), 16); }
// map of --custom-property → value (first definition wins), + a resolver that
// substitutes one level of var(--x[, fallback]) anywhere in a value
function cssVars(css) { var vars = {}, rv = /(--[a-z0-9_-]+)\s*:\s*([^;}]+)/gi, mv; while ((mv = rv.exec(css))) { var nm = mv[1].toLowerCase(); if (!vars[nm]) vars[nm] = mv[2].trim(); } return vars; }
function resolveVars(val, vars) { return String(val || '').replace(/var\(\s*(--[a-z0-9_-]+)\s*(?:,[^)]*)?\)/gi, function (_, n) { return vars[n.toLowerCase()] || ''; }); }
// gather all CSS the page applies: inline <style> blocks + the first 2 linked
// stylesheets (bounded), so @font-face/font-family declarations are visible
function collectCSS(html, baseUrl, cb) {
  var inline = '';
  var reS = /<style\b[^>]*>([\s\S]*?)<\/style>/gi, ms;
  while ((ms = reS.exec(html))) inline += '\n' + ms[1];
  var links = [], reL = /<link\b[^>]*>/gi, ml;
  while ((ml = reL.exec(html))) {
    var tag = ml[0];
    if (!/stylesheet/i.test(htmlAttr(tag, 'rel') || '')) continue;
    var href = htmlAttr(tag, 'href'); if (!href) continue;
    var a = absUrl(decodeEntities(href), baseUrl);
    if (a && /^https?:/i.test(a)) links.push(a);
  }
  links = links.slice(0, 2);
  if (!links.length) return cb(inline);
  var got = [], pending = links.length, done = false;
  var guard = setTimeout(function () { if (!done) { done = true; cb(inline + '\n' + got.join('\n')); } }, 8000);
  links.forEach(function (u) {
    httpGet(u, { accept: 'text/css,*/*', maxBytes: 800 * 1024, timeout: 6000 }, function (err, r) {
      if (!err && r && r.statusCode < 400) { try { got.push(r.body.toString('utf8')); } catch (e) {} }
      if (--pending === 0 && !done) { done = true; clearTimeout(guard); cb(inline + '\n' + got.join('\n')); }
    });
  });
}
// pull typography (fonts + stacks + hostable @font-face URLs) out of raw CSS
function extractDesign(html, css, base) {
  css = css || '';
  var fonts = [], seenFam = {};
  var famCount = {};   // cap faces PER family so we keep 400+500 but don't flood
  var reFace = /@font-face\s*\{([^}]*)\}/gi, mf;
  while ((mf = reFace.exec(css)) && fonts.length < 8) {
    var blk = mf[1];
    var fam = (/font-family\s*:\s*([^;]+)/i.exec(blk) || [])[1];
    if (!fam) continue;
    fam = fam.trim().replace(/^["']|["']$/g, '');
    if (!fam || ICON_FONT_RE.test(fam)) continue;
    var wt = ((/font-weight\s*:\s*([^;]+)/i.exec(blk) || [])[1] || '400').trim().slice(0, 12);
    var st = ((/font-style\s*:\s*([^;]+)/i.exec(blk) || [])[1] || 'normal').trim().slice(0, 10);
    var dedup = fam.toLowerCase() + '|' + wt + '|' + st;
    if (seenFam[dedup]) continue;
    // keep at most 3 weights of a given family (e.g. 400/500/700 — enough for body + headings)
    if ((famCount[fam.toLowerCase()] || 0) >= 3 && /normal/i.test(st)) continue;
    var srcs = blk.match(/url\(([^)]+)\)/gi) || [], furl = null;
    for (var i = 0; i < srcs.length; i++) {
      var u = srcs[i].replace(/url\(|\)|["']/gi, '').trim();
      if (/^data:/i.test(u)) continue;
      if (/\.(woff2|woff|ttf|otf)(\?|#|$)/i.test(u)) { furl = safeFontURL(absUrl(u, base)); if (furl) break; }
    }
    var safeFam = safeFontFamily(fam);
    if (!furl || !safeFam) continue;
    fonts.push({ family: safeFam, url: furl, weight: safeWord(wt, 12) || '400', style: safeWord(st, 10) || 'normal' });
    seenFam[dedup] = 1; famCount[fam.toLowerCase()] = (famCount[fam.toLowerCase()] || 0) + 1;
  }
  var fontLinks = [], seenL = {};
  var reGf = /<link\b[^>]*href=["']([^"']*fonts\.googleapis[^"']*)["'][^>]*>/gi, mg;
  while ((mg = reGf.exec(html))) { var g = safeFontLink(decodeEntities(mg[1])); if (g && !seenL[g]) { seenL[g] = 1; fontLinks.push(g); } }
  var reImp = /@import\s+(?:url\()?\s*["']?([^"')]*fonts\.googleapis[^"')]*)/gi, mi;
  while ((mi = reImp.exec(css))) { var gi = safeFontLink(mi[1].trim()); if (gi && !seenL[gi]) { seenL[gi] = 1; fontLinks.push(gi); } }
  function famOf(sel) {
    var m = new RegExp('(?:^|[},])\\s*' + sel + '\\s*\\{([^}]*)\\}', 'i').exec(css);
    if (!m) return null;
    var f = (/font-family\s*:\s*([^;}]+)/i.exec(m[1]) || [])[1];
    return f ? f.trim() : null;
  }
  var bodyRaw = famOf('body') || famOf('html');
  if (!bodyRaw) {
    var counts = {}, all = css.match(/font-family\s*:\s*([^;}]+)/gi) || [];
    all.forEach(function (d) { var f = d.replace(/font-family\s*:\s*/i, '').trim(); if (f && !ICON_FONT_RE.test(f)) counts[f] = (counts[f] || 0) + 1; });
    bodyRaw = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0] || null;
  }
  var headRaw = famOf('h1') || famOf('h1,\\s*h2,\\s*h3') || famOf('h2') || bodyRaw;
  // resolve the declared stack (substitute var(--x)); if it still references an
  // unresolved var or is empty, it's unusable
  var vmap = cssVars(css);
  function usableFam(raw) { if (!raw) return null; var r = safeFontFamily(resolveVars(raw, vmap)); return (!r || /var/i.test(r)) ? null : r; }
  // the site's DISTINCTIVE face (an actual @font-face we can load) — prefer the
  // family whose name the declaration references, else a non-mono/code face
  function primaryFam(prefer) {
    if (!fonts.length) return null;
    var pl = String(prefer || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (pl) { var hit = fonts.filter(function (f) { return pl.indexOf(f.family.toLowerCase().replace(/[^a-z0-9]/g, '')) >= 0; })[0]; if (hit) return hit.family; }
    var b = fonts.filter(function (f) { return !/mono|code|icon/i.test(f.family); })[0];
    return (b || fonts[0]).family;
  }
  // lead with the real loaded font (so it actually applies), else the declared stack
  var bodyFont = (fonts.length ? primaryFam(bodyRaw) : null) || usableFam(bodyRaw) || null;
  var headingFont = (fonts.length ? primaryFam(headRaw) : null) || usableFam(headRaw) || bodyFont;
  var scheme = extractScheme(html, css);
  if (!fonts.length && !fontLinks.length && !bodyFont && !scheme) return null;
  return {
    fonts: fonts, fontLinks: fontLinks.slice(0, 4),
    bodyFont: bodyFont, headingFont: headingFont,
    dark: scheme ? scheme.dark : null,
    bg: scheme ? scheme.bg : null,
    text: scheme ? scheme.text : null
  };
}
// The site's REAL page background + text: read the <body> tag's classes and
// resolve their CSS (incl. one level of `var(--x)`), falling back to body/html
// rules. Frequency-counting CSS colours is misleading (framework defaults win),
// so we follow what actually paints the page. Colours are canonicalised to safe
// hex (safeColor). → { dark, bg, text } | null
function extractScheme(html, css) {
  var vars = {}, rv = /(--[a-z0-9_-]+)\s*:\s*([^;}]+)/gi, mv;
  while ((mv = rv.exec(css))) { var nm = mv[1].toLowerCase(); if (!vars[nm]) vars[nm] = mv[2].trim(); }
  function resolve(val) {
    if (!val) return null; val = String(val).trim();
    var m = /var\(\s*(--[a-z0-9_-]+)/i.exec(val);
    if (m) return vars[m[1].toLowerCase()] || null;
    return val;
  }
  function ruleOf(sel) { var m = new RegExp('(?:^|[},])\\s*' + sel + '\\s*\\{([^}]*)\\}', 'i').exec(css); return m ? m[1] : null; }
  function bgOf(blk) { return (/background(?:-color)?\s*:\s*([^;}]+)/i.exec(blk || '') || [])[1]; }
  function fgOf(blk) { return (/(?:^|[;{\s])color\s*:\s*([^;}]+)/i.exec(blk || '') || [])[1]; }
  var bg = null, fg = null;
  var bodyTag = (/<body[^>]*>/i.exec(html) || [])[0] || '';
  var classes = (htmlAttr(bodyTag, 'class') || '').split(/\s+/).filter(Boolean);
  classes.forEach(function (cls) {
    if (bg) return;
    var safe = cls.replace(/[^a-z0-9_-]/gi, ''); if (!safe) return;
    var blk = ruleOf('\\.' + safe);
    var b = bgOf(blk); if (b) { bg = resolve(b); var c = fgOf(blk); if (c && !fg) fg = resolve(c); }
  });
  ['body', 'html'].forEach(function (sel) {
    var blk = ruleOf(sel); if (!blk) return;
    if (!bg) { var b = bgOf(blk); if (b) bg = resolve(b); }
    if (!fg) { var c = fgOf(blk); if (c) fg = resolve(c); }
  });
  var sbg = safeColor(bg); if (!sbg) return null;
  return { dark: colorLum(sbg) < 118, bg: sbg, text: safeColor(fg) };
}

/* ---- Ad tracking (public collector) --------------------------------------
   The measurement pipeline for posted ads. Every downloaded ad carries a
   tracked link  /a/<adKey>  → 302 to its published landing page  /p/<slug>/
   (+ ?aid= so the page's beacon attributes the visit to that exact ad); the
   beacon POSTs to /t. Events are appended to data/track/events-YYYY-MM.jsonl
   — no cookies, no IPs, no raw user agents stored.
   TRACK_ONLY=1 runs this server as a bare public collector (office-server
   deploy): ONLY the tracking routes answer; the app, store, key and project
   files are unreachable. Remote admin calls authenticate with the token in
   data/track/token.key (auto-generated); local app calls use the app header. */
var TRACK_ONLY = process.env.TRACK_ONLY === '1';
var TRACK_DIR = path.join(ROOT, 'data', 'track');
var TRACK_PAGES = path.join(TRACK_DIR, 'pages');
var TRACK_TOKEN_FILE = path.join(TRACK_DIR, 'token.key');

var trackTokenCache = '';
function trackToken() {
  if (trackTokenCache) return trackTokenCache;
  try { trackTokenCache = fs.readFileSync(TRACK_TOKEN_FILE, 'utf8').trim(); } catch (e) {}
  if (!trackTokenCache) {
    trackTokenCache = crypto.randomBytes(24).toString('hex');
    try { fs.mkdirSync(TRACK_DIR, { recursive: true }); fs.writeFileSync(TRACK_TOKEN_FILE, trackTokenCache); } catch (e) {}
  }
  return trackTokenCache;
}
function requireTrackAuth(req, res) {
  // the local app is trusted via its CSRF header; remote sync (the office
  // deployment) must present the bearer token — compared constant-time
  if (!TRACK_ONLY && req.headers['x-ads-hub']) return true;
  var h = String(req.headers.authorization || '');
  var tok = h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : '';
  var want = trackToken();
  var a = Buffer.from(tok), b = Buffer.from(want);
  if (tok && a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  sendJSON(res, 403, { error: 'forbidden' });
  return false;
}

// ad-key / page-slug shape (also what the client generates): url-safe, short
function cleanKey(s) {
  s = String(s || '').toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(s) ? s : null;
}
function cleanSrc(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16); }
function uaClass(ua) { return /mobile|iphone|android|ipad/i.test(String(ua || '')) ? 'm' : 'd'; }
function hostOf(u) { try { return new URL(String(u)).hostname.slice(0, 80); } catch (e) { return ''; } }

// the real client IP. Behind the office-server proxy (TRACK_ONLY, Caddy →
// loopback) every socket is 127.0.0.1, so the per-IP rate limit would collapse
// to ONE global bucket. Only there — where a single trusted proxy sets it — do
// we read X-Forwarded-For, taking the RIGHT-MOST hop (the address the proxy
// itself observed; left-most entries are client-spoofable). Local loopback
// mode never trusts the header.
function clientIP(req) {
  // ADS_BEHIND_PROXY: the archi docker instance sits behind ads_gate +
  // cloudflared — every socket is the gate, so trust XFF there too
  if (TRACK_ONLY || process.env.ADS_BEHIND_PROXY) {
    var xff = String(req.headers['x-forwarded-for'] || '');
    if (xff) { var hops = xff.split(',').map(function (s) { return s.trim(); }).filter(Boolean); if (hops.length) return hops[hops.length - 1]; }
  }
  return req.socket.remoteAddress || '?';
}

// simple fixed-window rate limit per ip+bucket — this surface will be public.
// rlMap is capped so a flood of distinct IPs (e.g. an IPv6 /64 sweep) can't
// grow it without bound between sweeps.
var rlMap = new Map();
var RL_MAX = 20000;
function rateOK(req, bucket, perMin) {
  var k = bucket + '|' + clientIP(req);
  var now = Date.now();
  var e = rlMap.get(k);
  if (!e || now - e.t0 > 60000) {
    if (rlMap.size > RL_MAX) rlMap.clear();   // hard backstop against unbounded growth
    e = { t0: now, n: 0 }; rlMap.set(k, e);
  }
  return ++e.n <= perMin;
}
setInterval(function () {
  var now = Date.now();
  rlMap.forEach(function (e, k) { if (now - e.t0 > 120000) rlMap.delete(k); });
}, 60000).unref();

// manifest: adKey → {slug, name, headline} (which page each tracked ad opens)
var trackMan = null;
function trackManifest() {
  if (trackMan) return trackMan;
  try { trackMan = JSON.parse(fs.readFileSync(path.join(TRACK_DIR, 'manifest.json'), 'utf8')); } catch (e) { trackMan = null; }
  if (!trackMan || typeof trackMan !== 'object' || typeof trackMan.ads !== 'object' || !trackMan.ads) trackMan = { ads: {} };
  return trackMan;
}
function saveTrackManifest() {
  try {
    fs.mkdirSync(TRACK_DIR, { recursive: true });
    fs.writeFileSync(path.join(TRACK_DIR, 'manifest.json'), JSON.stringify(trackManifest()));
  } catch (e) { console.error('[track] manifest save failed:', e.message); }
}
function trackLog(ev) {
  ev.ts = Date.now();
  var f = path.join(TRACK_DIR, 'events-' + new Date().toISOString().slice(0, 7) + '.jsonl');
  fs.mkdir(TRACK_DIR, { recursive: true }, function () {
    fs.appendFile(f, JSON.stringify(ev) + '\n', function (e) { if (e) console.error('[track] log failed:', e.message); });
  });
}

// fold every event file into per-ad + per-page aggregates; cached by the
// concatenated (name:size) signature so repeat calls don't re-read anything.
// The manifest's (mtime:size) is folded into the signature too — a republish
// changes only manifest.json, and the cached output bakes in its names/slugs,
// so without this the stats would show stale labels until the next event.
var statsCache = { sig: '', out: null };
function trackStats(cb) {
  fs.readdir(TRACK_DIR, function (err, names) {
    var files = (names || []).filter(function (n) { return /^events-\d{4}-\d{2}\.jsonl$/.test(n); }).sort();
    var sig = '';
    try { var ms = fs.statSync(path.join(TRACK_DIR, 'manifest.json')); sig += 'man:' + ms.mtimeMs + ':' + ms.size + ';'; } catch (e) { sig += 'man:0;'; }
    var i = 0;
    (function statNext() {
      if (i < files.length) {
        var fp = path.join(TRACK_DIR, files[i]);
        return fs.stat(fp, function (e2, st) { sig += files[i] + ':' + (st ? st.size : 0) + ';'; i++; statNext(); });
      }
      if (sig === statsCache.sig && statsCache.out) return cb(null, statsCache.out);
      var ads = {}, pages = {};
      function slot(map, k) {
        return map[k] || (map[k] = { clicks: 0, views: 0, seconds: 0, outs: 0, vids: {}, scrollSum: 0, scrollN: 0, bySrc: {} });
      }
      // bound source cardinality: a hostile client can rotate through unlimited
      // ?s= values; keep the first N distinct, lump the rest into 'other'
      function bumpSrc(a, s) {
        if (!s) return;
        if (a.bySrc[s] === undefined && Object.keys(a.bySrc).length >= 24) s = 'other';
        a.bySrc[s] = (a.bySrc[s] || 0) + 1;
      }
      var j = 0;
      (function readNext() {
        if (j >= files.length) {
          var man = trackManifest();
          function finish(map, meta) {
            var out = {};
            Object.keys(map).forEach(function (k) {
              var a = map[k];
              var uniques = Object.keys(a.vids).length;
              out[k] = {
                clicks: a.clicks, views: a.views, uniques: uniques,
                seconds: a.seconds,
                avgSeconds: a.views ? Math.round(a.seconds / Math.max(uniques, 1)) : 0,
                outs: a.outs,
                outRate: a.views ? +(a.outs / a.views).toFixed(3) : 0,
                scrollAvg: a.scrollN ? Math.round(a.scrollSum / a.scrollN) : 0,
                bySrc: a.bySrc
              };
              if (meta && man.ads[k]) { out[k].name = man.ads[k].name; out[k].headline = man.ads[k].headline; out[k].page = man.ads[k].slug; }
            });
            return out;
          }
          var result = { ads: finish(ads, true), pages: finish(pages, false), generatedAt: Date.now() };
          statsCache.sig = sig; statsCache.out = result;
          return cb(null, result);
        }
        fs.readFile(path.join(TRACK_DIR, files[j]), 'utf8', function (e3, txt) {
          j++;
          (txt || '').split('\n').forEach(function (line) {
            if (!line) return;
            var ev; try { ev = JSON.parse(line); } catch (e4) { return; }
            var byAd = ev.k ? slot(ads, ev.k) : null;
            var byPg = ev.pg ? slot(pages, ev.pg) : null;
            [byAd, byPg].forEach(function (a) {
              if (!a) return;
              if (ev.t === 'click') { a.clicks++; bumpSrc(a, ev.s); }
              else if (ev.t === 'view') { a.views++; if (ev.v) a.vids[ev.v] = 1; bumpSrc(a, ev.s); }
              // one honest heartbeat is 5s; cap at 10 so a spoofed beat can't
              // over-report dwell time (was 30 = a silent 6× inflation lever)
              else if (ev.t === 'beat') { a.seconds += Math.max(0, Math.min(10, +ev.sec || 0)); if (ev.pct) { a.scrollSum += Math.min(100, +ev.pct); a.scrollN++; } }
              else if (ev.t === 'out') a.outs++;
            });
          });
          readNext();
        });
      })();
    })();
  });
}

// CORS for the ANONYMOUS beacon only (/t). It deliberately does NOT list
// X-Ads-Hub: admitting that header cross-origin would let any web page pass a
// preflight and POST it to the local app, defeating the app-header CSRF guard
// (requireAppHeader relies on X-Ads-Hub being un-sendable cross-site). The
// beacon needs no auth header at all — just JSON from any landing-page origin.
var TRACK_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
// Admin endpoints (publish/stats) authenticate with the Bearer token only.
// A cross-origin remote-sync client (the future office deploy) preflights for
// Authorization — allowed here — but never for X-Ads-Hub, so the local
// same-origin app (which sends X-Ads-Hub with no preflight) stays reachable
// while a foreign page carrying X-Ads-Hub is blocked at the preflight.
var ADMIN_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

// → true when the request was handled here
function handleTracking(req, res, pathname, parsed) {
  // tracked ad link: log the click, hand off to the ad's landing page
  if (pathname.indexOf('/a/') === 0 && req.method === 'GET') {
    if (!rateOK(req, 'a', 240)) return send(res, 429, 'Too many requests'), true;
    var akey = cleanKey(safeDecode(pathname.slice(3)));
    var entry = akey && trackManifest().ads[akey];
    if (!entry) return send(res, 404, 'Unknown link'), true;
    var src = cleanSrc(parsed.query.s);
    trackLog({ t: 'click', k: akey, pg: entry.slug, s: src, ref: hostOf(req.headers.referer), ua: uaClass(req.headers['user-agent']) });
    var loc = '/p/' + entry.slug + '/?aid=' + akey + (src ? '&s=' + src : '');
    return send(res, 302, 'Redirecting…', { Location: loc, 'Cache-Control': 'no-store' }), true;
  }

  // published landing pages (self-contained html; assets allowed for later)
  if (pathname.indexOf('/p/') === 0 && req.method === 'GET') {
    var segs = pathname.split('/').filter(Boolean);            // ['p', slug, file?]
    var slug = cleanKey(safeDecode(segs[1] || ''));
    if (!slug || segs.length > 3) return send(res, 404, 'Not found'), true;
    if (segs.length === 2 && pathname.slice(-1) !== '/') {     // keep relative URLs sane
      return send(res, 302, '', { Location: '/p/' + slug + '/' + (url.parse(req.url).search || '') }), true;
    }
    var file = segs.length === 3 ? safeDecode(segs[2]) : 'index.html';
    if (file == null || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(file) || file.indexOf('..') >= 0) return send(res, 404, 'Not found'), true;
    var fp = path.normalize(path.join(TRACK_PAGES, slug, file));
    if (fp.indexOf(TRACK_PAGES) !== 0) return send(res, 403, 'Forbidden'), true;
    fs.readFile(fp, function (err, buf) {
      if (err) return send(res, 404, 'Not found');
      send(res, 200, buf, {
        'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'origin'
      });
    });
    return true;
  }

  // staged ad media for Instagram publishing — Meta's servers fetch these
  // (public by design, like /a/ and /p/; filenames are unguessable time-ids)
  if (pathname.indexOf('/pub/') === 0 && req.method === 'GET') {
    if (!rateOK(req, 'pub', 300)) return send(res, 429, 'Too many requests'), true;
    var pubName = safeDecode(pathname.slice(5));
    if (pubName == null || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(pubName) || pubName.indexOf('..') >= 0) {
      return send(res, 404, 'Not found'), true;
    }
    return serveFileRange(req, res, path.join(PUB_DIR, pubName)), true;
  }

  // beacon ingest — tiny, anonymous, rate-limited
  if (pathname === '/t') {
    if (req.method === 'OPTIONS') return send(res, 204, '', TRACK_CORS), true;
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed', TRACK_CORS), true;
    if (!rateOK(req, 't', 240)) return send(res, 429, '', TRACK_CORS), true;
    readBody(req, function (raw) {
      if (raw == null) return send(res, 413, '', TRACK_CORS);
      var b; try { b = JSON.parse(raw); } catch (e) { return send(res, 400, '', TRACK_CORS); }
      var t = String(b.t || '');
      if (t !== 'view' && t !== 'beat' && t !== 'out') return send(res, 400, '', TRACK_CORS);
      var ev = {
        t: t,
        k: cleanKey(b.aid) || '',
        pg: cleanKey(b.page) || '',
        s: cleanSrc(b.s),
        v: String(b.vid || '').replace(/[^a-z0-9]/gi, '').slice(0, 16),
        ua: uaClass(req.headers['user-agent'])
      };
      if (!ev.k && !ev.pg) return send(res, 400, '', TRACK_CORS);
      if (t === 'beat') {
        ev.sec = Math.max(0, Math.min(10, Math.round(+b.sec || 0)));   // honest beat = 5s; 10 caps spoofing
        var pct = Math.max(0, Math.min(100, Math.round(+b.pct || 0)));
        if (pct) ev.pct = pct;
      }
      if (t === 'view') ev.ref = hostOf(b.ref);
      if (t === 'out') ev.h = hostOf(b.href);                  // destination HOST only
      trackLog(ev);
      send(res, 204, '', TRACK_CORS);
    }, 4096);
    return true;
  }

  if (pathname === '/api/track/health' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, publicMode: TRACK_ONLY, ads: Object.keys(trackManifest().ads).length }), true;
  }

  // publish preflight: Authorization only (NEVER X-Ads-Hub) — see ADMIN_CORS
  if (pathname === '/api/track/publish' && req.method === 'OPTIONS') {
    return send(res, 204, '', ADMIN_CORS), true;
  }
  // publish a landing page + register which ads point at it
  if (pathname === '/api/track/publish' && req.method === 'POST') {
    if (!rateOK(req, 'admin', 120)) return send(res, 429, '', ADMIN_CORS), true;
    if (!requireTrackAuth(req, res)) return true;
    readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large', message: Math.round(overSize / 1e6) + 'MB page — over the 25MB cap' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var slug = cleanKey(input.slug);
      var html = typeof input.html === 'string' ? input.html : '';
      if (!slug || !html) return sendJSON(res, 400, { error: 'bad_args', message: 'slug and html are required' });
      var dir = path.join(TRACK_PAGES, slug);
      fs.mkdir(dir, { recursive: true }, function (mkErr) {
        if (mkErr) return sendJSON(res, 500, { error: 'mkdir', message: String(mkErr.message) });
        fs.writeFile(path.join(dir, 'index.html'), html, function (wErr) {
          if (wErr) return sendJSON(res, 500, { error: 'write', message: String(wErr.message) });
          var man = trackManifest(), n = 0;
          (Array.isArray(input.ads) ? input.ads : []).slice(0, 200).forEach(function (a) {
            var k = cleanKey(a && a.key);
            if (!k) return;
            man.ads[k] = {
              slug: slug,
              name: String((a && a.name) || '').slice(0, 120),
              headline: String((a && a.headline) || '').slice(0, 160),
              createdAt: man.ads[k] ? man.ads[k].createdAt : Date.now()
            };
            n++;
          });
          saveTrackManifest();
          sendJSON(res, 200, { ok: true, url: '/p/' + slug + '/', ads: n });
        });
      });
    }, 25 * 1024 * 1024);
    return true;
  }
  if (pathname === '/api/track/publish' && req.method === 'OPTIONS') {
    return send(res, 204, '', TRACK_CORS), true;
  }

  // aggregated per-ad / per-page numbers (the Performance tab reads this)
  if (pathname === '/api/track/stats' && req.method === 'GET') {
    if (!rateOK(req, 'admin', 120)) return send(res, 429, ''), true;
    if (!requireTrackAuth(req, res)) return true;
    trackStats(function (err, out) {
      if (err) return sendJSON(res, 500, { error: 'stats', message: String(err.message || err) });
      sendJSON(res, 200, out);
    });
    return true;
  }

  // the sync token, so the user can copy it into a future remote setup
  if (pathname === '/api/track/token' && req.method === 'GET') {
    if (TRACK_ONLY) return send(res, 404, 'Not found'), true;   // never over the public surface
    if (!requireTrackAuth(req, res)) return true;
    return sendJSON(res, 200, { token: trackToken() }), true;
  }

  return false;
}

/* ---- Router -------------------------------------------------------------- */
var server = http.createServer(function (req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;

  // public-collector mode: ONLY the tracking surface exists — the app, the
  // store, the API key and project files must be unreachable from the internet
  if (TRACK_ONLY) {
    if (handleTracking(req, res, pathname, parsed)) return;
    return send(res, 404, 'Not found');
  }
  if (handleTracking(req, res, pathname, parsed)) return;

  // --- AI status ---
  // every paid / state-changing POST requires the app header — cross-site
  // simple requests must not be able to burn the user's API key
  if (req.method === 'POST' && (pathname.indexOf('/api/ai/') === 0 || pathname === '/api/scrape')) {
    if (!requireAppHeader(req, res)) return;
  }

  if (pathname === '/api/ai/status' && req.method === 'GET') {
    return sendJSON(res, 200, { enabled: !!effectiveKey(), model: MODEL, source: keySource() });
  }

  // --- Render self-diagnostics: every client reports how the saved-ads shelf
  // actually rendered on ITS machine (browser, iframe, images decoded, canvas
  // painted, stage scales). Read data/track/diag.jsonl to debug "renders for
  // me but not for them" without access to the other person's browser.
  if (pathname === '/api/diag' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    return readBody(req, function (raw, overSize) {
      if (overSize) return sendJSON(res, 413, { error: 'too_big' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var line = JSON.stringify({ at: new Date().toISOString(), d: input }).slice(0, 8000);
      var f = path.join(TRACK_DIR, 'diag.jsonl');
      fs.mkdir(TRACK_DIR, { recursive: true }, function () {
        fs.stat(f, function (serr, st) {
          if (!serr && st.size > 5 * 1024 * 1024) { try { fs.renameSync(f, f + '.1'); } catch (e) {} }
          fs.appendFile(f, line + '\n', function () { sendJSON(res, 200, { ok: true }); });
        });
      });
    }, 64 * 1024);
  }

  // --- Set / clear the API key (persisted to a local file so it survives restarts) ---
  if (pathname === '/api/ai/key' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    return readBody(req, function (raw) {
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (API_KEY) return sendJSON(res, 200, { enabled: true, source: 'env', note: 'A server key is already set via ANTHROPIC_API_KEY.' });
      var k = String(input.key || '').trim();
      if (k && (k.length < 20 || /\s/.test(k))) return sendJSON(res, 400, { error: 'bad_key', message: 'That doesn’t look like a valid API key.' });
      runtimeKey = k;
      if (!k) {
        // clearing: forget the saved key too
        keyPersisted = false;
        return fs.unlink(KEY_FILE, function () { sendJSON(res, 200, { enabled: false, source: 'none' }); });
      }
      return fs.mkdir(path.dirname(KEY_FILE), { recursive: true }, function () {
        fs.writeFile(KEY_FILE, k, function (werr) {
          keyPersisted = !werr;
          sendJSON(res, 200, { enabled: true, source: keySource(), persisted: !werr });
        });
      });
    });
  }

  // --- Nano Banana (Gemini) image key: status + set/clear ---
  if (pathname === '/api/gemini/status' && req.method === 'GET') {
    return sendJSON(res, 200, { enabled: !!effectiveGeminiKey(), source: geminiKeySource(), model: GEMINI_IMAGE_MODEL, ok: !geminiLastError, error: geminiLastError || '' });
  }
  // Explicit re-check of the saved key (free ListModels call) → refreshes status
  if (pathname === '/api/gemini/verify' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    if (!effectiveGeminiKey()) return sendJSON(res, 200, { enabled: false, ok: false, error: 'No key set.' });
    return geminiVerify(function (verr) { sendJSON(res, 200, { enabled: true, ok: !verr, error: verr ? verr.message : '' }); });
  }
  if (pathname === '/api/gemini/key' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    return readBody(req, function (raw) {
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (GEMINI_API_KEY) return sendJSON(res, 200, { enabled: true, source: 'env', note: 'A server key is already set via GEMINI_API_KEY.' });
      var k = String(input.key || '').trim();
      if (k && (k.length < 20 || /\s/.test(k))) return sendJSON(res, 400, { error: 'bad_key', message: 'That doesn’t look like a valid Google API key.' });
      geminiRuntimeKey = k;
      if (!k) { geminiKeyPersisted = false; geminiLastError = ''; return fs.unlink(GEMINI_KEY_FILE, function () { sendJSON(res, 200, { enabled: false, source: 'none' }); }); }
      geminiLastError = '';
      return fs.mkdir(path.dirname(GEMINI_KEY_FILE), { recursive: true }, function () {
        fs.writeFile(GEMINI_KEY_FILE, k, function (werr) {
          geminiKeyPersisted = !werr;
          // verify against Google right away so the user learns immediately if the
          // key is blocked/restricted, instead of discovering it after a generation
          geminiVerify(function (verr) {
            sendJSON(res, 200, { enabled: true, source: geminiKeySource(), persisted: !werr, verified: !verr, ok: !verr, error: verr ? verr.message : '' });
          });
        });
      });
    });
  }
  // --- Instagram connection: status + set/clear token + verify --------------
  if (pathname === '/api/meta/status' && req.method === 'GET') {
    return sendJSON(res, 200, {
      enabled: !!effectiveIgToken(), source: igTokenSource(),
      username: (igUser && igUser.username) || '',
      ok: !igLastError, error: igLastError || '', publicBase: PUBLIC_BASE
    });
  }
  if (pathname === '/api/meta/verify' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    if (!effectiveIgToken()) return sendJSON(res, 200, { enabled: false, ok: false, error: 'No Instagram token set.' });
    return igVerify(function (verr, u) {
      sendJSON(res, 200, { enabled: true, ok: !verr, username: (u && u.username) || '', error: verr ? verr.message : '' });
    });
  }
  if (pathname === '/api/meta/key' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large' });   // an oversized body must NOT read as "clear the token"
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (IG_ENV_TOKEN) return sendJSON(res, 200, { enabled: true, source: 'env', note: 'A token is already set via IG_ACCESS_TOKEN.' });
      // copying from Meta's token dialog often drags along line breaks, spaces
      // or quotes — clean them instead of rejecting the paste
      var k = String(input.key || '').replace(/["'“”]/g, '').replace(/\s+/g, '');
      if (k && k.length < 30) return sendJSON(res, 400, { error: 'bad_key', message: 'That token looks too short — copy the entire IGAA… string from the Generate token dialog.' });
      igRuntimeToken = k;
      if (!k) { igTokenPersisted = false; igLastError = ''; igUser = null; return fs.unlink(IG_TOKEN_FILE, function () { sendJSON(res, 200, { enabled: false, source: 'none' }); }); }
      igLastError = '';
      return fs.mkdir(path.dirname(IG_TOKEN_FILE), { recursive: true }, function () {
        fs.writeFile(IG_TOKEN_FILE, k, function (werr) {
          igTokenPersisted = !werr;
          // verify immediately so the user learns right away if the token is bad
          igVerify(function (verr, u) {
            sendJSON(res, 200, { enabled: true, source: igTokenSource(), persisted: !werr, ok: !verr, username: (u && u.username) || '', error: verr ? verr.message : '' });
          });
        });
      });
    });
  }
  // Stage a rendered creative at a public URL so Meta's servers can fetch it.
  if (pathname === '/api/meta/stage' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    if (!rateOK(req, 'stage', 12)) return sendJSON(res, 429, { error: 'rate_limited' });
    var stName = safeSeg(parsed.query.name).slice(0, 80);   // /pub/ route caps full names at 120 chars incl. the prefix
    if (!stName || stName === '_') return sendJSON(res, 400, { error: 'bad_args', message: 'name is required' });
    stName = Date.now().toString(36) + crypto.randomBytes(6).toString('hex') + '-' + stName;
    return fs.mkdir(PUB_DIR, { recursive: true }, function (mkErr) {
      if (mkErr) return sendJSON(res, 500, { error: 'mkdir', message: String(mkErr.message) });
      // staged files are transient (Meta fetches within minutes) — a tight
      // aggregate quota keeps a bug or abuse from filling the disk
      fs.readdir(PUB_DIR, function (rdErr, names) {
        if (!rdErr && names.length > 80) return sendJSON(res, 507, { error: 'pub_full', message: 'Too many staged files — try again in an hour (they clean up automatically).' });
        var stPath = path.join(PUB_DIR, stName);
        var stOut = fs.createWriteStream(stPath);
        var stSize = 0, stAborted = false;
        req.on('data', function (c) {
          stSize += c.length;
          if (stSize > 310 * 1024 * 1024) { stAborted = true; req.destroy(); stOut.destroy(); fs.unlink(stPath, function () {}); }
        });
        req.pipe(stOut);
        stOut.on('finish', function () {
          if (stAborted) return;
          sendJSON(res, 200, { ok: true, url: '/pub/' + stName, publicURL: PUBLIC_BASE + '/pub/' + stName, bytes: stSize });
        });
        stOut.on('error', function (e) { if (!stAborted) sendJSON(res, 500, { error: 'write', message: String(e.message) }); });
        req.on('error', function () { stOut.destroy(); fs.unlink(stPath, function () {}); });
      });
    });
  }
  // Publish one staged creative to the connected Instagram account.
  // ASYNC: reels take minutes to process, far past Cloudflare's ~100s proxy
  // limit — so this returns a job id immediately and the client polls
  // /api/meta/post-status. Jobs are idempotent on input.idem (adKey+round):
  // a retry while one is running (or after success) returns the SAME job,
  // so a proxy-killed response can never cause a duplicate Instagram post.
  if (pathname === '/api/meta/post' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    if (!effectiveIgToken()) return sendJSON(res, 501, { error: 'no_ig_token', message: 'Connect Instagram first (Performance → Instagram).' });
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var kind = input.kind === 'video' ? 'video' : 'image';
      var rel = String(input.url || '');
      if (rel.indexOf('/pub/') !== 0 || rel.indexOf('..') >= 0) return sendJSON(res, 400, { error: 'bad_url', message: 'url must be a staged /pub/ path' });
      var caption = String(input.caption || '').slice(0, 2200);
      var idem = String(input.idem || '').slice(0, 120);
      if (idem && igJobs[idem] && igJobs[idem].state !== 'error') {
        return sendJSON(res, 200, { ok: true, job: idem, state: igJobs[idem].state });
      }
      var jobId = idem || ('job-' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'));
      igJobs[jobId] = { state: 'running', at: Date.now() };
      igPublish(kind, PUBLIC_BASE + rel, caption, function (err, out) {
        var j = igJobs[jobId]; if (!j) return;
        if (err) { j.state = 'error'; j.error = err.message; }
        else {
          j.state = 'done'; j.mediaId = out.mediaId; j.permalink = out.permalink;
          fs.unlink(path.join(PUB_DIR, rel.slice(5)), function () {});   // Meta has ingested it
        }
      });
      sendJSON(res, 200, { ok: true, job: jobId, state: 'running' });
    }, 64 * 1024);
  }
  if (pathname === '/api/meta/post-status' && req.method === 'GET') {
    if (!requireAppHeader(req, res)) return;
    var jq = String(parsed.query.job || '').slice(0, 120);
    var job = igJobs[jq];
    if (!job) return sendJSON(res, 404, { error: 'unknown_job' });
    return sendJSON(res, 200, { ok: true, state: job.state, mediaId: job.mediaId || '', permalink: job.permalink || '', error: job.error || '' });
  }
  // Per-post insights for published media ids.
  if (pathname === '/api/meta/insights' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    if (!effectiveIgToken()) return sendJSON(res, 501, { error: 'no_ig_token' });
    return readBody(req, function (raw) {
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var ids = (Array.isArray(input.ids) ? input.ids : []).slice(0, 60).map(String);
      if (!ids.length) return sendJSON(res, 400, { error: 'bad_args', message: 'ids required' });
      var tok = effectiveIgToken(), byId = {}, i = 0;
      (function next() {
        if (i >= ids.length) return sendJSON(res, 200, { ok: true, byId: byId, at: new Date().toISOString() });
        var id = ids[i++];
        igRequest('GET', '/' + id + '/insights', { metric: 'views,reach,likes,comments,saved,shares,total_interactions', access_token: tok }, function (err, j) {
          if (err) { byId[id] = { error: err.message.slice(0, 200) }; return next(); }
          var m = {};
          (j.data || []).forEach(function (row) {
            var v = row.values && row.values[0] ? row.values[0].value : null;
            if (row.name && v != null) m[row.name] = v;
          });
          byId[id] = m;
          next();
        });
      })();
    }, 64 * 1024);
  }

  // --- Dark ads (Meta Marketing API): status + token + config + run + insights
  if (pathname === '/api/mads/status' && req.method === 'GET') {
    return sendJSON(res, 200, {
      enabled: !!effectiveMadsToken(), source: madsTokenSource(),
      ok: !madsLastError, error: madsLastError || '',
      conf: madsConf ? {
        user: madsConf.user || '', adAccountId: madsConf.adAccountId || '', adAccountName: madsConf.adAccountName || '',
        currency: madsConf.currency || 'USD', pageId: madsConf.pageId || '', pageName: madsConf.pageName || '',
        igUsername: madsConf.igUsername || '', accounts: madsConf.accounts || [], pages: madsConf.pages || []
      } : null
    });
  }
  if (pathname === '/api/mads/key' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (MADS_ENV_TOKEN) return sendJSON(res, 200, { enabled: true, source: 'env' });
      var k = String(input.key || '').replace(/["'“”]/g, '').replace(/\s+/g, '');
      if (k && k.length < 30) return sendJSON(res, 400, { error: 'bad_key', message: 'That token looks too short — copy the whole System User token.' });
      madsRuntimeToken = k;
      if (!k) { madsTokenPersisted = false; madsLastError = ''; madsConf = null; fs.unlink(MADS_CONF_FILE, function () {}); return fs.unlink(MADS_TOKEN_FILE, function () { sendJSON(res, 200, { enabled: false, source: 'none' }); }); }
      madsLastError = '';
      return fs.mkdir(path.dirname(MADS_TOKEN_FILE), { recursive: true }, function () {
        fs.writeFile(MADS_TOKEN_FILE, k, function (werr) {
          madsTokenPersisted = !werr;
          madsVerify(function (verr, conf) {
            sendJSON(res, 200, { enabled: true, source: madsTokenSource(), persisted: !werr, ok: !verr, error: verr ? verr.message : '', conf: conf || null });
          });
        });
      });
    }, 16 * 1024);
  }
  if (pathname === '/api/mads/verify' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    if (!effectiveMadsToken()) return sendJSON(res, 200, { enabled: false, ok: false, error: 'No token set.' });
    return madsVerify(function (verr, conf) { sendJSON(res, 200, { enabled: true, ok: !verr, error: verr ? verr.message : '', conf: conf || null }); });
  }
  if (pathname === '/api/mads/config' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    return readBody(req, function (raw) {
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (!madsConf) return sendJSON(res, 400, { error: 'no_conf', message: 'Connect the token first.' });
      if (input.adAccountId) {
        var acct = (madsConf.accounts || []).filter(function (a) { return a.id === input.adAccountId; })[0];
        if (acct) { madsConf.adAccountId = acct.id; madsConf.adAccountName = acct.name; madsConf.currency = acct.currency; }
      }
      if (input.pageId) {
        var page = (madsConf.pages || []).filter(function (p) { return p.id === input.pageId; })[0];
        if (page) { madsConf.pageId = page.id; madsConf.pageName = page.name; madsConf.igUserId = page.igUserId; madsConf.igUsername = page.igUsername; }
      }
      saveMadsConf();
      sendJSON(res, 200, { ok: true, adAccountId: madsConf.adAccountId, pageId: madsConf.pageId, currency: madsConf.currency, igUsername: madsConf.igUsername });
    });
  }
  // Create the whole PAUSED dark-ads chain for a round. Async job, idempotent
  // per (round + attempt) — the client polls /api/mads/job.
  if (pathname === '/api/mads/dark' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    if (!effectiveMadsToken()) return sendJSON(res, 501, { error: 'no_mads_token', message: 'Connect the dark-ads token first (Performance → Instagram).' });
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large', message: 'Payload too big (' + Math.round(overSize / 1e6) + 'MB)' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (!Array.isArray(input.ads) || !input.ads.length) return sendJSON(res, 400, { error: 'bad_args', message: 'ads required' });
      if (!(parseFloat(input.budget) > 0)) return sendJSON(res, 400, { error: 'bad_args', message: 'a positive daily budget is required' });
      if (!input.roundId) return sendJSON(res, 400, { error: 'bad_args', message: 'roundId required' });
      var idem = String(input.idem || '').slice(0, 120);
      if (idem && igJobs[idem] && igJobs[idem].state !== 'error') {
        return sendJSON(res, 200, { ok: true, job: idem, state: igJobs[idem].state });
      }
      // durable dedupe: a FIRST run for a round that already completed one
      // (browser crashed before storing it, server restarted, job swept)
      // returns the recorded campaign instead of building a lookalike twin.
      // Deliberate re-runs use a campaignId-suffixed idem and pass through.
      var ridReq = String(input.roundId);
      var recR = madsRuns[ridReq];
      var recClean = !!(recR && recR.state === 'done' && recR.campaignId && recR.ads &&
        Object.keys(recR.ads).length && Object.keys(recR.ads).every(function (k) { return recR.ads[k] && recR.ads[k].adId; }));
      if (/:first$/.test(idem) && recClean) {
        var healId = 'heal-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
        igJobs[healId] = { state: 'done', at: Date.now(), result: { campaignId: recR.campaignId, adsetId: recR.adsetId, ads: recR.ads || {} } };
        return sendJSON(res, 200, { ok: true, job: healId, state: 'done', recovered: true });
      }
      var jobId = idem || ('mads-' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'));
      igJobs[jobId] = { state: 'running', at: Date.now(), note: 'starting…' };
      madsDarkRun(jobId, input);
      sendJSON(res, 200, { ok: true, job: jobId, state: 'running' });
    }, 80 * 1024 * 1024);
  }
  if (pathname === '/api/mads/job' && req.method === 'GET') {
    if (!requireAppHeader(req, res)) return;
    var mj = igJobs[String(parsed.query.job || '').slice(0, 120)];
    if (!mj) return sendJSON(res, 404, { error: 'unknown_job' });
    return sendJSON(res, 200, { ok: true, state: mj.state, note: mj.note || '', result: mj.result || null, error: mj.error || '' });
  }
  if (pathname === '/api/mads/insights' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    if (!effectiveMadsToken()) return sendJSON(res, 501, { error: 'no_mads_token' });
    return readBody(req, function (raw) {
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var ids = (Array.isArray(input.ids) ? input.ids : []).slice(0, 60).map(String);
      if (!ids.length) return sendJSON(res, 400, { error: 'bad_args' });
      var tok = effectiveMadsToken(), byId = {}, i = 0;
      (function next() {
        if (i >= ids.length) return sendJSON(res, 200, { ok: true, byId: byId, at: new Date().toISOString() });
        var id = ids[i++];
        fbRequest('GET', '/' + id, { fields: 'effective_status,name', access_token: tok }, function (serr, sj) {
          if (serr) { byId[id] = { error: serr.message.slice(0, 200) }; return next(); }
          fbRequest('GET', '/' + id + '/insights', { fields: 'impressions,reach,clicks,ctr,spend,cpc', date_preset: 'maximum', access_token: tok }, function (ierr, ij) {
            var row = (ij && ij.data && ij.data[0]) || {};
            byId[id] = {
              status: sj.effective_status || '',
              impressions: row.impressions != null ? +row.impressions : null,
              reach: row.reach != null ? +row.reach : null,
              clicks: row.clicks != null ? +row.clicks : null,
              ctr: row.ctr != null ? +(+row.ctr).toFixed(2) : null,
              spend: row.spend != null ? +row.spend : null,
              cpc: row.cpc != null ? +(+row.cpc).toFixed(2) : null
            };
            if (ierr) byId[id].insightsError = ierr.message.slice(0, 150);
            next();
          });
        });
      })();
    }, 64 * 1024);
  }

  // --- Render ONE image with Nano Banana from a concept prompt (+ references) ---
  if (pathname === '/api/ai/genimage' && req.method === 'POST') {
    if (!effectiveGeminiKey()) return sendJSON(res, 501, { error: 'no_gemini_key', message: 'Add your Nano Banana (Gemini) API key in Brand Kit to render real images.' });
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large', message: 'Reference images too large (' + Math.round(overSize / 1e6) + 'MB)' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var prompt = String(input.prompt || '').slice(0, 4000);
      if (!prompt) return sendJSON(res, 400, { error: 'no_prompt', message: 'A prompt is required.' });
      // Reference images deliberately NOT forwarded to the image model by the
      // client anymore: given input images, Nano Banana behaves like an editor
      // and produces near-variations of them. The brand's "world" is carried in
      // the TEXT prompt instead (distilled by the art-director step), so every
      // render is a genuinely new scene. refs kept for API compat if supplied.
      var refs = Array.isArray(input.images) ? input.images.slice(0, 3) : [];
      var full = wrapImagePrompt(prompt, refs.length > 0);
      geminiGenerate(full, refs, function (err, dataURL) {
        if (err) {
          if (err.message === 'no_gemini_key') return sendJSON(res, 501, { error: 'no_gemini_key' });
          // remember key/permission problems so the UI can explain the fallback
          if (/\b(401|403)\b|blocked|API key|PERMISSION|not valid|SERVICE_DISABLED|has not been used/i.test(err.message)) geminiLastError = err.message;
          return sendJSON(res, 502, { error: 'gemini', message: err.message });
        }
        sendJSON(res, 200, { dataURL: dataURL });
      });
    }, 20 * 1024 * 1024);
  }
  // --- Render MANY images at once: every prompt becomes its own PARALLEL call
  // to Nano Banana, and each image streams back the moment Google returns it
  // (NDJSON: one {"i","ok","dataURL"|"error"} line per image). One browser
  // request → N simultaneous Google calls, so 20 images take ~as long as 1.
  if (pathname === '/api/ai/genimages' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    if (!effectiveGeminiKey()) return sendJSON(res, 501, { error: 'no_gemini_key', message: 'Add your Nano Banana (Gemini) API key to render real images.' });
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large', message: 'Prompts too large (' + Math.round(overSize / 1e6) + 'MB)' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var prompts = (Array.isArray(input.prompts) ? input.prompts : []).slice(0, 25)
        .map(function (p) { return String(p || '').slice(0, 4000); });
      if (!prompts.filter(Boolean).length) return sendJSON(res, 400, { error: 'no_prompts', message: 'At least one prompt is required.' });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      var pending = prompts.length;
      function finishOne(i, err, dataURL) {
        if (err && /\b(401|403)\b|blocked|API key|PERMISSION|not valid|SERVICE_DISABLED|has not been used/i.test(err.message)) geminiLastError = err.message;
        try { res.write(JSON.stringify(err ? { i: i, ok: false, error: String(err.message).slice(0, 300) } : { i: i, ok: true, dataURL: dataURL }) + '\n'); } catch (e) {}
        if (--pending === 0) { try { res.end(); } catch (e) {} }
      }
      prompts.forEach(function (p, i) {
        if (!p) return finishOne(i, new Error('empty prompt'));
        var attempt = 0;
        function go() {
          attempt++;
          geminiGenerate(wrapImagePrompt(p, false), [], function (err, dataURL) {
            // one polite retry on transient throttling/outage — with N calls in
            // flight at once a couple of 429s are expected, not fatal
            if (err && attempt < 2 && /429|rate|quota|overload|unavailable|timed out|50\d/i.test(err.message)) {
              return setTimeout(go, 1500 + Math.floor(Math.random() * 1500));
            }
            finishOne(i, err, dataURL);
          });
        }
        go();
      });
    }, 2 * 1024 * 1024);
  }

  // --- Animate an AI image into REAL footage (Veo) — saved as a project file
  // so the clip is durable (/pfiles URL) and survives reloads + saves.
  if (pathname === '/api/ai/genclip' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    if (!effectiveGeminiKey()) return sendJSON(res, 501, { error: 'no_gemini_key', message: 'Add your Gemini API key to animate images.' });
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large', message: 'Image too large (' + Math.round(overSize / 1e6) + 'MB)' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var pid = safeSeg(input.project);
      if (!pid || pid === '_') return sendJSON(res, 400, { error: 'bad_project' });
      var prompt = String(input.prompt || '').slice(0, 1600);
      var full = 'Bring this exact scene to life as a short cinematic advertising clip. ' +
        (prompt ? 'The scene: ' + prompt + ' ' : '') +
        'Natural, believable motion true to the scene — subtle camera drift, living light, real-world movement. ' +
        'Keep the composition, subjects and mood of the source image. No text, captions, logos or watermarks.';
      veoGenerate(full, input.image, function (err, buf) {
        if (err) {
          if (/\b(401|403)\b|blocked|API key|PERMISSION|not valid/i.test(err.message)) geminiLastError = err.message;
          return sendJSON(res, 502, { error: 'veo', message: err.message });
        }
        var name = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '-aiclip.mp4';
        var dir = path.join(PROJECTS_DIR, pid, 'files');
        fs.mkdir(dir, { recursive: true }, function () {
          fs.writeFile(path.join(dir, name), buf, function (werr) {
            if (werr) return sendJSON(res, 500, { error: 'write', message: String(werr.message) });
            sendJSON(res, 200, { url: '/pfiles/' + pid + '/' + name, bytes: buf.length, model: VEO_MODEL });
          });
        });
      });
    }, 20 * 1024 * 1024);
  }

  // --- AI copy generation ---
  if (pathname === '/api/ai/copy' && req.method === 'POST') {
    if (!effectiveKey()) {
      return sendJSON(res, 501, { error: 'no_key', message: 'Turn on AI (top-right toggle) and add a key, or set ANTHROPIC_API_KEY.' });
    }
    return readBody(req, function (raw) {
      var input;
      try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (!input.brief && !(Array.isArray(input.frames) && input.frames.length)) return sendJSON(res, 400, { error: 'no_brief', message: 'A product brief or video frames are required.' });
      callAnthropic(buildCopyRequest(input), function (err, status, body) {
        if (err) return sendJSON(res, 502, { error: 'upstream', message: String(err.message || err) });
        if (status < 200 || status >= 300) {
          var msg = body;
          try { msg = JSON.parse(body).error.message; } catch (e) {}
          return sendJSON(res, status, { error: 'api', message: msg });
        }
        try {
          var variations = parseCopyResponse(body);
          return sendJSON(res, 200, { variations: variations, model: MODEL });
        } catch (e) {
          return sendJSON(res, 500, { error: 'parse', message: 'Could not parse AI response: ' + e.message });
        }
      });
    });
  }

  // --- AI dossier (deep read of the whole project) ---
  if (pathname === '/api/ai/dossier' && req.method === 'POST') {
    if (!effectiveKey()) return sendJSON(res, 501, { error: 'no_key', message: 'Turn on AI (top-right toggle) and add a key, or set ANTHROPIC_API_KEY.' });
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large', message: 'Project material is too large to analyze (' + Math.round(overSize / 1e6) + 'MB)' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var hasText = !!(input.site && (input.site.text || input.site.title)) || (input.files || []).length || input.notes;
      var hasImgs = (input.images || []).length;
      if (!hasText && !hasImgs) return sendJSON(res, 400, { error: 'no_material', message: 'Nothing to analyze yet — add a URL, files, images or a video.' });
      callAnthropic(buildDossierRequest(input), function (err, status, body) {
        if (err) return sendJSON(res, 502, { error: 'upstream', message: String(err.message || err) });
        if (status < 200 || status >= 300) {
          var msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {}
          return sendJSON(res, status, { error: 'api', message: msg });
        }
        try { return sendJSON(res, 200, { dossier: parseDossierResponse(body), model: MODEL }); }
        catch (e) { return sendJSON(res, 500, { error: 'parse', message: 'Could not parse the dossier: ' + e.message }); }
      });
    }, 80 * 1024 * 1024);
  }

  // --- AI market research (pain points, via web search when available) ---
  if (pathname === '/api/ai/research' && req.method === 'POST') {
    if (!effectiveKey()) return sendJSON(res, 501, { error: 'no_key', message: 'Turn on AI (top-right toggle) and add a key, or set ANTHROPIC_API_KEY.' });
    return readBody(req, function (raw) {
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (!String(input.topic || '').trim()) return sendJSON(res, 400, { error: 'no_topic', message: 'Give the research bar a topic first.' });

      // long web-search turns can pause; feed the partial turn back to continue.
      // Text emitted in earlier hops is accumulated so a JSON answer split
      // across a pause still parses.
      function run(request, webSearch, hops, priorText) {
        callAnthropic(request, function (err, status, body) {
          if (err) return sendJSON(res, 502, { error: 'upstream', message: String(err.message || err) });
          if (status < 200 || status >= 300) {
            var msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {}
            // org without web search → degrade to model market knowledge.
            // First hop only — a 400 mid-continuation is a real bug to surface,
            // not a capability gap, and retrying would discard paid searches.
            if (webSearch && hops === 0 && status === 400 && /web_search/i.test(String(msg))) {
              return run(buildResearchRequest(input, false), false, 0, '');
            }
            return sendJSON(res, status, { error: 'api', message: msg });
          }
          var parsedBody; try { parsedBody = JSON.parse(body); } catch (e) { return sendJSON(res, 500, { error: 'parse', message: 'Bad upstream response' }); }
          if (parsedBody.stop_reason === 'pause_turn') {
            if (hops >= 3) return sendJSON(res, 504, { error: 'research_timeout', message: 'Research ran too long — try a narrower topic' });
            var hopText = ''; (parsedBody.content || []).forEach(function (b) { if (b.type === 'text') hopText += b.text; });
            var cont = buildResearchRequest(input, webSearch);
            cont.messages = request.messages.concat([{ role: 'assistant', content: parsedBody.content }]);
            return run(cont, webSearch, hops + 1, (priorText || '') + hopText);
          }
          try { return sendJSON(res, 200, { research: parseResearchResponse(body, priorText), webSearch: webSearch, model: MODEL }); }
          catch (e2) { return sendJSON(res, 500, { error: 'parse', message: 'Could not parse the research: ' + e2.message }); }
        }, 480000);   // web research legitimately runs for minutes
      }
      run(buildResearchRequest(input, true), true, 0, '');
    });
  }

  // --- AI media plan (budget + platforms + ads + audience → executable plan) ---
  // --- AI dark-ads targeting: read the project's audience analysis + the
  // round's ads → concrete Meta targeting (countries, ages, gender, interests)
  if (pathname === '/api/ai/darktarget' && req.method === 'POST') {
    if (!effectiveKey()) return sendJSON(res, 501, { error: 'no_key', message: 'Turn on AI to use Optimize targeting.' });
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (!String(input.context || '').trim()) return sendJSON(res, 400, { error: 'no_context' });
      callAnthropic({
        model: MODEL, max_tokens: 1500,
        system: 'You are a senior Meta ads media buyer. From the advertiser\'s audience research and the actual ads below, produce the most PRECISELY AIMED Meta ad-set targeting possible. Respond with ONLY strict JSON, no prose: {"countries":["ISO-3166 alpha-2",...],"ageMin":18-65,"ageMax":18-65,"gender":"all"|"women"|"men","interests":["6-12 Meta detailed-targeting interest names — real things people follow (e.g. Genealogy, Family reunion, Cloud storage), most-specific first"],"why":"2-3 sentences explaining the aim"}. Ground every choice in the research; when the research names segments, target the PRIMARY segment tightly rather than everyone loosely.',
        messages: [{ role: 'user', content: String(input.context).slice(0, 30000) }]
      }, function (err, status, body) {
        if (err) return sendJSON(res, 502, { error: 'upstream', message: String(err.message || err) });
        if (status < 200 || status >= 300) { var msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {} return sendJSON(res, status, { error: 'api', message: msg }); }
        try {
          var j = JSON.parse(body);
          var txt = (j.content || []).map(function (c) { return c.text || ''; }).join('');
          var m2 = /\{[\s\S]*\}/.exec(txt);
          if (!m2) throw new Error('no JSON in the reply');
          var t = JSON.parse(m2[0]);
          sendJSON(res, 200, {
            countries: (t.countries || []).map(function (c) { return String(c).toUpperCase(); }).filter(function (c) { return /^[A-Z]{2}$/.test(c); }),
            ageMin: parseInt(t.ageMin, 10) || 18, ageMax: parseInt(t.ageMax, 10) || 65,
            gender: /^(women|men)$/.test(t.gender) ? t.gender : 'all',
            interests: (t.interests || []).map(String).slice(0, 12),
            why: String(t.why || '').slice(0, 600)
          });
        } catch (e2) { sendJSON(res, 500, { error: 'parse', message: 'Could not parse the targeting: ' + e2.message }); }
      }, 120000);
    }, 512 * 1024);
  }
  // resolve an interest keyword against Meta's real detailed-targeting catalog
  if (pathname === '/api/mads/interests' && req.method === 'GET') {
    if (!requireAppHeader(req, res)) return;
    if (!effectiveMadsToken()) return sendJSON(res, 501, { error: 'no_mads_token' });
    var iq = String(parsed.query.q || '').slice(0, 80);
    if (!iq.trim()) return sendJSON(res, 400, { error: 'bad_args' });
    return fbRequest('GET', '/search', { type: 'adinterest', q: iq, limit: 5, access_token: effectiveMadsToken() }, function (err, j) {
      if (err) return sendJSON(res, 502, { error: 'ig_search', message: err.message });
      sendJSON(res, 200, { results: (j.data || []).map(function (r2) { return { id: String(r2.id), name: r2.name, size: r2.audience_size_lower_bound || r2.audience_size || null }; }) });
    });
  }

  if (pathname === '/api/ai/mediaplan' && req.method === 'POST') {
    if (!effectiveKey()) return sendJSON(res, 501, { error: 'no_key', message: 'Turn on AI (top-right toggle) and add a key, or set ANTHROPIC_API_KEY.' });
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large', message: 'Plan context too large (' + Math.round(overSize / 1e6) + 'MB)' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (!String(input.context || '').trim()) return sendJSON(res, 400, { error: 'no_context', message: 'Nothing to plan with.' });
      callAnthropic(buildMediaPlanRequest(input), function (err, status, body) {
        if (err) return sendJSON(res, 502, { error: 'upstream', message: String(err.message || err) });
        if (status < 200 || status >= 300) { var msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {} return sendJSON(res, status, { error: 'api', message: msg }); }
        try { return sendJSON(res, 200, { plan: parseMediaPlanResponse(body), model: MODEL }); }
        catch (e2) { return sendJSON(res, 500, { error: 'parse', message: 'Could not parse the plan: ' + e2.message }); }
      }, 300000);
    }, 2 * 1024 * 1024);
  }

  // --- AI target-audience analysis (deep read of EVERYTHING + live market
  // research) → who to advertise to: segments, demographics, regions, platforms
  // and a Meta-ready targeting spec. Long web-search turns pause + continue.
  if (pathname === '/api/ai/audience' && req.method === 'POST') {
    if (!effectiveKey()) return sendJSON(res, 501, { error: 'no_key', message: 'Turn on AI (top-right toggle) and add a key, or set ANTHROPIC_API_KEY.' });
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large', message: 'Context too large (' + Math.round(overSize / 1e6) + 'MB)' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (!String(input.context || '').trim()) return sendJSON(res, 400, { error: 'no_context', message: 'Nothing to analyze — add project material first.' });
      function run(request, webSearch, hops, priorText) {
        callAnthropic(request, function (err, status, body) {
          if (err) return sendJSON(res, 502, { error: 'upstream', message: String(err.message || err) });
          if (status < 200 || status >= 300) {
            var msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {}
            if (webSearch && hops === 0 && status === 400 && /web_search/i.test(String(msg))) {
              return run(buildAudienceRequest(input, false), false, 0, '');
            }
            return sendJSON(res, status, { error: 'api', message: msg });
          }
          var parsedBody; try { parsedBody = JSON.parse(body); } catch (e) { return sendJSON(res, 500, { error: 'parse', message: 'Bad upstream response' }); }
          if (parsedBody.stop_reason === 'pause_turn') {
            if (hops >= 3) return sendJSON(res, 504, { error: 'audience_timeout', message: 'The analysis ran too long — try again' });
            var hopText = ''; (parsedBody.content || []).forEach(function (b) { if (b.type === 'text') hopText += b.text; });
            var cont = buildAudienceRequest(input, webSearch);
            cont.messages = request.messages.concat([{ role: 'assistant', content: parsedBody.content }]);
            return run(cont, webSearch, hops + 1, (priorText || '') + hopText);
          }
          try { return sendJSON(res, 200, { audience: parseAudienceResponse(body, priorText), webSearch: webSearch, model: MODEL }); }
          catch (e2) { return sendJSON(res, 500, { error: 'parse', message: 'Could not parse the analysis: ' + e2.message }); }
        }, 480000);   // a thorough read + live research legitimately runs for minutes
      }
      run(buildAudienceRequest(input, true), true, 0, '');
    }, 4 * 1024 * 1024);
  }

  // --- AI image concepts (art-directed prompts for ad visuals) ---
  if (pathname === '/api/ai/imageprompts' && req.method === 'POST') {
    if (!effectiveKey()) return sendJSON(res, 501, { error: 'no_key', message: 'Turn on AI (top-right toggle) and add a key, or set ANTHROPIC_API_KEY.' });
    return readBody(req, function (raw, overSize) {
      if (raw == null) return sendJSON(res, 413, { error: 'too_large', message: 'Reference images are too large (' + Math.round(overSize / 1e6) + 'MB)' });
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      callAnthropic(buildImageConceptsRequest(input), function (err, status, body) {
        if (err) return sendJSON(res, 502, { error: 'upstream', message: String(err.message || err) });
        if (status < 200 || status >= 300) { var msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {} return sendJSON(res, status, { error: 'api', message: msg }); }
        try { return sendJSON(res, 200, { images: parseImageConceptsResponse(body), model: MODEL }); }
        catch (e2) { return sendJSON(res, 500, { error: 'parse', message: 'Could not parse the image concepts: ' + e2.message }); }
      });
    }, 30 * 1024 * 1024);
  }

  // --- AI landing content (writes each page AS the brand, first person) ---
  // Page anatomy the client assembles: a PER-AD opening (subhead + a short
  // story that continues that ad's exact promise) followed by a SHARED
  // long-form "about us" body (5-7 multi-paragraph sections + optional bullet
  // points + a closing urge) that is identical on every page for consistency.
  // One call returns openings for up to 10 pages; pass about:true on the first
  // call of a run to also get the shared body. All first-person, original.
  if (pathname === '/api/ai/landing' && req.method === 'POST') {
    if (!effectiveKey()) return sendJSON(res, 501, { error: 'no_key', message: 'Turn on AI (top-right toggle) and add a key, or set ANTHROPIC_API_KEY.' });
    return readBody(req, function (raw) {
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var pagesIn = Array.isArray(input.pages) ? input.pages.slice(0, 10) : [];
      if (!pagesIn.length) return sendJSON(res, 400, { error: 'no_pages' });
      var wantAbout = !!input.about;
      var brand = String(input.brand || 'the brand').slice(0, 80);
      var voice = String(input.voice || '').slice(0, 400);
      var context = String(input.context || '').slice(0, 24000);
      var system =
        'You are the senior in-house copywriter for ' + brand + '. You are writing ' + brand + '’s OWN landing pages. ' +
        'You ARE the brand, speaking directly to a person who just clicked one of our ads.\n\n' +
        'VOICE — non-negotiable:\n' +
        '• First person AS the brand: "we", "our", "us", and "you" for the reader. NEVER refer to the brand in the third person.\n' +
        '• FORBIDDEN phrasings: "' + brand + ' is…", "the product", "the platform", "the service", "the company", "it offers", "is described as", "designed to". ' +
        'NEVER mention beta, prototype, MVP, concept, demo, waitlist, roadmap, "in development", or anything implying it is unfinished or that you are summarizing a document.\n' +
        '• Do NOT copy or lightly reword sentences from the source material. Read it, understand what we do and why it matters to a real person, then write ORIGINAL copy in our voice.\n' +
        '• Infer and match our tone from the source (e.g. reverent, warm, playful, technical). Be emotionally resonant, concrete and human. No corporate filler, no clichés ("in today’s fast-paced world", "game-changing", "seamless", "unlock", "elevate").\n\n' +
        'A page has two halves:\n' +
        '1) A unique OPENING that continues the exact promise of the ad the reader clicked — no bait-and-switch.\n' +
        '2) A shared ABOUT body: the full story of who we are, written once, that every page carries.\n' +
        'Everything should leave the reader intrigued — the page informs generously, but the itch it creates is only scratched on our website. Pull them there.\n\n' +
        'FOR EACH PAGE produce:\n' +
        '• subhead — one sentence continuing that ad’s hook, sharpening its promise.\n' +
        '• story — two short paragraphs separated by a blank line. The first paragraph is a vivid human moment or line that belongs to THIS ad’s promise — a scene, a memory, a truth the reader instantly recognizes (not "imagine…" clichés; write like a person, not an ad). The second paragraph turns and lands: this is exactly why we exist, and what the reader will find with us — bridging naturally into the shared body that follows.\n' +
        (wantAbout
          ? '\nPLUS produce ONE shared "about" body (identical for every page — write it once):\n' +
            '• about.sections — 5 to 7 objects {kicker, title, body, points?}. kicker = 1–3 word label in our voice. ' +
            'title = a first-person headline written as us, NOT a generic label like "What this is". ' +
            'body = 2–3 substantial paragraphs separated by a blank line, 90–170 words per section, each paragraph doing real informational work: ' +
            'concrete specifics from the source (what you actually see and do with us, real capabilities by name, real facts and numbers when the source has them — NEVER invented ones). ' +
            'points = OPTIONAL, on the 1–3 sections where a scannable list genuinely helps (capabilities, how-it-works steps): 3–6 short first-person bullets, each a concrete fact or ability, no filler.\n' +
            'Across the sections cover: what we are and what it feels like → how it actually works (real steps and detail) → what you can do with us (capabilities in human terms) → who it’s for and the moments it serves → the honest answer to the reader’s doubt → why this matters now. A reader who scrolls to the end should genuinely UNDERSTAND us — depth from the source material, never padding.\n' +
            '• about.closer — {title, line, cta}: the final push. title = a first-person invitation that makes visiting our site feel inevitable; line = 1–2 sentences of honest urgency (what waiting costs, what’s waiting for them with us — never fake scarcity); cta = 2–4 words for the button.\n'
          : '') +
        '\nOutput ONLY valid JSON, no prose or backticks.';
      var user =
        'Everything we know about ourselves (source material — understand it, do not quote it):\n"""\n' + context + '\n"""\n' +
        (voice ? '\nOur brand voice: ' + voice + '\n' : '') +
        '\nWrite the opening for each of these ads:\n' +
        pagesIn.map(function (p, i) { return (i + 1) + '. HEADLINE: ' + String(p.headline || '').slice(0, 120) + (p.hook ? '\n   HOOK: ' + String(p.hook).slice(0, 260) : ''); }).join('\n') +
        '\n\nReturn ONLY {"pages":[{"subhead":"","story":""}' + (wantAbout ? ',…],"about":{"sections":[{"kicker":"","title":"","body":"","points":[]}],"closer":{"title":"","line":"","cta":""}}' : ']') + '} with exactly ' + pagesIn.length + ' page entries, in order.';
      callAnthropic({ model: MODEL, max_tokens: 16384, system: system, messages: [{ role: 'user', content: user }] }, function (err, status, body) {
        if (err) return sendJSON(res, 502, { error: 'upstream', message: String(err.message || err) });
        if (status < 200 || status >= 300) {
          var msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {}
          return sendJSON(res, status, { error: 'api', message: msg });
        }
        try {
          var json = JSON.parse(body), text = '';
          if (json.stop_reason === 'max_tokens') return sendJSON(res, 500, { error: 'truncated', message: 'The landing copy ran past the output limit — ask for fewer pages per call.' });
          (json.content || []).forEach(function (b) { if (b.type === 'text') text += b.text; });
          text = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          var a = text.indexOf('{'), z = text.lastIndexOf('}');
          if (a >= 0 && z > a) text = text.slice(a, z + 1);
          var d = JSON.parse(text);
          function cleanSections(arr) {
            return Array.isArray(arr) ? arr.slice(0, 8).map(function (s) {
              s = s || {};
              return {
                kicker: String(s.kicker || '').slice(0, 40),
                title: String(s.title || '').slice(0, 120),
                body: String(s.body || '').slice(0, 2600),
                points: Array.isArray(s.points) ? s.points.slice(0, 6).map(function (x) { return String(x || '').slice(0, 200); }).filter(Boolean) : []
              };
            }) : [];
          }
          var pages = Array.isArray(d.pages) ? d.pages.map(function (p) {
            p = p || {};
            return { subhead: String(p.subhead || '').slice(0, 300), story: String(p.story || '').slice(0, 2200) };
          }) : [];
          var about = null;
          if (wantAbout && d.about && typeof d.about === 'object') {
            var aboutSecs = cleanSections(d.about.sections);
            // an about with no sections is useless — return null so the client
            // KNOWS it must ask again on the next batch, instead of shipping thin pages
            if (aboutSecs.length) {
              var cl = d.about.closer || {};
              about = {
                sections: aboutSecs,
                closer: { title: String(cl.title || '').slice(0, 140), line: String(cl.line || '').slice(0, 400), cta: String(cl.cta || '').slice(0, 40) }
              };
            }
          }
          return sendJSON(res, 200, { pages: pages, about: about, model: MODEL });
        } catch (e2) { return sendJSON(res, 500, { error: 'parse', message: 'Could not parse the landing copy: ' + e2.message }); }
      });
    });
  }

  // --- AI edit (apply a natural-language change to an ad spec) ---
  if (pathname === '/api/ai/edit' && req.method === 'POST') {
    if (!effectiveKey()) return sendJSON(res, 501, { error: 'no_key', message: 'Turn on AI (top-right toggle) and add a key, or set ANTHROPIC_API_KEY.' });
    return readBody(req, function (raw) {
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      if (!input.instruction) return sendJSON(res, 400, { error: 'no_instruction', message: 'Tell the AI what to change.' });
      callAnthropic(buildEditRequest(input), function (err, status, body) {
        if (err) return sendJSON(res, 502, { error: 'upstream', message: String(err.message || err) });
        if (status < 200 || status >= 300) { var msg = body; try { msg = JSON.parse(body).error.message; } catch (e) {} return sendJSON(res, status, { error: 'api', message: msg }); }
        try { var r = parseEditResponse(body); return sendJSON(res, 200, { changes: r.changes, note: r.note, model: MODEL }); }
        catch (e) { return sendJSON(res, 500, { error: 'parse', message: 'Could not parse AI response: ' + e.message }); }
      });
    });
  }

  // --- Website scrape (read a site → structured data + brand assets) ---
  if (pathname === '/api/scrape' && req.method === 'POST') {
    return readBody(req, function (raw) {
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var target = String(input.url || '').trim();
      if (!target) return sendJSON(res, 400, { error: 'no_url', message: 'A website URL is required.' });
      if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
      httpGet(target, { accept: 'text/html,application/xhtml+xml,*/*' }, function (err, r) {
        if (err) return sendJSON(res, 502, { error: 'fetch', message: 'Could not reach that site: ' + String(err.message || err) });
        if (r.statusCode >= 400) return sendJSON(res, 502, { error: 'http', message: 'Site returned HTTP ' + r.statusCode + '. It may block automated requests.' });
        var ct = (r.contentType || '').toLowerCase();
        if (ct && ct.indexOf('html') < 0 && ct.indexOf('xml') < 0) return sendJSON(res, 415, { error: 'not_html', message: 'That URL is not an HTML page (' + ct + ').' });
        var html = r.body.toString('utf8');
        var metas = parseMetas(html);
        var hostname = ''; try { hostname = new URL(r.finalUrl).hostname.replace(/^www\./, ''); } catch (e) {}
        var site = {
          url: target, finalUrl: r.finalUrl,
          siteName: metas['og:site_name'] || metas['application-name'] || hostname,
          title: metas['og:title'] || extractTitle(html) || hostname,
          description: metas['description'] || metas['og:description'] || '',
          themeColor: validHex(metas['theme-color']) ? metas['theme-color'] : null,
          headings: extractHeadings(html),
          text: visibleText(html).slice(0, 5000),
          ogImageUrl: metas['og:image'] ? absUrl(metas['og:image'], r.finalUrl) : null,
          faviconUrl: findFavicon(html, r.finalUrl)
        };
        site.brief = composeBrief(site);
        site.imageUrls = extractImageUrls(html, r.finalUrl, metas);
        if (input.images === false) { site.ogImage = null; site.favicon = null; site.images = []; return sendJSON(res, 200, site); }
        // three best-effort fetches in parallel: the site's own fonts (so a
        // landing page can wear them), the favicon, and a gallery of real page
        // images. A barrier answers once all three settle.
        var pending = 3, sent = false;
        function flush() { if (!sent) { sent = true; sendJSON(res, 200, site); } }
        function maybeSend() { if (--pending === 0) flush(); }
        // hard deadline: even if a leg somehow never settles, answer with
        // whatever we have rather than leaving the socket open
        setTimeout(flush, 20000);
        collectCSS(html, r.finalUrl, function (css) {
          try { site.design = extractDesign(html, css, r.finalUrl); } catch (e) { site.design = null; }
          maybeSend();
        });
        fetchImageDataURL(site.faviconUrl, 400 * 1024, function (fav) { site.favicon = fav; maybeSend(); });
        fetchGallery(site.imageUrls, 6, 14, 7000, function (imgs) {
          site.images = imgs;                 // real hero / background / content images, data-URIs
          site.ogImage = imgs[0] || null;     // primary (back-compat)
          maybeSend();
        });
      });
    });
  }

  // --- Durable store snapshot ---
  if (pathname === '/api/store') {
    if (req.method === 'GET') {
      return fs.readFile(STORE_FILE, 'utf8', function (err, txt) {
        if (err) return sendJSON(res, 204, {});
        return send(res, 200, txt, { 'Content-Type': 'application/json; charset=utf-8' });
      });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      if (!requireAppHeader(req, res)) return;
      // projects can carry many data-URI images — allow a big snapshot, and
      // FAIL LOUDLY (413) instead of silently dropping the write
      return readBody(req, function (raw, overSize) {
        if (raw == null) return sendJSON(res, 413, { error: 'too_large', message: 'Store snapshot is ' + Math.round(overSize / 1e6) + 'MB — over the 400MB cap' });
        var incoming;
        try { incoming = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }

        // --- CLOBBER GUARD ---------------------------------------------------
        // A fresh/empty browser state (e.g. the app booted a seed while this
        // server was briefly restarting) must NEVER overwrite a disk store full
        // of real work. Only pay the parse cost when the write actually shrinks
        // the file a lot; a normal-size or growing write skips the check.
        var force = !!(parsed && parsed.query && parsed.query.force === '1');
        try {
          var curStat = fs.existsSync(STORE_FILE) ? fs.statSync(STORE_FILE) : null;
          if (!force && curStat && Buffer.byteLength(raw) < curStat.size * 0.5) {
            var disk = null;
            try { disk = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (e) { disk = null; }
            if (disk) {
              var diskIds = storeContentIds(disk);
              var inIds = storeContentIds(incoming);
              var diskKeys = Object.keys(diskIds);
              var lost = diskKeys.filter(function (id) { return !inIds[id]; });
              var wipe = diskKeys.length >= 1 && Object.keys(inIds).length === 0;
              if (wipe || lost.length >= 2) {
                // preserve the good copy under a timestamped rescue name, refuse
                try { fs.copyFileSync(STORE_FILE, STORE_FILE + '.rescue-' + Date.now()); pruneRescues(8); } catch (e) {}
                return sendJSON(res, 409, {
                  error: 'clobber_blocked',
                  message: 'Refused a save that would erase ' + (wipe ? diskKeys.length : lost.length) +
                           ' project(s) with work still on disk. Your disk data is untouched; reload to pull it back.',
                  diskProjects: diskKeys.length, incomingProjects: Object.keys(inIds).length
                });
              }
            }
          }
        } catch (e) { /* guard must never block a legit write on its own error */ }
        // --------------------------------------------------------------------

        fs.mkdir(path.dirname(STORE_FILE), { recursive: true }, function () {
          // rotate 3 backups before every overwrite — one bad write (stale
          // browser state, crash mid-save) must never lose the last good copy
          try {
            if (fs.existsSync(STORE_FILE)) {
              try { fs.rmSync(STORE_FILE + '.bak3', { force: true }); } catch (e3) {}
              try { fs.renameSync(STORE_FILE + '.bak2', STORE_FILE + '.bak3'); } catch (e3) {}
              try { fs.renameSync(STORE_FILE + '.bak1', STORE_FILE + '.bak2'); } catch (e3) {}
              fs.copyFileSync(STORE_FILE, STORE_FILE + '.bak1');
            }
          } catch (e4) {}
          fs.writeFile(STORE_FILE, raw, function (e2) {
            if (e2) return sendJSON(res, 500, { error: 'write', message: String(e2.message) });
            return sendJSON(res, 200, { ok: true, bytes: Buffer.byteLength(raw) });
          });
        });
      }, 400 * 1024 * 1024);
    }
  }

  // --- Transcription (proxied to the local transcribe-hub, file from disk) ---
  if (pathname === '/api/transcribe' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    return readBody(req, function (raw) {
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var tpid = safeSeg(input.project), tname = safeSeg(input.name);
      if (!tpid || tpid === '_' || !tname || tname === '_') return sendJSON(res, 400, { error: 'bad_args' });
      startTranscribeJob(path.join(PROJECTS_DIR, tpid, 'files', tname), tname, function (err, jobId) {
        if (err) return sendJSON(res, 503, { error: 'transcribe', message: String(err.message) });
        sendJSON(res, 200, { jobId: jobId });
      });
    });
  }
  if (pathname === '/api/transcribe/status' && req.method === 'GET') {
    var tjob = String(parsed.query.job || '');
    if (!tjob) return sendJSON(res, 400, { error: 'bad_args' });
    return pollTranscribeJob(tjob, function (err, r) {
      if (err) return sendJSON(res, 503, { error: 'transcribe', message: String(err.message) });
      sendJSON(res, 200, r);
    });
  }

  // --- Project file storage (uploaded videos / attachments) ---
  // Object URLs die on reload, so project uploads are saved as real files under
  // data/projects/<id>/files and served back from /pfiles/<id>/<name>.
  if (pathname === '/api/upload' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    var pid = safeSeg(parsed.query.project), fname = safeSeg(parsed.query.name);
    if (!pid || pid === '_' || !fname || fname === '_') return sendJSON(res, 400, { error: 'bad_args', message: 'project and name are required' });
    // unique prefix: same-named uploads must never overwrite each other
    fname = Date.now().toString(36) + '-' + fname;
    var dir = path.join(PROJECTS_DIR, pid, 'files');
    return fs.mkdir(dir, { recursive: true }, function (mkErr) {
      if (mkErr) return sendJSON(res, 500, { error: 'mkdir', message: String(mkErr.message) });
      var fp = path.join(dir, fname);
      var out = fs.createWriteStream(fp);
      var size = 0, aborted = false;
      req.on('data', function (c) {
        size += c.length;
        if (size > 500 * 1024 * 1024) { aborted = true; req.destroy(); out.destroy(); fs.unlink(fp, function () {}); }
      });
      req.pipe(out);
      out.on('finish', function () {
        if (aborted) return;
        sendJSON(res, 200, { ok: true, url: '/pfiles/' + pid + '/' + encodeURIComponent(fname), name: fname, bytes: size });
      });
      out.on('error', function (e) { if (!aborted) sendJSON(res, 500, { error: 'write', message: String(e.message) }); });
      req.on('error', function () { out.destroy(); fs.unlink(fp, function () {}); });
    });
  }

  if (pathname.indexOf('/pfiles/') === 0 && req.method === 'GET') {
    var segs = pathname.split('/').filter(Boolean); // ['pfiles', id, name]
    if (segs.length !== 3) return send(res, 404, 'Not found');
    var dseg1 = safeDecode(segs[1]), dseg2 = safeDecode(segs[2]);
    if (dseg1 == null || dseg2 == null) return send(res, 404, 'Not found');
    return serveProjectFile(req, res, dseg1, dseg2);
  }

  // delete a project's stored files (called when a project is deleted)
  if (pathname === '/api/project-files/delete' && req.method === 'POST') {
    if (!requireAppHeader(req, res)) return;
    return readBody(req, function (raw) {
      var input; try { input = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { error: 'bad_json' }); }
      var did = safeSeg(input.project);
      if (!did || did === '_') return sendJSON(res, 400, { error: 'bad_args' });
      fs.rm(path.join(PROJECTS_DIR, did), { recursive: true, force: true }, function (e2) {
        if (e2) return sendJSON(res, 500, { error: 'rm', message: String(e2.message) });
        sendJSON(res, 200, { ok: true });
      });
    });
  }

  if (pathname.indexOf('/api/') === 0) return sendJSON(res, 404, { error: 'not_found' });

  // --- Static ---
  serveStatic(req, res, pathname);
});

// backstop: a handler bug must never take down the always-on tool
process.on('uncaughtException', function (e) { console.error('[ads-hub] uncaught:', e && e.stack || e); });

// loopback only — this is a local tool; never expose the API to the LAN.
// (The office deployment also binds loopback, with Caddy terminating HTTPS
// in front and TRACK_ONLY=1 hiding everything but the tracking surface.)
server.listen(PORT, '127.0.0.1', function () {
  if (TRACK_ONLY) {
    console.log('\n  ADS HUB — TRACKING COLLECTOR (public mode)  →  http://127.0.0.1:' + PORT);
    console.log('  Serving ONLY: /a/* /p/* /t /api/track/{health,publish,stats}');
    console.log('  Sync token:  ' + TRACK_TOKEN_FILE + '\n');
    return;
  }
  console.log('\n  ADS HUB  →  http://localhost:' + PORT);
  console.log('  AI copy: ' + (API_KEY ? 'ENABLED (' + MODEL + ')' : 'disabled (set ANTHROPIC_API_KEY to enable)'));
  console.log('  Store:   ' + STORE_FILE + '\n');
  // Check a saved image key against Google on boot so the UI can show a blocked
  // key immediately (rather than after a wasted generation).
  if (effectiveGeminiKey()) geminiVerify(function (verr) {
    console.log('  Image gen (Nano Banana): ' + (verr ? 'KEY BLOCKED — ' + verr.message : 'key OK (' + GEMINI_IMAGE_MODEL + ')') + '\n');
  });
  // Instagram: verify the saved token on boot, keep it fresh daily, and sweep
  // staged /pub/ media once Meta no longer needs it (>14 days old).
  if (effectiveIgToken()) {
    igVerify(function (verr, u) {
      console.log('  Instagram: ' + (verr ? 'TOKEN PROBLEM — ' + verr.message : 'connected as @' + u.username) + '\n');
    });
    setTimeout(igRefresh, 30 * 1000);
  }
  // hourly: sweep stale staged media (Meta ingests within minutes — 48h is a
  // generous backstop; successful publishes unlink immediately), GC old
  // publish jobs, and once a day refresh the Instagram token
  var lastIgRefresh = 0;
  function pubSweep() {
    fs.readdir(PUB_DIR, function (err, names) {
      if (err) return;
      var cutoff = Date.now() - 48 * 3600 * 1000;
      names.forEach(function (n) {
        var fp = path.join(PUB_DIR, n);
        fs.stat(fp, function (serr, st) {
          if (!serr && st.isFile() && st.mtimeMs < cutoff) fs.unlink(fp, function () {});
        });
      });
    });
    Object.keys(igJobs).forEach(function (k) {
      // never sweep a job that is still progressing (note() refreshes .at)
      if (igJobs[k].state !== 'running' && Date.now() - igJobs[k].at > 3600 * 1000) delete igJobs[k];
    });
  }
  pubSweep();
  setInterval(function () {
    pubSweep();
    if (effectiveIgToken() && Date.now() - lastIgRefresh > 23 * 3600 * 1000) { lastIgRefresh = Date.now(); igRefresh(); }
  }, 3600 * 1000);
});
