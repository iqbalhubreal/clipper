// Clipper frontend logic.  Location in project: public/app.js
// No framework. ffmpeg.wasm is lazy-loaded only when you use the Upload tab.

const CHUNK_SECONDS = 120; // audio chunk length sent to Whisper
const PW_KEY = "clipper.password";
const HISTORY_KEY = "clipper.history";
const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  tab: "youtube",
  file: null,
  fileURL: null,
  duration: null,
  source: null, // {type:"youtube"|"file"|"transcript", videoId?, url?, name?}
  result: null,
  sort: "time",
  busy: false,
  ffInName: null,
  jsonExports: [],
};

/* ============================== utils ============================== */

function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function parseTime(v) {
  if (typeof v === "number") return v;
  const s = String(v ?? "").trim().replace(",", ".");
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const p = s.split(":").map(Number);
  if (p.length > 3 || p.some((n) => !Number.isFinite(n))) return NaN;
  return p.reduce((a, n) => a * 60 + n, 0);
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
  return clean(String(url || "").trim());
}
function bytesToBase64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
}
function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function slug(s) {
  return (String(s || "clip").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "clip").slice(0, 60);
}
let toastTimer;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "error" ? 8000 : 3000);
}

// Keep the screen awake during long jobs (phones kill background tabs).
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

function setBusy(on, msg = "Working...") {
  state.busy = on;
  $("#busy").hidden = !on;
  $("#busy-text").textContent = msg;
  $("#go").disabled = on;
  keepAwake(on);
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied ✓");
  } catch {
    toast("Couldn't access clipboard", "error");
  }
}

/* ============================== API ============================== */

async function api(path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-password": localStorage.getItem(PW_KEY) || "" },
      body: JSON.stringify(body),
    });
    if (res.status === 401 && attempt === 0) {
      const pw = prompt("This Clipper is password-protected. Enter password:");
      if (!pw) throw new Error("Password required.");
      localStorage.setItem(PW_KEY, pw);
      continue;
    }
    const data = await res.json().catch(() => ({ error: `Server error (HTTP ${res.status})` }));
    if (!res.ok) {
      if (res.status === 401) localStorage.removeItem(PW_KEY);
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }
}

function getOptions() {
  return {
    count: 6,
    minLen: 20,
    maxLen: 75,
    focus: $("#opt-focus").value.trim(),
    model: $("#opt-model").value,
    endingStyle: $("#opt-ending").value,
    watchPercent: +$("#opt-watch").value || 100,
    longVideo: false,
  };
}

/* ============================== ffmpeg.wasm ============================== */

let ffPromise = null;
let ffProgress = null;
let ffInputFile = null;

function getFFmpeg() {
  if (ffPromise) return ffPromise;
  ffPromise = (async () => {
    let FFmpeg, toBlobURL;
    try {
      ({ FFmpeg } = await import("/vendor/ffmpeg/index.js"));
      ({ toBlobURL } = await import("/vendor/util/index.js"));
    } catch {
      throw new Error("ffmpeg.wasm files not found in /vendor. Make sure the build command `npm run build` ran (see README).");
    }
    const ff = new FFmpeg();
    ff.on("progress", ({ progress }) => ffProgress && ffProgress(progress));
    ff.on("log", ({ message }) => window.CLIPPER_DEBUG && console.log("[ffmpeg]", message));
    await ff.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });
    return ff;
  })();
  ffPromise.catch(() => (ffPromise = null));
  return ffPromise;
}

async function ensureInput(ff, file) {
  if (ffInputFile === file && state.ffInName) return state.ffInName;
  if (state.ffInName) {
    try { await ff.deleteFile(state.ffInName); } catch {}
  }
  const ext = (file.name.match(/\.[a-z0-9]{1,5}$/i)?.[0] || ".mp4").toLowerCase();
  const name = "input" + ext;
  await ff.writeFile(name, new Uint8Array(await file.arrayBuffer()));
  ffInputFile = file;
  state.ffInName = name;
  return name;
}

/* ============================== flows ============================== */

async function run() {
  if (state.busy) return;
  try {
    await runCombinedWorkflow();
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), "error");
  } finally {
    setBusy(false);
    ffProgress = null;
  }
}

async function runCombinedWorkflow() {
  const file = state.file;
  const url = $("#yt-url").value.trim();
  const videoId = extractYouTubeId(url);
  if (!videoId) return toast("Paste a valid YouTube URL first.", "error");
  if (!file) return toast("Upload the matching video file first.", "error");
  const maxBytes = isMobile() ? 500e6 : 1.8e9;
  if (file.size > maxBytes) return toast(`File too large for this device (max ~${Math.round(maxBytes / 1e6)} MB).`, "error");
  setBusy(true, "Gemini is reading the YouTube URL and finding highlights...");
  const data = await api("/api/highlights", { mode: "youtube", url, options: getOptions() });
  if (!data.highlights?.length) throw new Error("Gemini did not return any usable highlights.");
  showResult(data, { type: "file", name: file.name, videoId, url }, null);
  await cutSections(data.highlights.map((h) => ({ ...h, title: h.title || "Highlight" })));
}

function clearJSONExports() {
  for (const item of state.jsonExports) {
    URL.revokeObjectURL(item.url);
    if (item.verticalUrl) URL.revokeObjectURL(item.verticalUrl);
  }
  state.jsonExports = [];
  $("#json-cut-list").hidden = true;
  $("#json-cut-list").innerHTML = "";
  $("#bulk-download-row").hidden = true;
  $("#vertical-row").hidden = true;
}

function renderJSONExports() {
  const list = $("#json-cut-list");
  list.innerHTML = state.jsonExports.map((item, i) => `
    <div class="json-cut">
      <div><strong>${i + 1}. ${esc(item.title)}</strong><small>${fmt(item.start)} → ${fmt(item.end)} · ${Math.round(item.end - item.start)}s</small></div>
      <div class="row"><a class="btn primary" href="${item.url}" download="${esc(item.name)}">⬇ MP4</a>${item.verticalUrl ? `<a class="btn" href="${item.verticalUrl}" download="${esc(item.verticalName)}">⬇ 9:16</a>` : ""}</div>
    </div>`).join("");
  list.hidden = false;
  $("#bulk-download-row").hidden = false;
  $("#vertical-row").hidden = false;
}

async function cutSections(highlights) {
  const file = state.file;
  if (!file) throw new Error("Choose a video file first.");
  clearJSONExports();
  const cuts = highlights.map((h, i) => {
    const start = Math.max(0, Number(h.start) - 2);
    const end = state.duration ? Math.min(state.duration, Number(h.end) + 2) : Number(h.end) + 2;
    return { ...h, start, end, originalStart: Number(h.start), originalEnd: Number(h.end), title: h.title || `Highlight ${i + 1}` };
  }).filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  try {
    setBusy(true, "Loading video engine (~30 MB, first time only)...");
    const ff = await getFFmpeg();
    setBusy(true, "Reading the uploaded video...");
    const input = await ensureInput(ff, file);
    for (let i = 0; i < cuts.length; i++) {
      const cut = cuts[i];
      const out = `highlight_cut_${String(i).padStart(3, "0")}.mp4`;
      const args = ["-ss", cut.start.toFixed(2), "-i", input, "-t", (cut.end - cut.start).toFixed(2), "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", out];
      ffProgress = (p) => setBusy(true, `Cutting ${i + 1} of ${cuts.length}... ${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`);
      setBusy(true, `Cutting ${i + 1} of ${cuts.length}: “${cut.title}”...`);
      const code = await ff.exec(args);
      if (code !== 0) throw new Error(`FFmpeg failed on “${cut.title}”.`);
      const data = await ff.readFile(out);
      state.jsonExports.push({
        title: cut.title,
        start: cut.start,
        end: cut.end,
        originalStart: Number(cut.originalStart ?? cut.start),
        originalEnd: Number(cut.originalEnd ?? cut.end),
        score: cut.score || 0,
        hook: cut.hook || "",
        reason: cut.reason || "",
        quote: cut.quote || "",
        tags: Array.isArray(cut.tags) ? cut.tags : [],
        name: `${String(i + 1).padStart(2, "0")}-${slug(cut.title)}.mp4`,
        url: URL.createObjectURL(new Blob([data], { type: "video/mp4" })),
      });
      try { await ff.deleteFile(out); } catch {}
      renderJSONExports();
    }
    toast(`${cuts.length} clip${cuts.length === 1 ? "" : "s"} ready with 2-second handles ✓`);
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), "error");
  } finally {
    ffProgress = null;
    setBusy(false);
  }
}

async function makeVerticalVersions() {
  if (!state.jsonExports.length || state.busy) return;
  try {
    setBusy(true, "Loading video editor...");
    const ff = await getFFmpeg();
    const input = await ensureInput(ff, state.file);
    for (let i = 0; i < state.jsonExports.length; i++) {
      const item = state.jsonExports[i];
      const out = `vertical_cut_${String(i).padStart(3, "0")}.mp4`;
      const args = [
        "-ss", item.start.toFixed(2), "-i", input, "-t", (item.end - item.start).toFixed(2),
        "-vf", "crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)',scale=720:1280,setsar=1",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
      ];
      ffProgress = (p) => setBusy(true, `Making 9:16 version ${i + 1} of ${state.jsonExports.length}... ${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`);
      setBusy(true, `Making 9:16 version ${i + 1} of ${state.jsonExports.length}...`);
      const code = await ff.exec(args);
      if (code !== 0) throw new Error(`Could not create a 9:16 version of “${item.title}”.`);
      const data = await ff.readFile(out);
      if (item.verticalUrl) URL.revokeObjectURL(item.verticalUrl);
      item.verticalName = `${item.name.replace(/\.mp4$/i, "")}-9x16.mp4`;
      item.verticalUrl = URL.createObjectURL(new Blob([data], { type: "video/mp4" }));
      try { await ff.deleteFile(out); } catch {}
      renderJSONExports();
    }
    toast("9:16 versions ready ✓");
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), "error");
  } finally {
    ffProgress = null;
    setBusy(false);
  }
}

/* ============================== results ============================== */

function showResult(data, source, transcript) {
  state.result = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    title: data.title,
    summary: data.summary,
    model: data.model,
    highlights: data.highlights || [],
    source,
    transcript: transcript || null,
  };
  saveHistory(state.result);
  renderResult();
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  toast(`Found ${state.result.highlights.length} highlights ✨`);
}

function canExport() {
  const src = state.result?.source;
  return src?.type === "file" && state.file && state.file.name === src.name;
}

function renderResult() {
  const r = state.result;
  if (!r) return ($("#results").hidden = true);
  $("#results").hidden = false;
  $("#res-title").textContent = r.title || r.source?.name || "Highlights";
  $("#res-summary").textContent = r.summary || "";
  $("#res-meta").textContent = `${r.highlights.length} clips · ${r.model || ""} · ${new Date(r.createdAt).toLocaleString()}`;
  $("#sort").value = state.sort;
  setupPlayer();
  renderCards();

  const box = $("#transcript-box");
  if (r.transcript?.length) {
    box.hidden = false;
    $("#transcript-lines").innerHTML = r.transcript
      .map((s) => `<div class="tl"><button data-t="${s.start}">${fmt(s.start)}</button><span>${esc(s.text)}</span></div>`)
      .join("");
  } else {
    box.hidden = true;
  }
}

function renderCards() {
  const r = state.result;
  const list = r.highlights.map((h, i) => ({ ...h, _i: i }));
  if (state.sort === "score") list.sort((a, b) => (b.score || 0) - (a.score || 0));
  else list.sort((a, b) => a.start - b.start);
  $("#cards").innerHTML = list.length ? list.map(cardHTML).join("") : `<p class="hint">No highlights.</p>`;
}

function cardHTML(h) {
  const dur = Math.max(0, h.end - h.start);
  const yt = !!state.result.source?.videoId;
  return `<article class="card" data-i="${h._i}">
    <div class="card-top">
      <span class="score" style="--s:${h.score || 0}"><b>${h.score || "–"}</b></span>
      <h3>${esc(h.title)}</h3>
    </div>
    <div class="times">
      <button class="mini" data-act="set-start" title="Set start to current player time">⇤ now</button>
      <input data-field="start" value="${fmt(h.start)}" aria-label="Start time" inputmode="decimal" />
      <span>→</span>
      <input data-field="end" value="${fmt(h.end)}" aria-label="End time" inputmode="decimal" />
      <button class="mini" data-act="set-end" title="Set end to current player time">now ⇥</button>
      <span class="dur">${Math.round(dur)}s</span>
    </div>
    ${h.hook ? `<p class="hook">“${esc(h.hook)}”</p>` : ""}
    ${h.reason ? `<p class="reason">${esc(h.reason)}</p>` : ""}
    ${h.tags?.length ? `<div class="tags">${h.tags.map((t) => `<span>#${esc(t)}</span>`).join("")}</div>` : ""}
    <div class="actions">
      <button data-act="play">▶ Play clip</button>
      ${yt ? `<button data-act="link">🔗 Copy link</button>` : ""}
      ${h.hook ? `<button data-act="copy">📋 Copy hook</button>` : ""}
      ${canExport() ? `<button data-act="export" class="primary">⬇ Export MP4</button>` : ""}
      <button data-act="delete" class="ghost" title="Remove clip">✕</button>
    </div>
  </article>`;
}

function markPlaying(i) {
  $$(".card").forEach((c) => c.classList.toggle("playing", +c.dataset.i === i));
}

/* ============================== player ============================== */

let ytPlayer = null, ytVideo = null, ytAPI = null, stopAt = null;

function loadYTAPI() {
  return (ytAPI ||= new Promise((res) => {
    if (window.YT?.Player) return res();
    window.onYouTubeIframeAPIReady = () => res();
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.append(s);
  }));
}

async function ensureYT(videoId) {
  await loadYTAPI();
  const el = document.getElementById("yt-player");
  if (ytPlayer && el?.tagName === "IFRAME") {
    if (ytVideo !== videoId) {
      ytPlayer.cueVideoById(videoId);
      ytVideo = videoId;
    }
    return;
  }
  await new Promise((res) => {
    ytPlayer = new YT.Player("yt-player", {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
      events: { onReady: () => res() },
    });
  });
  ytVideo = videoId;
}

function setupPlayer() {
  const src = state.result.source || {};
  const wrap = $("#player");
  if (src.type === "file" && state.fileURL && state.file?.name === src.name) {
    if (wrap.dataset.kind !== "file" || $("#player video")?.src !== state.fileURL) {
      wrap.innerHTML = `<video controls playsinline src="${state.fileURL}"></video>`;
      wrap.dataset.kind = "file";
      ytPlayer = null;
      $("#player video").addEventListener("timeupdate", (e) => {
        if (stopAt != null && e.target.currentTime >= stopAt) {
          e.target.pause();
          stopAt = null;
        }
      });
    }
  } else if (src.videoId) {
    if (wrap.dataset.kind !== "yt") {
      wrap.innerHTML = `<div id="yt-player"></div>`;
      wrap.dataset.kind = "yt";
      ytPlayer = null;
    }
    ensureYT(src.videoId).catch(() => toast("Couldn't load the YouTube player.", "error"));
  } else {
    wrap.dataset.kind = "none";
    ytPlayer = null;
    wrap.innerHTML = `<div class="placeholder">${
      src.type === "file"
        ? `Re-select <b>&nbsp;${esc(src.name)}&nbsp;</b> in the Upload tab to preview & export these clips.`
        : "No video to preview. Add a YouTube URL in the Transcript tab to preview clips."
    }</div>`;
  }
}

function currentTime() {
  const kind = $("#player").dataset.kind;
  if (kind === "yt" && ytPlayer?.getCurrentTime) return ytPlayer.getCurrentTime();
  if (kind === "file") return $("#player video")?.currentTime ?? NaN;
  return NaN;
}

async function playRange(start, end) {
  const kind = $("#player").dataset.kind;
  if (kind === "yt") {
    await ensureYT(state.result.source.videoId);
    const opts = { videoId: state.result.source.videoId, startSeconds: start };
    if (end) opts.endSeconds = end;
    ytPlayer.loadVideoById(opts);
  } else if (kind === "file") {
    const v = $("#player video");
    stopAt = end || null;
    v.currentTime = start;
    v.play().catch(() => {});
  } else {
    return toast("No video loaded to preview.", "error");
  }
  if (window.innerWidth < 900) window.scrollTo({ top: $("#results").offsetTop - 60, behavior: "smooth" });
}

/* ============================== export ============================== */

// On phones: show a "Save / Share" button (the share sheet needs a fresh tap,
// and a long export uses up the original tap). On desktop: normal download.
let pendingShare = null;
function deliverClip(blob, name, title) {
  const file = new File([blob], name, { type: "video/mp4" });
  if (isMobile() && navigator.canShare?.({ files: [file] })) {
    pendingShare = { file, blob, name, title };
    $("#sharebar-text").textContent = `“${title}” is ready`;
    $("#sharebar").hidden = false;
  } else {
    downloadBlob(blob, name);
    toast("Clip exported ✓");
  }
}

async function exportClip(i) {
  const h = state.result.highlights[i];
  const mode = "fast";
  if (state.busy) return;
  try {
    setBusy(true, "Loading video engine...");
    const ff = await getFFmpeg();
    setBusy(true, "Preparing file...");
    const input = await ensureInput(ff, state.file);
    const dur = Math.max(1, h.end - h.start).toFixed(2);
    const start = h.start.toFixed(2);
    const out = "clip_out.mp4";
    let args;
    if (mode === "fast") {
      args = ["-ss", start, "-i", input, "-t", dur, "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", out];
    } else {
      const vf =
        mode === "vertical"
          ? ["-vf", "crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)',scale=720:1280,setsar=1"]
          : [];
      args = ["-ss", start, "-i", input, "-t", dur, ...vf,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out];
    }
    ffProgress = (p) => setBusy(true, `Exporting “${h.title}”... ${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`);
    setBusy(true, `Exporting “${h.title}”...`);
    const code = await ff.exec(args);
    if (code !== 0) throw new Error("ffmpeg failed to export this clip. Try 'Accurate' export mode.");
    const data = await ff.readFile(out);
    try { await ff.deleteFile(out); } catch {}
    const name = `${String(i + 1).padStart(2, "0")}-${slug(h.title)}.mp4`;
    deliverClip(new Blob([data], { type: "video/mp4" }), name, h.title);
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), "error");
  } finally {
    ffProgress = null;
    setBusy(false);
  }
}

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function zipCRC(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = ZIP_CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipU16(n) {
  return new Uint8Array([n & 255, (n >>> 8) & 255]);
}

function zipU32(n) {
  return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
}

function zipHeader(signature, name, crc, size, offset = null) {
  const nameBytes = new TextEncoder().encode(name);
  const common = [zipU32(signature), zipU16(20), zipU16(0x800), zipU16(0), zipU16(0), zipU16(0), zipU32(crc), zipU32(size), zipU32(size), zipU16(nameBytes.length), zipU16(0)];
  if (offset == null) return new Uint8Array([...common.flatMap((x) => [...x]), ...nameBytes]);
  return new Uint8Array([
    ...zipU32(signature), ...zipU16(20), ...zipU16(20), ...zipU16(0x800), ...zipU16(0), ...zipU16(0), ...zipU16(0),
    ...zipU32(crc), ...zipU32(size), ...zipU32(size), ...zipU16(nameBytes.length), ...zipU16(0), ...zipU16(0),
    ...zipU16(0), ...zipU16(0), ...zipU32(0), ...zipU32(offset), ...nameBytes,
  ]);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

async function downloadAllZip() {
  if (!state.jsonExports.length || state.busy) return;
  try {
    setBusy(true, "Packaging clips and metadata into a ZIP...");
    const metadata = state.jsonExports.map((item, i) => ({
      number: i + 1,
      filename: item.name,
      verticalFilename: item.verticalName || null,
      title: item.title,
      hashtags: (item.tags || []).map((tag) => `#${tag.replace(/^#/, "")}`),
      aiStart: fmt(item.originalStart),
      aiEnd: fmt(item.originalEnd),
      cutStart: fmt(item.start),
      cutEnd: fmt(item.end),
      score: item.score,
      hook: item.hook,
      reason: item.reason,
      quote: item.quote,
    }));
    const csvRows = [["#", "filename", "title", "hashtags", "AI start", "AI end", "cut start", "cut end", "score", "hook", "reason", "quote"]];
    metadata.forEach((m) => csvRows.push([m.number, m.filename, m.title, m.hashtags.join(" "), m.aiStart, m.aiEnd, m.cutStart, m.cutEnd, m.score, m.hook, m.reason, m.quote]));
    const entries = [
      { name: "metadata.json", bytes: new TextEncoder().encode(JSON.stringify({ title: state.result?.title || "Clips", clips: metadata }, null, 2)) },
      { name: "metadata.csv", bytes: new TextEncoder().encode(csvRows.map((row) => row.map(csvCell).join(",")).join("\n")) },
    ];
    for (const item of state.jsonExports) {
      setBusy(true, `Packaging ${item.name}...`);
      entries.push({ name: `clips/${item.name}`, bytes: new Uint8Array(await (await fetch(item.url)).arrayBuffer()) });
      if (item.verticalUrl) {
        setBusy(true, `Packaging ${item.verticalName}...`);
        entries.push({ name: `clips/${item.verticalName}`, bytes: new Uint8Array(await (await fetch(item.verticalUrl)).arrayBuffer()) });
      }
    }
    const local = [], central = [];
    let offset = 0;
    for (const entry of entries) {
      const crc = zipCRC(entry.bytes);
      const localHeader = zipHeader(0x04034b50, entry.name, crc, entry.bytes.length);
      const centralHeader = zipHeader(0x02014b50, entry.name, crc, entry.bytes.length, offset);
      local.push(localHeader, entry.bytes);
      central.push(centralHeader);
      offset += localHeader.length + entry.bytes.length;
    }
    const centralBytes = central.reduce((n, part) => n + part.length, 0);
    const end = new Uint8Array([
      ...zipU32(0x06054b50), ...zipU16(0), ...zipU16(0), ...zipU16(entries.length), ...zipU16(entries.length),
      ...zipU32(centralBytes), ...zipU32(offset), ...zipU16(0),
    ]);
    downloadBlob(new Blob([...local, ...central, end], { type: "application/zip" }), `${slug(state.result?.title || "clips")}-clips.zip`);
    toast("ZIP downloaded with clips and metadata ✓");
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), "error");
  } finally {
    setBusy(false);
  }
}

function clipLink(h) {
  return `https://youtu.be/${state.result.source.videoId}?t=${Math.floor(h.start)}`;
}

function exportJSON() {
  downloadBlob(new Blob([JSON.stringify(state.result, null, 2)], { type: "application/json" }), `${slug(state.result.title)}.json`);
}
function exportCSV() {
  const yt = !!state.result.source?.videoId;
  const rows = [["#", "title", "start", "end", "duration_s", "score", "hook", "reason", "quote", "tags", "link"]];
  state.result.highlights.forEach((h, i) =>
    rows.push([i + 1, h.title, fmt(h.start), fmt(h.end), Math.round(h.end - h.start), h.score, h.hook, h.reason, h.quote, (h.tags || []).join(" "), yt ? clipLink(h) : ""])
  );
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  downloadBlob(new Blob([csv], { type: "text/csv" }), `${slug(state.result.title)}.csv`);
}
function exportMD() {
  const r = state.result;
  const yt = !!r.source?.videoId;
  let md = `# ${r.title || "Highlights"}\n\n${r.summary || ""}\n\n`;
  r.highlights.forEach((h, i) => {
    md += `## ${i + 1}. ${h.title}  (${fmt(h.start)}–${fmt(h.end)}, score ${h.score})\n`;
    if (yt) md += `${clipLink(h)}\n\n`;
    if (h.hook) md += `**Hook:** ${h.hook}\n\n`;
    if (h.reason) md += `${h.reason}\n\n`;
    if (h.quote) md += `> ${h.quote}\n\n`;
  });
  downloadBlob(new Blob([md], { type: "text/markdown" }), `${slug(r.title)}.md`);
}

/* ============================== history ============================== */

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}
function saveHistory(r) {
  let list = loadHistory().filter((x) => x.id !== r.id);
  list.unshift(r);
  list = list.slice(0, 20);
  for (;;) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      break;
    } catch {
      // storage full: drop transcripts from old entries, then drop old entries
      const withTx = list.findLastIndex((x, i) => i > 0 && x.transcript);
      if (withTx > 0) list[withTx] = { ...list[withTx], transcript: null };
      else if (list.length > 1) list.pop();
      else break;
    }
  }
  renderHistory();
}
function renderHistory() {
  const list = loadHistory();
  $("#history-list").innerHTML = list.length
    ? list
        .map(
          (r) => `<button class="h-item" data-id="${r.id}">
            <strong>${esc(r.title || r.source?.name || "Untitled")}</strong>
            <small>${r.highlights.length} clips · ${r.source?.type || ""} · ${new Date(r.createdAt).toLocaleString()}</small>
          </button>`
        )
        .join("") + `<button class="btn" id="history-clear" style="margin-top:8px">Clear history</button>`
    : `<p class="hint">Nothing yet. Your past results are saved in this browser.</p>`;
}

/* ============================== events ============================== */

function switchTab(tab) {
  state.tab = tab;
  $$(".tabpanel").forEach((p) => (p.hidden = p.dataset.panel !== tab));
}

function selectFile(file) {
  if (!file) return;
  if (state.fileURL) URL.revokeObjectURL(state.fileURL);
  state.file = file;
  state.fileURL = URL.createObjectURL(file);
  state.duration = null;
  const v = document.createElement("video");
  v.preload = "metadata";
  v.onloadedmetadata = () => {
    state.duration = v.duration;
    $("#drop-sub").textContent = `${(file.size / 1e6).toFixed(1)} MB · ${fmt(v.duration)}. Tap "Find highlights"`;
  };
  v.src = state.fileURL;
  $("#drop-title").textContent = `🎬 ${file.name}`;
  $("#drop-sub").textContent = `${(file.size / 1e6).toFixed(1)} MB`;
  if (state.result?.source?.type === "file") renderResult(); // re-attach preview/export if same file
}

$("#go").addEventListener("click", run);
$("#download-zip").addEventListener("click", downloadAllZip);
$("#make-vertical").addEventListener("click", makeVerticalVersions);
$("#opt-watch").addEventListener("input", (e) => {
  $("#watch-value").value = `${e.target.value}%`;
  $("#watch-value").textContent = `${e.target.value}%`;
});
$("#yt-url").addEventListener("keydown", (e) => e.key === "Enter" && run());
$("#file").addEventListener("change", (e) => selectFile(e.target.files[0]));

$("#yt-paste").addEventListener("click", async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (!t) return toast("Clipboard is empty.", "error");
    $("#yt-url").value = t;
    toast(extractYouTubeId(t) ? "Link pasted ✓" : "Pasted, but that doesn't look like a YouTube link.", extractYouTubeId(t) ? "" : "error");
  } catch {
    $("#yt-url").focus();
    toast("Clipboard blocked. Long-press the box and tap Paste.", "error");
  }
});

const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("over"))));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove("over"))));
drop.addEventListener("drop", (e) => selectFile(e.dataTransfer.files[0]));


$("#cards").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const i = +btn.closest(".card").dataset.i;
  const h = state.result.highlights[i];
  switch (btn.dataset.act) {
    case "play":
      markPlaying(i);
      return playRange(h.start, h.end);
    case "link":
      return copy(clipLink(h));
    case "copy":
      return copy(h.hook);
    case "export":
      return exportClip(i);
    case "delete":
      state.result.highlights.splice(i, 1);
      saveHistory(state.result);
      return renderResult();
    case "set-start":
    case "set-end": {
      const t = currentTime();
      if (!Number.isFinite(t)) return toast("Play the video first.", "error");
      const key = btn.dataset.act === "set-start" ? "start" : "end";
      const next = { ...h, [key]: Math.round(t * 10) / 10 };
      if (next.end <= next.start) return toast("End must be after start.", "error");
      h[key] = next[key];
      saveHistory(state.result);
      return renderCards();
    }
  }
});

$("#cards").addEventListener("change", (e) => {
  const input = e.target.closest("input[data-field]");
  if (!input) return;
  const h = state.result.highlights[+input.closest(".card").dataset.i];
  const t = parseTime(input.value);
  const next = { ...h, [input.dataset.field]: t };
  if (!Number.isFinite(t) || t < 0 || next.end <= next.start) {
    toast("Invalid time. Use M:SS and keep end after start.", "error");
    input.value = fmt(h[input.dataset.field]);
    return;
  }
  h[input.dataset.field] = t;
  saveHistory(state.result);
  renderCards();
});

$("#transcript-lines").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-t]");
  if (b) playRange(+b.dataset.t);
});

$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  renderCards();
});
$("#exp-json").addEventListener("click", exportJSON);
$("#exp-csv").addEventListener("click", exportCSV);
$("#exp-md").addEventListener("click", exportMD);

$("#sharebar-btn").addEventListener("click", async () => {
  if (!pendingShare) return;
  const { file, blob, name, title } = pendingShare;
  try {
    await navigator.share({ files: [file], title });
    $("#sharebar").hidden = true;
    pendingShare = null;
  } catch (e) {
    if (e.name !== "AbortError") {
      downloadBlob(blob, name);
      $("#sharebar").hidden = true;
      pendingShare = null;
    }
  }
});
$("#sharebar-close").addEventListener("click", () => {
  $("#sharebar").hidden = true;
  pendingShare = null;
});

$("#history-btn").addEventListener("click", () => {
  renderHistory();
  $("#history").classList.add("open");
});
$("#history-close").addEventListener("click", () => $("#history").classList.remove("open"));
$("#history-list").addEventListener("click", (e) => {
  if (e.target.id === "history-clear") {
    if (confirm("Delete all saved results?")) {
      localStorage.removeItem(HISTORY_KEY);
      renderHistory();
    }
    return;
  }
  const item = e.target.closest(".h-item");
  if (!item) return;
  const r = loadHistory().find((x) => x.id === item.dataset.id);
  if (!r) return;
  state.result = r;
  renderResult();
  $("#history").classList.remove("open");
  $("#results").scrollIntoView({ behavior: "smooth" });
});

// Support ?url=... so you can make a bookmarklet:
// javascript:location='https://YOUR.pages.dev/?url='+encodeURIComponent(location.href)
const qsUrl = new URLSearchParams(location.search).get("url");
if (qsUrl) $("#yt-url").value = qsUrl;
