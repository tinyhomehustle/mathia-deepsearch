# MATHIA DeepSearch

Backend for **MATHIA DeepSearch** — MATHIA's built-in web search and browsing experience.

## Current endpoints

- `GET /` — service status
- `GET /health` — health check
- `GET /api/fetch?url=https://example.com` — fetch a public text/web page

## Built-in protections

- HTTP/HTTPS only
- Blocks localhost, private IP ranges, link-local addresses, and reserved network destinations
- Re-checks redirect destinations
- Request timeout
- Response-size limit
- Basic per-IP rate limiting
- Browser CORS allowlist for MATHIA domains

## Run locally

```bash
npm start
```

Render should run the same command automatically from `package.json`.

This is the first backend version for MATHIA 2.1. The frontend browser/search UI comes after the backend is deployed and tested.
