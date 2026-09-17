<p align="center">
  <img src="assets/icons/panto-srt.png" width="110" alt="Panto SRT">
</p>

<h1 align="center">Panto SRT</h1>

<p align="center">
  <b>Local & private automatic subtitles</b><br>
  Turn any audio or video into a timed subtitle file for video editing.<br>
  No cloud. No accounts. Your files never leave your machine.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/macOS-13.4%2B-lightgrey.svg" alt="macOS 13.4+">
  <img src="https://img.shields.io/badge/electron-43-blueviolet.svg" alt="Electron">
  <img src="https://img.shields.io/badge/language-es%20%2F%20en-brightgreen.svg" alt="Spanish / English">
</p>

<p align="center">
  <a href="README.es.md">Español</a>
</p>

---

## Why Panto SRT?

Writing subtitles by ear is slow. Panto SRT transcribes your audio locally using
[whisper.cpp](https://github.com/ggml-org/whisper.cpp), groups the words into
clean subtitle clips, and exports them as **SRT** or **FCPXML** — ready for
DaVinci Resolve.

- **100% local & private** — no accounts, no cloud, no uploads
- **English & Spanish** out of the box (auto-detected)
- **Precise timing** from actual whisper word timestamps
- **Clean clips** — character length, max duration and min pause auto-balance
- **Re-group on the fly** after you edit text
- **Export SRT** (drag straight onto a Resolve subtitle track) or **FCPXML**
  (import as a title-generator timeline), 25 fps / timecode from zero
- Minimalist, Pantoraya-style UI with a **light / dark** toggle

---

<p align="center">
  <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#b87333" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:.8">
    <path d="M17 8h1a4 4 0 0 1 0 8h-1"/>
    <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/>
    <line x1="6" y1="2" x2="6" y2="4"/>
    <line x1="10" y1="2" x2="10" y2="4"/>
    <line x1="14" y1="2" x2="14" y2="4"/>
  </svg>
</p>

> ☕ Panto SRT is free and open source. If it saves you time, consider
> [inviting me a coffee on PayPal](https://paypal.me/antoniomartinez75)
> (`@antoniomartinez75`). Totally optional — but deeply appreciated!

---

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Build the whisper.cpp engine (first time only — self-contained, ~0.1s if present)
npm run prepare:whisper

# 3. Run in development
npm start
```

Verify and test:

```bash
npm run check   # syntax-check every module
npm test        # subtitle engine tests (grouping, SRT, FCPXML)
```

Requirements: **macOS 13.4+ (Apple Silicon)** or **Windows 10/11 x64**,
~2–6 GB free RAM depending on the model, and internet only the first time
(the Whisper model downloads on demand into the app's data folder).

---

## Making subtitles

1. Drop an audio or video file (MP3, M4A, WAV, MP4, MOV…).
2. Choose a downloaded model in the model selector, then generate with
   **auto language detection**, grouping clips at sensible defaults
   (42 chars, 3.5 s max, 0.2 s min pause).
3. Review and fix the text inline; hit **Re-group** if you retimed manually.
4. **Export SRT** or **Export FCPXML**.

In Resolve: `File > Import > Subtitle…` (SRT) or
`File > Import > Timeline > FCP XML…`. Clips always start at `00:00:00,000`, so
they land in sync on a timeline that starts at zero.

---

## Models

Use the selector to download a model before transcribing. Downloaded models
are kept only in Panto SRT's app-data folder and can be removed with the trash
button; they are never shared with other apps. Recommended sizes:

| Model  | RAM/VRAM | Notes                      |
|--------|----------|----------------------------|
| `tiny` | ~75 MB   | Fast preview               |
| `base` | ~142 MB  | Light projects             |
| `small`| ~466 MB  | Low-end machines           |
| `medium`| ~1.5 GB | More accurate, slower      |
| `turbo`| ~1.6 GB  | Best speed/quality balance |
| `large-v3`| ~3.1 GB| Highest accuracy, slowest  |

---

## Project structure

```
src/
  main/
    main.js            window + IPC
    lib/
      whisper.js       whisper.cpp engine (spawn, parse, progress)
      media.js         audio/video file introspection
      grouping.js      word timestamps → subtitle clips
      formats/
        srt.js         SubRip exporter
        fcpxml.js      Final Cut Pro XML exporter
  preload/
    preload.js         secure bridge (contextBridge)
  renderer/
    index.html         minimal UI
    styles.css
    app.js
scripts/
  prepare-whisper.js   build engine + (optional) models
tests/                 node --test subtitle engine
```

---

## License

- Code: [MIT](./LICENSE)
- Engine: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT)
- Whisper models: [OpenAI](https://github.com/openai/whisper) (MIT)
- See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
