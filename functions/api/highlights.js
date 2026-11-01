/**
 * Cloudflare Pages Function: POST /api/highlights
 * Location in project: functions/api/highlights.js
 *
 * Finds the best clip-worthy moments in a video using Gemini.
 *
 * Body (JSON):
 *   { mode: "youtube",    url: "https://youtu.be/...", options }
 *   { mode: "transcript", transcript: "[0:00] text...", title?, durationSeconds?, options }
 *
 * options: { count, minLen, maxLen, focus, longVideo, model }
 *
 * Env:
 *   GEMINI_API_KEY         (secret, required)
 *   GEMINI_MODEL           (optional fallback, default gemini-3.5-flash)
 *   GEMINI_FALLBACK_MODEL  (optional fallback, default gemini-3.1-flash-lite)
 *   APP_PASSWORD           (optional; if set, requests must send x-app-password)
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.5-flash";
const DEFAULT_FALLBACK = "gemini-3.1-flash-lite";
const ALLOWED_MODELS = new Set([
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.7-flash",
]);
const RETRYABLE = new Set([404, 429, 500, 502, 503, 504]);

export async function onRequestPost({ request, env }) {
  const denied = checkPassword(request, env);
  if (denied) return denied;

  if (!env.GEMINI_API_KEY) {
    return json({ error: "GEMINI_API_KEY is not configured. Add it as a secret in your Pages project settings." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }

  const opts = normalizeOptions(body.options);
  const generationConfig = {
    responseMimeType: "application/json",
    thinkingConfig: { thinkingLevel: "MEDIUM" },
  };
  let parts;

  if (body.mode === "youtube") {
    const id = extractYouTubeId(String(body.url || ""));
    if (!id) return json({ error: "That doesn't look like a valid YouTube link." }, 400);
    // Low media resolution = far fewer tokens per frame, lets ~3h videos fit.
    if (opts.longVideo) generationConfig.mediaResolution = "MEDIA_RESOLUTION_LOW";
    parts = [
      { fileData: { fileUri: `https://www.youtube.com/watch?v=${id}` } },
      { text: buildPrompt(opts) },
    ];
  } else if (body.mode === "transcript") {
    const transcript = String(body.transcript || "").trim();
    if (transcript.length < 80) return json({ error: "Transcript is too short to find highlights." }, 400);
    if (transcript.length > 2_000_000) return json({ error: "Transcript is too long (max ~2M characters)." }, 413);
    parts = [{ text: buildPrompt(opts, { transcript, title: body.title }) }];
  } else {
    return json({ error: "mode must be 'youtube' or 'transcript'." }, 400);
  }

  const selectedModel = opts.model || env.GEMINI_MODEL || DEFAULT_MODEL;
  const models = [
    ...new Set([selectedModel, env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK].filter(Boolean)),
  ];
  const payload = { contents: [{ role: "user", parts }], generationConfig };
  const duration = Number(body.durationSeconds) || null;

  let lastError = { status: 502, message: "Gemini request failed." };
  for (const model of models) {
    const r = await callGemini(model, env.GEMINI_API_KEY, payload);
    if (r.ok) {
      const result = normalizeResult(r.data, opts, duration);
      if (result.highlights.length) return json({ ...result, model });
      lastError = { status: 502, message: `[${model}] returned no usable highlights.` };
      continue;
    }
    lastError = r;
    if (!RETRYABLE.has(r.status)) break;
  }

  return json({ error: friendly(lastError.message) }, lastError.status >= 400 && lastError.status < 600 ? lastError.status : 502);
}

/* ------------------------------------------------------------------ */

async function callGemini(model, key, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res, data;
    try {
      res = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(payload),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      return { ok: false, status: 502, message: `[${model}] network error: ${e.message}` };
    }

    if (res.ok) {
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts || [])
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("");
      if (!text) {
        const why = cand?.finishReason || data.promptFeedback?.blockReason || "unknown";
        return { ok: false, status: 502, message: `[${model}] empty response (reason: ${why}).` };
      }
      const parsed = safeParseJSON(text);
      if (!parsed) return { ok: false, status: 502, message: `[${model}] returned invalid JSON.` };
      return { ok: true, data: parsed };
    }

    const message = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 503 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    return { ok: false, status: res.status, message: `[${model}] ${message}` };
  }
  return { ok: false, status: 503, message: `[${model}] overloaded, try again shortly.` };
}

function buildPrompt(o, t) {
  const source = t
    ? `Below is a timestamped transcript${t.title ? ` of "${t.title}"` : ""}. Each line starts with [M:SS] or [H:MM:SS]. Use those timestamps.`
    : `Watch this entire video, paying attention to both the audio and the visuals.`;

  return `${source}

You are an expert short-form video editor. Find the ${o.count} best standalone clips to post as Shorts / Reels / TikToks.
${o.focus ? `Prioritise moments matching: ${o.focus}.\n` : ""}
Rules:
- Each clip must be between ${o.minLen} and ${o.maxLen} seconds long.
- Start at the beginning of a sentence or thought, and end right after the payoff. Someone with zero context must understand it.
- Prefer strong hooks, surprising or bold claims, emotion, humour, clear actionable advice, quotable lines and striking visual moments.
- Clips must not overlap. Timestamps must match the actual video precisely.
- Use "M:SS" format (or "H:MM:SS" past one hour).
- score = 0-100 estimate of how well the clip would perform on its own.

Return ONLY JSON in exactly this shape:
{
  "title": "video title or a short descriptive title",
  "summary": "2-3 sentence summary of the whole video",
  "highlights": [
    {
      "title": "short catchy clip title",
      "start": "M:SS",
      "end": "M:SS",
      "score": 0,
      "hook": "on-screen caption / opening line for the clip",
      "reason": "one sentence on why this moment works",
      "quote": "the key line, verbatim",
      "tags": ["topic", "emotion"]
    }
  ]
}${t ? `\n\nTRANSCRIPT:\n${t.transcript}` : ""}`;
}

function normalizeOptions(o = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const count = clamp(Math.round(num(o.count, 6)), 1, 20);
  const minLen = clamp(Math.round(num(o.minLen, 20)), 5, 600);
  const maxLen = clamp(Math.round(num(o.maxLen, 75)), minLen + 5, 900);
  const focus = String(o.focus || "").slice(0, 300).trim();
  const requestedModel = String(o.model || "").trim();
  const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : null;
  return { count, minLen, maxLen, focus, longVideo: !!o.longVideo, model };
}

function normalizeResult(data, opts, duration) {
  const raw = Array.isArray(data) ? data : data?.highlights || data?.clips || [];
  const highlights = [];
  for (const h of raw) {
    if (!h || typeof h !== "object") continue;
    const start = pickTime(h.start, h.start_seconds);
    let end = pickTime(h.end, h.end_seconds);
    if (!Number.isFinite(start) || start < 0) continue;
    if (!Number.isFinite(end) || end <= start) end = start + opts.minLen;
    if (duration) {
      if (start >= duration) continue;
      end = Math.min(end, duration);
    }
    highlights.push({
      title: str(h.title, 120) || "Untitled clip",
      start: round(start),
      end: round(end),
      score: clamp(Math.round(Number(h.score) || 0), 0, 100),
      hook: str(h.hook, 300),
      reason: str(h.reason, 600),
      quote: str(h.quote, 400),
      tags: Array.isArray(h.tags) ? h.tags.map((t) => str(t, 30)).filter(Boolean).slice(0, 6) : [],
    });
  }
  highlights.sort((a, b) => a.start - b.start);
  return { title: str(data?.title, 200), summary: str(data?.summary, 1200), highlights };
}

function pickTime(s, secs) {
  const a = parseTime(s);
  if (Number.isFinite(a)) return a;
  const b = Number(secs);
  return Number.isFinite(b) ? b : NaN;
}

function parseTime(v) {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim().replace(/^\[|\]$/g, "");
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const p = s.split(":").map(Number);
  if (p.length > 3 || p.some((n) => !Number.isFinite(n))) return NaN;
  return p.reduce((acc, n) => acc * 60 + n, 0);
}

function extractYouTubeId(url) {
  const clean = (id) => {
    id = String(id || "").split(/[/?#&]/)[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  };
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, "");
    if (host === "youtu.be") return clean(u.pathname.slice(1));
    if (host.endsWith("youtube.com") || host === "youtube-nocookie.com") {
      if (u.searchParams.get("v")) return clean(u.searchParams.get("v"));
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
      if (m) return clean(m[2]);
    }
  } catch {}
  return clean(url.trim());
}

function safeParseJSON(text) {
  const attempts = [
    text,
    text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, ""),
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  ];
  for (const t of attempts) {
    try {
      return JSON.parse(t);
    } catch {}
  }
  return null;
}

function friendly(msg = "") {
  if (/private|unlisted|not (be )?available|permission|cannot access/i.test(msg)) {
    return `${msg}. Gemini can only read public YouTube videos. Try the Transcript tab instead.`;
  }
  if (/quota|rate.?limit|exhausted|429/i.test(msg)) {
    return `${msg}. You've hit the free-tier limit. Wait a bit or try again tomorrow.`;
  }
  return msg;
}

function checkPassword(request, env) {
  if (!env.APP_PASSWORD) return null;
  if (request.headers.get("x-app-password") === env.APP_PASSWORD) return null;
  return json({ error: "Password required." }, 401);
}

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const round = (n) => Math.round(n * 10) / 10;
const str = (v, max) => (v == null ? "" : String(v).trim().slice(0, max));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
