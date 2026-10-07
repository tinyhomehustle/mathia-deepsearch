import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";

const PORT = Number(process.env.PORT || 10000);

const ALLOWED_ORIGINS = new Set([
  "https://mathia.online",
  "https://www.mathia.online",
  "https://mathiagang.netlify.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);

const MAX_BODY_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;

const rateBuckets = new Map();

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(payload);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      "access-control-allow-origin": origin,
      "vary": "Origin",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Content-Type",
      "access-control-max-age": "86400"
    };
  }
  return {};
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimit(req) {
  const now = Date.now();
  const ip = getClientIp(req);
  const current = rateBuckets.get(ip);

  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { startedAt: now, count: 1 });
    return { ok: true };
  }

  current.count += 1;
  if (current.count > RATE_LIMIT) {
    return {
      ok: false,
      retryAfter: Math.max(
        1,
        Math.ceil((RATE_WINDOW_MS - (now - current.startedAt)) / 1000)
      )
    };
  }

  return { ok: true };
}

function isBlockedIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((x) => Number.isNaN(x) || x < 0 || x > 255)) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(ip) {
  const normalized = ip.toLowerCase();

  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (net.isIP(mapped) === 4) return isBlockedIpv4(mapped);
  }

  return false;
}

function isBlockedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

async function assertPublicHostname(hostname) {
  const lower = hostname.toLowerCase().replace(/\.$/, "");

  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  ) {
    throw new Error("That hostname is not allowed.");
  }

  const records = await dns.lookup(lower, { all: true, verbatim: true });
  if (!records.length) throw new Error("Could not resolve that hostname.");

  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new Error("Private or reserved network addresses are not allowed.");
    }
  }
}

async function validateTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http:// and https:// URLs are supported.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing usernames or passwords are not allowed.");
  }

  if (!url.hostname) {
    throw new Error("The URL needs a hostname.");
  }

  await assertPublicHostname(url.hostname);
  return url;
}

function isTextLike(contentType) {
  const type = (contentType || "").toLowerCase();
  return (
    type.startsWith("text/") ||
    type.includes("application/json") ||
    type.includes("application/xml") ||
    type.includes("application/xhtml+xml") ||
    type.includes("application/javascript")
  );
}

async function readBodyWithLimit(response) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error("That page is too large for DeepSearch right now.");
    }

    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

async function fetchPublicPage(initialUrl) {
  let currentUrl = await validateTarget(initialUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "MATHIA-DeepSearch/0.1 (+https://mathia.online)",
          "accept": "text/html,text/plain,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.2",
          "accept-language": "en-US,en;q=0.8"
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === MAX_REDIRECTS) {
        throw new Error("Too many redirects.");
      }

      const location = response.headers.get("location");
      if (!location) throw new Error("The site returned a broken redirect.");

      const next = new URL(location, currentUrl);
      currentUrl = await validateTarget(next.href);
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!isTextLike(contentType)) {
      throw new Error(
        `DeepSearch currently supports text/web pages only. The site returned ${contentType || "an unknown file type"}.`
      );
    }

    const body = await readBodyWithLimit(response);

    return {
      requestedUrl: initialUrl,
      finalUrl: currentUrl.href,
      status: response.status,
      ok: response.ok,
      contentType,
      body
    };
  }

  throw new Error("Could not fetch that page.");
}

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== "GET") {
    return json(res, 405, { error: "Method not allowed." }, cors);
  }

  const limit = rateLimit(req);
  if (!limit.ok) {
    return json(
      res,
      429,
      {
        error: "Too many DeepSearch requests. Try again in a moment.",
        retryAfterSeconds: limit.retryAfter
      },
      { ...cors, "retry-after": String(limit.retryAfter) }
    );
  }

  let parsed;
  try {
    parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return json(res, 400, { error: "Bad request." }, cors);
  }

  if (parsed.pathname === "/") {
    return json(
      res,
      200,
      {
        name: "MATHIA DeepSearch",
        status: "online",
        version: "0.1.0",
        message: "DeepSearch backend is online 🌐"
      },
      cors
    );
  }

  if (parsed.pathname === "/health") {
    return json(
      res,
      200,
      {
        ok: true,
        service: "mathia-deepsearch",
        version: "0.1.0"
      },
      cors
    );
  }

  if (parsed.pathname === "/api/fetch") {
    const rawUrl = parsed.searchParams.get("url");
    if (!rawUrl) {
      return json(
        res,
        400,
        {
          error: "Missing url parameter.",
          example: "/api/fetch?url=https%3A%2F%2Fexample.com"
        },
        cors
      );
    }

    try {
      const page = await fetchPublicPage(rawUrl);
      return json(res, 200, page, cors);
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "That site took too long to respond."
          : error?.message || "DeepSearch could not fetch that page.";

      return json(res, 400, { error: message }, cors);
    }
  }

  return json(res, 404, { error: "Not found." }, cors);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MATHIA DeepSearch listening on port ${PORT}`);
});
