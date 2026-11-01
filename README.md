# ✂️ Clipper: free personal AI video clipper (Cloudflare Pages)

Paste a YouTube link, upload a video, or paste a transcript. You get timestamped,
scored highlight clips with hooks. You can preview them, adjust the in/out points
and, for uploaded files, export real MP4 clips (including vertical 9:16).

## 1. Folder layout
```
clipper/
├─ package.json
├─ wrangler.toml
├─ .gitignore
├─ README.md
├─ scripts/copy-vendor.mjs
├─ functions/api/
│  ├─ highlights.js     → POST /api/highlights  (Gemini)
│  └─ transcribe.js     → POST /api/transcribe  (Workers AI Whisper)
└─ public/
   ├─ index.html
   └─ app.js
```

## 2. Get a free Gemini API key
https://aistudio.google.com → "Get API key" → create a key.

## 3. Run locally (optional)
```bash
npm install
echo "GEMINI_API_KEY=your-key-here" > .dev.vars
npx wrangler login          # Workers AI runs on Cloudflare even in local dev
npm run dev                 # → http://localhost:8788
```

## 4. Deploy

### Option A: CLI
```bash
npm install
npx wrangler login
npm run deploy                                   # creates the Pages project on first run
npx wrangler pages secret put GEMINI_API_KEY     # paste your key
npx wrangler pages secret put APP_PASSWORD       # optional but recommended
npm run deploy                                   # redeploy so secrets apply
```

### Option B: Git (auto-deploy on push)
1. Push the folder to a GitHub/GitLab repo.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Build command: `npm run build` · Build output directory: `public`
4. Settings → Variables and Secrets → add `GEMINI_API_KEY` (and optionally `APP_PASSWORD`) as secrets.
5. The Workers AI binding and model vars come from `wrangler.toml`.
6. Retry the deployment.

## 5. Modes
| Mode | Pipeline | Preview | Export |
|---|---|---|---|
| YouTube link | Gemini watches the public video directly | YouTube embed plays start→end | Timestamped links, JSON/CSV/MD |
| Upload video | ffmpeg.wasm extracts audio in your browser → 2-min MP3 chunks → Whisper → Gemini | Local video player | Real MP4 clips (fast / accurate / vertical) |
| Paste transcript | YouTube transcript text, SRT or VTT → Gemini | YouTube embed (if URL given) | Links, JSON/CSV/MD |

## 6. On your phone
- YouTube tab: in the YouTube app tap Share → Copy link, then tap 📋 Paste in Clipper.
- Upload tab: keep files under ~500 MB (enforced on phones). The screen is kept awake during jobs where the browser supports it. Don't switch apps mid-export.
- Exported clips: tap "📤 Save / Share" to save to Photos/Gallery or send to other apps.

## 7. Free-tier notes
- Gemini free tier is rate-limited; free-tier prompts may be used by Google to improve products. YouTube input = public videos only. Tick "Long video mode" for videos over ~1 hour.
- Workers AI: 10,000 free neurons/day (a few hours of Whisper audio).
- ffmpeg.wasm is single-threaded. Fast export snaps to keyframes; Accurate/Vertical re-encode at roughly real-time or slower.

## 8. Troubleshooting
- "ffmpeg.wasm files not found": the build didn't run. The build command must be `npm run build`.
- Password prompt loops: run `localStorage.removeItem("clipper.password")` in the browser console.
- Gemini "model not found": change `GEMINI_MODEL` in `wrangler.toml` to a current ID from https://ai.google.dev/gemini-api/docs/models
- Private/unlisted error: use the Transcript tab.
- Debug ffmpeg: `window.CLIPPER_DEBUG = true` in the console.

## 9. Fair use
Use YouTube mode for analysis and timestamped links. Only cut videos you own or have rights to.
