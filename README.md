# Локал Видео Засварлагч (Local Video Editor & Compressor)

An offline video editor with a multi-track timeline, similar to the 123apps video editor. It runs on your own computer and uses the bundled `ffmpeg-static` binary, so no internet connection or system ffmpeg is needed.

There are two tools:

- **`/`: Timeline editor.** Put several videos, audio files and text on stacked tracks; detach, mute, split and trim clips; then export everything in a single ffmpeg pass.
- **`/compress`: Quick compressor.** One file in, one file out: trim, 720p compression, crop, rotate, speed, volume, watermark and format conversion.

## Setup

```bash
npm install
npm run fonts      # once, while online: Google Fonts with Mongolian Cyrillic (~100 MB)
npm run dev        # http://127.0.0.1:3000  (development)

npm run build      # production
npm start          # http://127.0.0.1:3000
```

Requires Node.js 20+. `npm run fonts` downloads every free Google Font that has Cyrillic and checks each file for Ө ө Ү ү, keeping about 180 families (regular, plus bold where the family has one). They go in `fonts/google/` (git-ignored; override with `LVE_FONTS_DIR`), and after that the preview and the export use them offline. Running it again only fetches what's missing. To use your own ffmpeg build (for example one with NVENC), set `FFMPEG_PATH=/path/to/ffmpeg`.

## Timeline editor

- **Import media.** Drag files onto the media panel or the timeline (you can add several at once), or paste a local path such as `D:\Movies\video.mkv`. Opening by path makes no copy, which suits 2GB+ files.
- **Tracks.** Text tracks sit on top, then video tracks (a higher track draws in front), then audio tracks. Each track can be hidden (👁), muted (🔊) or locked (🔒).
- **Video clips.** Fit or fill the frame, rotate 90°, flip horizontally or vertically, crop, change speed (0.25–4x) and opacity. In the preview, drag a clip to move it and drag its corners to resize it; it snaps to the center.
- **Audio.** Set volume from 0 to 200%, add fade in/out, mute, or **detach audio**: the video clip goes silent and its sound becomes a separate clip on an audio track.
- **Logos / pictures.** PNG, JPG, WebP and BMP files go on a video track like any clip. A new picture clip lasts 5 s, and you can stretch it to any length. Transparency is kept in the preview and the export.
- **Replace a file.** Right-click a clip and choose **Бичлэг солих…**, or use the button in the clip panel. Pick a file from the library or your computer. The clip keeps its position, size, crop and effects. If the clip used its whole source file, it takes the new file's full length. Overlays that ended with it (logo, watermark text, music) move to the new end, and clips that came after it shift along.
- **Templates.** Open the **Template** button in the top bar to save the current project. Ticked videos become empty slots; logos, music and text are saved with the template. Templates live in `~/.local-video-editor/templates` (override with `LVE_TEMPLATES_DIR`) and do not expire. **Ашиглах** starts a project from a template. Fill each slot by clicking it in the preview or the media panel, or by dropping a file onto it in the timeline. Export is blocked until every slot is filled.
- **Fonts.** The text panel has a searchable font list. Each font name shows your own text in that font, and you can filter by Sans, Serif, Display, handwriting or mono. Set the size in pixels as it appears in a 1080p export, with S/M/L/Title presets. Use **B** for bold when the font has a bold weight. One button copies the current font, size and color to every text. The export draws text with the same TTF the preview uses.
- **Text.** Title, subtitle and plain presets; color, size, background box or outline. Multi-line text and Cyrillic (Ө/Ү) are supported.
- **Unsupported formats.** If the browser can't play a file (AVI, WMV, MKV with AC3 audio…), the editor builds a 360p preview proxy automatically. Export still reads the original file.
- **Autosave.** The project is saved to localStorage. Uploaded files are kept for 48 hours.
- **Export.** 720p/1080p/480p, CRF 20/23/27, MP4/MOV/MKV/MP3. The **Автомат** engine uses Apple VideoToolbox on a Mac and libx264 on other systems; if a GPU encoder fails to start, export falls back to the CPU.

### Keyboard shortcuts

Shortcuts are matched by physical key position, so they also work with the Mongolian (Cyrillic) keyboard layout. On Windows, use Ctrl in place of ⌘. Press `?` in the editor to see the full list.

| Key | Action |
| --- | --- |
| Space / K | Play / pause |
| S (⌘B) | Split at the playhead (selected clips, or every clip under the playhead if none is selected) |
| Delete, ⇧Delete | Delete; delete and close the gap (ripple delete) |
| Empty gap → 🗑 or Delete | Remove the empty gap; later clips on that track slide left |
| D | Detach audio |
| M | Mute / unmute |
| Q / W  (or [ / ]) | Trim the clip's start / end to the playhead |
| ⌘D, ⌘C/⌘X/⌘V, ⌘A | Duplicate; copy / cut / paste; select all |
| ⌘Z / ⌘⇧Z | Undo / redo |
| ← / → (⇧) | Move 1 frame (with ⇧: 1 second) |
| J / L | Back / forward 5 seconds |
| ↑ / ↓, Home / End | Jump to the previous / next cut; to the start / end |
| T | Add text |
| C | Crop the selected video on screen (Enter apply, Esc cancel); also right-click the preview |
| F | Fit canvas to content (canvas takes the clip's exact cropped width/height) |
| N | Turn snapping on/off |
| + / − / \\, Ctrl/⌘+scroll, pinch | Zoom the timeline in / out / to fit (scroll zooms around the pointer) |
| ⇧+scroll | Scroll the timeline sideways |

## Layout

| File | Purpose |
| --- | --- |
| `src/components/editor/Editor.tsx` | Editor shell: state, shortcuts, import, autosave |
| `src/components/editor/Timeline.tsx` | Tracks, clips (filmstrip, waveform), dragging, trimming, snapping, zoom |
| `src/components/editor/Preview.tsx` | Multi-track preview kept in sync with the clock; move and scale clips |
| `src/components/editor/Inspector.tsx` | Media library, text presets, clip settings |
| `src/components/editor/ops.ts` | Pure functions: split, ripple delete, detach audio, paste, replace media… |
| `src/components/editor/CropEditor.tsx` | On-screen crop box with handles and aspect presets |
| `src/components/editor/TemplatesDialog.tsx` / `ReplaceDialog.tsx` | Save and use templates; pick a replacement file |
| `scripts/fetch-fonts.mjs`, `src/app/api/fonts/route.ts` | Download Mongolian-capable Google Fonts; serve the list and the files |
| `src/app/api/templates/route.ts` | Lists, saves (copies logos and music) and deletes templates |
| `src/lib/server/project.ts` | Validates a project sent by the browser (render and templates) |
| `src/lib/timeline.ts` | Project model shared by the client and server |
| `src/app/api/render/route.ts` | Builds the single-pass filter_complex from the timeline |
| `src/app/api/thumbs/route.ts` | Filmstrip frames and waveform images (cached) |
| `src/app/api/proxy/route.ts` | 360p preview proxy for formats the browser can't play |
| `src/app/api/process/route.ts` | Single-file compressor (`/compress`) |
| `src/app/api/{upload,probe,preview,download,capabilities}` | Streaming upload, probe, Range preview, download, encoder list |
| `src/lib/server/*` | ffmpeg runner/probe, encode job streaming, temp storage, localhost guard |

## Notes

- **Export pipeline.** Each clip is opened as its own input, pre-cut with `-ss`/`-t`. Video clips are layered onto a background canvas with `overlay` (`eof_action=pass`, `enable=between(t,…)`). Audio clips are positioned with `adelay` and combined with `amix`. Text is drawn last with `drawtext`. The filtergraph is passed through `-filter_complex_script`, so long projects don't hit OS command-line length limits.
- **Temporary files.** Uploads and caches live in `os.tmpdir()/local-video-editor`. They are deleted automatically: export jobs after 12 hours, uploads after 48 hours, thumbnails and proxies after 7 days.
- **Security.** The server listens only on `127.0.0.1` and rejects requests from other hosts or origins, because the APIs can read and write local paths. Set `ALLOW_LAN=1` to turn this check off.
- **Fonts.** Text uses the system Arial/DejaVu font. Set `WATERMARK_FONT=/path/font.ttf` to use another font.
# video-editor
