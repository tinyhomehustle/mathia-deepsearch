# MATHIA DeepSearch v0.3 — Real Browser Engine

This is the upgrade for the existing GitHub repository **`tinyhomehustle/mathia-deepsearch`**. Instead of trying to make websites work by fetching HTML, DeepSearch now runs a **real server-side headless Chromium** and shows the rendered browser interactively.

## What changes

- `https://deepsearch.mathia.online/` shows the new DeepSearch browser interface instead of a JSON status message.
- JavaScript-heavy websites execute inside Chromium, so users can search, click, type, scroll, navigate Back/Forward, and Reload.
- WebSocket stream sends browser screenshot frames to the interface; clicks and keystrokes travel back to Chromium.
- `GET /api/search` remains available to the current MATHIA 2.1 search pane; it uses DuckDuckGo HTML search and can be unavailable if the provider blocks the server.
- `GET /api/fetch` remains compatible with the current MATHIA 2.1 webpage viewer, and now returns HTML *after* Chromium renders it. **This compatibility route remains noninteractive** inside MATHIA's older iframe; use the new browser interface for real interactivity.
- `/health` returns service state and whether Chromium is currently running.

## Upload to GitHub

At the root of the **mathia-deepsearch** repository, upload these five files, replacing matching existing files:

1. `server.js`
2. `package.json`
3. `index.html` (new)
4. `puppeteer.config.cjs` (new)
5. `README.md`

`package.json` installs Puppeteer and `ws`. `puppeteer.config.cjs` makes Puppeteer download the Chromium binary into the project, ensuring Render's runtime can find it after building.

**Do not upload the ZIP directly into GitHub**: extract it first, then upload those five individual files. Upload only to `mathia-deepsearch`, not unrelated repositories.

## Render deployment

Existing settings can stay:

- Runtime: Node (20+)
- Build: `npm install`
- Start: `npm start`
- The environment variable `PORT` is supplied by Render.

Puppeteer's `npm install` lifecycle fetches a Chromium binary on deployment. This can take longer than the previous build and can fail if the free tier's memory, disk, or Linux dependencies are insufficient. **The current package cannot guarantee Chrome will run on Render Free.** If startup fails, check Render Logs for messages about missing shared libraries, browser download, or memory. A larger instance or a separate browser service might be needed.

### After deployment

Open:

- `https://deepsearch.mathia.online/` — new interactive browser
- `https://deepsearch.mathia.online/health` — backend state

You may also open `https://mathia-deepsearch.onrender.com/` as a fallback.

## API

- `GET /` and `GET /browser` — interactive viewer UI
- `GET /health` — service and browser status
- `GET /api/search?q=NBA%20standings` — web search (third-party HTML provider)
- `GET /api/fetch?url=https://example.com` — Chromium-rendered HTML, compatible with MATHIA 2.1
- `POST /api/browser/session` — create isolated temporary browser session, receives `{id,token,width,height}`
- `WS /api/browser/ws?session=<id>&token=<token>` — frame stream and browser input
- `POST /api/browser/:id/navigate` — body `{ "url": "https://www.wikipedia.org/" }`
- `POST /api/browser/:id/back` / `forward` / `reload`
- `POST /api/browser/:id/action` — body `{ "type": "click", "x": 500, "y": 300 }`
- `POST /api/browser/:id/viewport` — body `{ "width": 1160, "height": 710 }`
- `GET /api/browser/:id/frame` — JPEG screenshot
- `DELETE /api/browser/:id` — end session

HTTP calls to an existing session require `X-DeepSearch-Token: <token>`.

### WebSocket messages

Browser → frontend: `ready`, `state`, `frame` (base64 JPEG), `error`.

Frontend → browser examples:

```json
{"type":"navigate","url":"https://www.wikipedia.org/"}
{"type":"click","x":450,"y":290}
{"type":"wheel","deltaY":600}
{"type":"insertText","text":"MATHIA"}
{"type":"press","key":"Enter"}
{"type":"back"}
{"type":"forward"}
{"type":"reload"}
{"type":"heartbeat"}
```

## Resource use and protections

Defaults: one browser session at a time (to minimize memory), four-minute idle expiry, per-client request throttling, temporary browser contexts, public HTTP/HTTPS URL validation, DNS checks, per-request filtering of browser requests, limited input sizes, short random session credentials, and origin-checked WebSocket connections.

These mitigations do **not** make an open public browser service completely abuse-proof. Avoid treating it as a bypass for school/network restrictions. Use additional authentication and egress controls before operating as a widely used multiuser browser service.

## Limits

This is a **remote headless browser**, not a full desktop installation of Chrome. Some sites block automation; DRM/video playback, YouTube sign-in, Xbox cloud gaming, WebRTC, downloads, audio and some login flows may not work. Currently **there is no sound stream**. Rendering frames is CPU/memory intensive.

**Main-site integration:** The existing MATHIA 2.1 UI still uses its legacy HTML-based viewer. The new interactive engine is immediately usable at `deepsearch.mathia.online` after deployment. Embedding the new viewer in the DeepSearch tab requires a later MATHIA HTML/frontend update; this backend-only repo upload does not silently modify your Netlify site or Home Screen.
