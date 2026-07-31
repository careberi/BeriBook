# BeriBook 📖🔊

A **Speechify-style document reader** you own. Upload a PDF or Word document,
and BeriBook automatically splits it into **chapters** and **reads it aloud**
to you — on your iPhone, iPad, or any modern browser.

Everything runs **on your device**: your documents are parsed locally, saved
locally, and read aloud with your device's built-in voices (on iPhone/iPad
those are the same high-quality Siri voices). No accounts, no uploads, no
per-word fees, and it works offline once installed.

---

## What it does

- 📄 **PDF and Word (.docx)** upload
- 📑 **Automatic chapter detection** — analyses heading/font structure to break
  a document into real chapters (falls back to sensible fixed-size sections
  when a document has no headings)
- 🔊 **Reads aloud** sentence-by-sentence using on-device text-to-speech
- ✨ **Karaoke highlighting** — the current sentence (and word, where the voice
  supports it) is highlighted and auto-scrolled as it's read
- ⏯️ **Full playback controls** — play/pause, skip sentence, skip chapter,
  chapter list, tap any sentence to jump there
- ⚡ **Speed & voice** — 0.5×–2× speed, pick any installed voice, adjust pitch
- 🔖 **Remembers your place** in every document, automatically
- 📚 **Personal library** stored on-device (IndexedDB)
- 📲 **Installs to your home screen** as a full-screen app (PWA) and works
  **offline**
- 🌗 Light / dark themes

---

## Get it on your iPhone / iPad

The app has to be served over **HTTPS** for the "install to home screen" and
offline features to work. The easiest free way is **GitHub Pages**:

### 1. Publish with GitHub Pages
- Push this project to GitHub (this repo already is).
- In the repo, go to **Settings → Pages**.
- Under **Build and deployment → Source**, choose **GitHub Actions**.
  (A workflow is included at `.github/workflows/deploy-pages.yml`, so pushing
  to `main` publishes the site automatically.)
- Alternatively choose **Deploy from a branch**, pick your branch and the
  `/ (root)` folder.
- After it builds, GitHub gives you a URL like
  `https://<your-name>.github.io/BeriBook/`.

### 2. Install on the device
1. Open that URL in **Safari** on your iPhone or iPad.
2. Tap the **Share** button (the square with the up-arrow).
3. Tap **Add to Home Screen**.
4. Launch **BeriBook** from your home screen — it opens full-screen like a
   native app.

### 3. Use it
- Tap **Choose file**, pick a PDF or `.docx`.
- It's split into chapters — press **►** to start listening.
- Open **Settings (⚙︎)** to change voice, speed, and theme.

> **Tip (iPhone/iPad):** for the best voices, go to
> *Settings → Accessibility → Spoken Content → Voices* and download a premium
> or Siri voice. It will then appear in BeriBook's voice picker.

---

## Run it locally

Any static file server works (a service worker requires `http://localhost`
or HTTPS — opening `index.html` directly with `file://` won't register it):

```bash
# from the project root
python3 -m http.server 8080
# then open http://localhost:8080
```

---

## How it works

| File | Responsibility |
|------|----------------|
| `index.html` | App shell (library, reader, player, settings) |
| `css/styles.css` | Mobile-first styling, light/dark themes, safe-area insets |
| `js/ingest.js` | PDF/DOCX parsing + chapter detection |
| `js/tts.js` | Speech engine (sentence chunking, transport, highlighting) |
| `js/db.js` | IndexedDB library + progress + settings |
| `js/app.js` | UI controller wiring it all together |
| `sw.js` | Service worker — offline caching of the app shell |
| `manifest.webmanifest` | PWA metadata + icons |
| `js/vendor/` | [pdf.js](https://mozilla.github.io/pdf.js/) and [mammoth.js](https://github.com/mwilliamson/mammoth.js) (vendored, offline) |

### Chapter detection, briefly
For PDFs, BeriBook reconstructs text lines with their font sizes, finds the
body-text size, then treats noticeably larger lines as headings. It picks the
heading "tier" that yields a healthy number of chapters (so it won't latch onto
a cover-page title or explode on every sub-heading), merges multi-line titles,
and strips running headers/footers and table-of-contents leader dots. Word
documents use their real heading styles (`Heading 1` / `Heading 2`).

### Why per-sentence speech?
Mobile Safari has a long-standing bug where a single long utterance gets cut
off. Reading one sentence at a time avoids it entirely, and also gives us clean
resume points and sentence highlighting.

---

## Privacy

Your documents never leave your device. Parsing, storage (IndexedDB), and
speech all happen locally in the browser. The service worker only caches
BeriBook's own app files — never your documents.

---

## Limitations

- **Scanned PDFs** (images of text with no embedded text layer) can't be read —
  there's nothing to extract. OCR is not included.
- Legacy **`.doc`** (pre-2007 Word) isn't supported — re-save as `.docx` or PDF.
- Available voices depend on the device/browser. iPhone/iPad and Chrome have
  excellent voices; some browsers have fewer.
