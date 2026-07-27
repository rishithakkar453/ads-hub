# ADS HUB

A PARTISANS-styled tool for **making Meta (Facebook/Instagram) ad creatives at scale**
and **tracking + optimising their performance**. Two modes:

- **Projects (persistent)** — every product/site you advertise is a project.
  All uploads (URL + scraped site, notes, documents, images, **videos — stored
  as real files** under `data/projects/<id>/files`, served with Range support
  from `/pfiles/…`) plus the last generated batch are saved and restored. A
  project is created automatically on first upload or Generate; **My Projects**
  (sidebar) lists them with open / rename / delete. Survives full browser +
  server restarts. Destructive API endpoints are loopback-only and require the
  app's `X-Ads-Hub` header (CSRF-proof).
- **Project understanding (dossier)** — with AI on, the tool does a **deep
  read of everything on the project**: the full site copy, every document,
  your notes, and images + video frames (vision). It writes a long, grounded
  dossier — summary, product, audience, benefits, features, real proof,
  objections, tone, visuals, keywords — shown in an expandable panel
  (editable; re-analyzed automatically when the material changes). **Every ad
  is then written from the dossier**, with your notes passed through verbatim.
- **The video is truly watched AND heard** — on upload, ~12 quality-filtered
  frames are sampled across the whole video (every scene gets seen; the AI
  receives them as vision input, and good frames join the image pool as usable
  ad/gallery visuals), and the audio is **transcribed locally** through
  transcribe-hub (whisper on this machine, port 3004 — nothing leaves your
  computer). The full transcript feeds the dossier and the copywriter, so
  spoken claims, testimonials and offers make it into the ads.
- **Market research bar** — give it a topic and Claude researches the market
  (live **web search** when your org has it; model knowledge otherwise) to
  surface the strongest **pain points**: each with the market's own language,
  plus an ad-ready **hook, headline, tagline and description**. Pick the ones
  you like (checkboxes) and they shape every Generate — with AI on they steer
  the copywriter; with AI off they become ready-made ad variations (tagged
  **🔎 from research**). Saved on the project.
- **Landing pages (message-matched)** — after a batch, one click builds a
  landing page for **every distinct hook** among your ads: same headline and
  creative as the ad it came from, then the full product story from the
  dossier (benefits, features, real proof, objections answered, CTA to your
  site) with an AI-tailored intro per hook. Deliverables per page: a
  self-contained **index.html**, a React **Landing.jsx** and the ad visual as
  **ad.png** — hosted live at `/pfiles/...` links on the project and zipped
  for download.
- **Ad Generator** — one AI-first flow for mass-producing postable Facebook ads:
  - **Feed it a brief**: website URL (scraped server-side: copy, brand colour,
    logo, **and a gallery of the site's real images** — OG image, hero/content
    images, CSS `background-image`s — all fetched as export-safe data-URIs) +
    free-text details + documents (**PDF**, TXT, MD…) + **product images**
    (downscaled, used as creatives) + **an optional video** (*Add video
    (footage)*) whose frames become live footage for video ads and whose poster
    is usable as a still.
  - **Pick 1–100 variations** on the slider. The DNA engine fans AI copy ×
    template × image choice/placement × copy density × alignment × palette ×
    background into radically different — but grounded — ads. Every variation
    is a complete Facebook ad: creative + **caption (primary text)** +
    headline + description + CTA, following Meta best practices (≤40-char
    benefit-led headlines, hook in the first 125 caption chars, minimal
    on-image text, no invented stats/testimonials).
  - **Device previews**: each ad renders as a real Facebook feed post inside a
    **phone (default), tablet or laptop** frame — one switch changes all.
  - **AI-first editing**: no inline editor. Click **Edit ad** for every option
    (template, layout, density, copy, caption, images, palette + a per-ad AI
    instruction box), or select ads and tell the toolbar AI what to change.
  - Double-click any ad to verify it large; export selected as **ZIP +
    captions.csv**; **Approve** moves them (with captions) into Performance.
  - **Platform previews**: switch every ad between **Facebook / Instagram /
    Twitter-X / TikTok** chrome (TikTok renders full-screen 9:16).
  - **Video ads**: a Posts + video / Posts only / Video only control (default
    **2 posts : 1 video**). Short (~4.5s) 9:16 motion creatives, previewed as a
    looping video and exported as real **MP4** (H.264; webm fallback) for Reels
    & TikTok. Backgrounds are real visuals — a scraped site image (ken-burns),
    uploaded footage, or a living gradient-mesh when there's nothing to show.
    Composed motion graphics (website visuals + your footage), not AI-generated
    footage.
  - **Auto clip extraction**: drop in a video and it's analyzed **entirely in
    the browser** — frames sampled and scored for sharpness / motion / exposure
    / colour / subject-contrast, shot cuts detected, and the best few 1.5–3s
    clips picked (spread across the timeline, no near-duplicates). Each becomes
    its own **clip ad**, mixed ~2:1 with composed motion-graphics ads so a batch
    shows both real footage and designed spots. (`js/clips.js`.)
  - **Video DNA — variety, not templates**: every video ad draws a de-duped
    "DNA" — a **headline motion** (lines / word-pop / scale-punch / accent
    sweep), a **camera move** (drift / push-in / push-out / pan), a **colour
    grade** (duotone / warm / noir / vivid + film grain + vignette), a harmonised
    secondary colour, and optional **motion-graphic furniture** (progress bar,
    keyline sweep, corner ticks). No two ads in a batch share a look, and likes /
    dislikes bias the DNA over time. Editable per-ad in **Edit ad**.
  - **Like / dislike + learning**: 👍 / 👎 every ad. A dislike removes it with a
    5-second **Undo**. Likes and dislikes are remembered and, on the next
    Generate, **bias the copy and the DNA engine** toward the attributes you
    like and away from the ones you don't.
- **Ad Performance** — the store of every ad you approve/post. Log metrics
  manually or **import a Meta CSV**, see derived KPIs (CTR/CPC/CPM/CVR/CPA/ROAS),
  leaderboards, side-by-side **Compare**, and a rules-based **“what to do next”**
  engine (scale / pause / refresh / fix landing page).

## Run

```powershell
node server.js
# → http://localhost:3003
```

Zero dependencies — nothing to `npm install`. To enable **AI copy generation**
(Claude), set an Anthropic API key (or just paste one in the app UI):

```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."; node server.js
```

bash:

```bash
ANTHROPIC_API_KEY=sk-ant-... node server.js
```

Everything except AI copy works with no key. The AI model defaults to
`claude-opus-4-8` (override with `ADS_AI_MODEL`).

### Always on

The tool is kept running like the SEO tool: `start-ads-hub-watchdog.bat` runs
`server.js` in a restart-on-crash loop; `start-ads-hub-watchdog-hidden.vbs`
launches it silently and is registered in the Windows **Startup** folder
(shortcut *PARTISANS Ads Hub*). A Task Scheduler job — **PARTISANS Ads Hub
Heartbeat** — runs `heartbeat.ps1` every 5 minutes, pings
`http://localhost:3003/api/ai/status`, and relaunches the watchdog if it's down.
`watchdog.log` / `heartbeat.log` record restarts.

**AI on/off toggle** — the switch top-right (and in the sidebar) turns the AI
copywriter on or off whenever you want; your choice is remembered. If no key is
set, flipping it on lets you **paste a key once** — it's saved to
`ads-hub/data/secret.key` on this machine (the `data/` folder is git-ignored)
and reloaded automatically on every restart. Forget it anytime via **Brand Kit
→ Forget saved key**. A key from `ANTHROPIC_API_KEY` always takes precedence
and can't be overridden from the UI.

## Data

Ads + metrics are stored in your browser (localStorage) **and** auto-backed-up to
`ads-hub/data/store.json` on the server, so they survive a cleared cache. Use
**Export / Import** (sidebar) to move data between machines.

## Architecture

Zero-build vanilla JS, mirroring `studio-hub`:

| File | Role |
|------|------|
| `server.js` | static server + `/api/ai/*` (Claude proxy) + `/api/scrape` (site copy + **image gallery** as data-URIs) + `/api/store` (disk backup) |
| `js/templates.js` | template registry + one CSS-variable-driven stylesheet for every creative |
| `js/render.js` | scaled live preview + **true-1080px PNG export** (SVG rasteriser, embedded fonts) + kind-aware ZIP (PNG for posts, MP4 for video) |
| `js/clips.js` | in-browser video analyzer — samples frames, scores interest, detects shot cuts, picks the best diverse short clips (+ posters) |
| `js/video.js` | canvas motion engine — DNA-driven camera moves, colour grades, kinetic type + clip/footage/image/mesh backgrounds → **MP4/H.264 export** (webm fallback) |
| `js/devices.js` | platform-aware previews (Facebook / Instagram / Twitter-X / TikTok) inside phone/tablet/laptop frames |
| `js/brief.js` | brief ingestion — URL + text + PDF/TXT + images + **video (footage)**; no-AI fallback copywriter |
| `js/ai.js` | Claude copy client (passes learned preferences), site scrape, per-ad AI edit |
| `js/compute.js` | derived KPIs, portfolio rollups/benchmarks, optimisation insight rules |
| `js/generator.js` | brief → DNA variation engine (image/video assignment, preference weighting) → grid + Edit-ad modal |
| `js/performance.js` | dashboard, all-ads, ad detail, compare, CSV import |
| `js/store.js` | model + persistence + like/dislike preference corpus | `js/app.js` | shell, routing, modals, AI toggle |

## AI image generation (Nano Banana)

The **Generate relevant images** panel art-directs original ad photography for
the project: Claude studies the dossier, market research and your input images,
writes shot-list prompts (world-of-the-brand scenes + fresh concepts — never
edits of your inputs), and **Google Gemini (Nano Banana, `gemini-2.5-flash-image`)**
renders them — every image as its own parallel API call, streamed back as each
finishes. Keep/discard picker; kept images persist on the project and join the
input pool for every future Generate. Paste a Gemini key in that panel or Brand
Kit (saved to `data/gemini.key`, git-ignored); keys are verified with Google on
save so a restricted key fails loudly, not silently.

## Roadmap (clean follow-ups, architecture already supports them)

- **Live Meta Marketing API** sync (replace manual/CSV metrics with OAuth pull;
  the ad records already carry campaign/adset/ad IDs).
