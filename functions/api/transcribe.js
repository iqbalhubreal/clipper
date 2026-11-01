/**
 * Cloudflare Pages Function: POST /api/transcribe
 * Location in project: functions/api/transcribe.js
 *
 * Transcribes ONE short audio chunk (the browser splits audio into ~2 min MP3s
 * with ffmpeg.wasm, so this function stays tiny and fast).
 *
 * Body (JSON): { audio: "<base64 mp3>", offset: <seconds>, language?: "en" }
 * Returns:     { text, segments: [{ start, end, text }], model }
 *
 * Env:
 *   AI             (Workers AI binding, configured in wrangler.toml)
 *   WHISPER_MODEL  (optional, default @cf/openai/whisper-large-v3-turbo)
 *   APP_PASSWORD   (optional)
 */

const DEFAULT_WHISPER = "@cf/openai/whisper-large-v3-turbo";

export async function onRequestPost({ request, env }) {
  if (env.APP_PASSWORD && request.headers.get("x-app-password") !== env.APP_PASSWORD) {
    return json({ error: "Password required." }, 401);
  }
  if (!env.AI) {
    return json({ error: "Workers AI binding 'AI' is missing. Check wrangler.toml / Pages bindings." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }

  const audio = body.audio;
  const offset = Number(body.offset) || 0;
  if (typeof audio !== "string" || audio.length < 100) return json({ error: "No audio received." }, 400);
  if (audio.length > 20_000_000) return json({ error: "Audio chunk too large. Use shorter chunks." }, 413);

  const model = env.WHISPER_MODEL || DEFAULT_WHISPER;
  let input;
  if (model === "@cf/openai/whisper") {
    // The original whisper model expects an array of bytes instead of base64.
    const bin = atob(audio);
    const bytes = new Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    input = { audio: bytes };
  } else {
    input = { audio };
    if (body.language) input.language = String(body.language).slice(0, 10);
  }

  let out;
  try {
    out = await env.AI.run(model, input);
  } catch (e) {
    return json({ error: `Transcription failed: ${e.message || e}` }, 502);
  }

  let segments = [];
  if (Array.isArray(out?.segments) && out.segments.length) {
    segments = out.segments.map((s) => ({
      start: round(Number(s.start) + offset),
      end: round(Number(s.end) + offset),
      text: String(s.text || "").trim(),
    }));
  } else if (Array.isArray(out?.words) && out.words.length) {
    // Group word timings into ~8 second lines.
    let cur = null;
    for (const w of out.words) {
      const ws = Number(w.start) + offset;
      const we = Number(w.end) + offset;
      if (!cur || ws - cur.start > 8) {
        if (cur) segments.push(cur);
        cur = { start: round(ws), end: round(we), text: "" };
      }
      cur.text += (cur.text ? " " : "") + String(w.word || "").trim();
      cur.end = round(we);
    }
    if (cur) segments.push(cur);
  } else if (out?.text) {
    segments = [{ start: offset, end: offset, text: String(out.text).trim() }];
  }

  segments = segments.filter((s) => s.text && Number.isFinite(s.start));
  return json({ text: out?.text || "", segments, model });
}

const round = (n) => Math.round(n * 10) / 10;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
