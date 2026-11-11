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

## Joining split parts

The **Хэсэг нийлүүлэх** page (`/merge`, linked from the editor header) joins files that were cut into parts back into one file each: `KINO_X_1.mp4 … KINO_X_3.mp4` becomes `KINO_X.mp4`, and `KINO_SERIES_4_1 … _3` becomes `KINO_SERIES_4.mp4`. A trailing `ok` on the part number is ignored.

1. Pick a source folder or a whole drive, then pick an output folder. The picker can make a new folder such as `final`.
2. Pick a quality. **Анхны чанар** joins the parts without re-encoding, which takes seconds and loses nothing. **1080p / 720p / 480p** re-encodes to an H.264/AAC MP4 with that short side (never upscaled), which makes smaller files but takes minutes per film.
3. Every sub-folder is scanned, and you get a list grouped by folder.
4. Untick anything you don't want, or rename an output, then press **Нийлүүлэх**.

How it behaves:

- The folder layout under the source is copied under the output folder. Untick "Хавтасны бүтцийг хадгалах" to put everything in one folder.
- Source files are never modified.
- Each output is written under a temporary name and checked against the total length of its parts before it gets its real name. Cancelling deletes the unfinished file.
- Groups with a missing part or a duplicate part are shown and can't be ticked. Parts in different formats (size, codec or fps) can only be joined by re-encoding: each part is fitted into the first part's frame and frame rate, and a part without sound gets silence.
- Re-encoding uses Apple VideoToolbox on a Mac and falls back to libx264 if it fails to start.
- Outputs that already exist are skipped, so write re-encoded copies to a different folder than the stream-copied ones.

The same thing works from a terminal with `npm run merge -- <source> <out>`:

- On its own it only prints the plan. Add `--yes` to write the files.
- `--skip NAME` leaves a group out, and `--rename OLD=NEW` writes a group under another name.
- Groups with a missing part, a duplicate part, or parts in different formats are reported and skipped.
- Files that already exist in `<out>` are skipped, so it's safe to run again after adding new files.
- It needs `ffmpeg` and `ffprobe` on PATH.

## Batch converting

The **Олноор хөрвүүлэх** page (`/convert`, linked from the editor header) turns films into 1080p or 720p MP4s. **Хавтсаар** mode does every film in one or more folders at once:

1. Add one or more folders with **Хавтас нэмэх**. Every sub-folder is read too.
2. Pick an output folder, then pick **1080p** or **720p**.
3. Press **Шалгах** to see each film with its size, what will happen to it, and any problem. Untick a file or a whole folder to leave it out, then press **720p болгох**.

**Нэг нэгээр** mode converts single films as you pick them:

1. Pick the output folder.
2. Press **Файл сонгох** and click films in the picker. Each click adds the film and starts it straight away. The picker stays open so you can add more, and **Болсон** closes it.

Up to three films run at once and the rest wait in line. Each lands in the output folder as `<same name>.mp4`. Changing the size or the folder only affects films added afterwards. A failed or cancelled film can be started again with **Дахин**.

**Харьцаа засах** fixes films stretched to the wrong shape (people look too wide or too thin):

- Pick the shape the film should have, usually **4:3**. The picture is resized to it with square pixels, so a 16:9-stretched 4:3 film comes out 960×720 at 720p. Nothing is cropped and no black bars are added.
- **Харж тохируулах…** shows a frame as it is and as it will come out. Pick a shape, or drag **Өндөр** until faces look right, and move **Кадр** to a shot with people in it.
- In **Нэг нэгээр** mode the dialog's **Засаад хөрвүүлэх** converts just that film with the fix. **Цаашид нэмэх бүх файлд** applies it to every film added afterwards.
- The setting isn't remembered between visits, and it turns off "encode-гүй хуулах" because the picture has to be re-encoded.

How it behaves:

- In folder mode, output paths keep the names: `<output>/<folder name>/<same sub-folders>/<same file name>.mp4`.
- Video is H.264 at high quality (CRF 20, or VideoToolbox q 65), which looks the same as the source. The short side becomes 1080 or 720, so vertical video comes out 1080×1920 or 720×1280. Smaller videos are never upscaled.
- AAC sound is copied. Other sound is converted to AAC, at 384 kb/s for 5.1 and 192 kb/s otherwise. Every audio track is kept. Subtitles are dropped.
- With "encode-гүй хуулах" on, a film that is already H.264 at or below the chosen size keeps its picture untouched. Only the container (and the sound, if it isn't AAC) changes, which takes seconds.
- On a Mac, three films run at once on the video chip, at about 15× real time in total. Elsewhere libx264 does one at a time.
- Source files are only read. Each output is written under a temporary name and its length is checked before it gets its real name. Cancelling deletes the unfinished files.
- Outputs that already exist are skipped, so running it again only does what's new.
- A file that can't be read, or two files that would get the same name (`Film.avi` and `Film.mkv`), are flagged and can't be ticked.

## Timeline editor

- **Import media.** Drag files onto the media panel or the timeline (you can add several at once), or paste a local path such as `D:\Movies\video.mkv`. Opening by path makes no copy, which suits 2GB+ files.
- **Tracks.** Text tracks sit on top, then video tracks (a higher track draws in front), then audio tracks. Each track can be hidden (👁), muted (🔊) or locked (🔒).
- **Stacking clips.** Drag a clip below the last track of its kind (or above the first one, into the ruler) to drop it onto a new track there; a dashed outline shows where it lands. That lets two clips overlap in time. For video, a new track below draws behind the others and one above draws in front.
- **Layer order.** Hover a track name and use ˄ / ˅ to move it up or down among tracks of the same kind (with ⇧, all the way). For video tracks, higher means drawn in front, so a background picture goes at the bottom. Right-clicking a clip offers **Хамгийн урд гаргах** / **Хамгийн ард оруулах**, which move the clip's whole track. Text always draws above video. ⌘Z undoes a move.
- **Video clips.** Fit or fill the frame, rotate 90°, flip horizontally or vertically, crop, change speed (0.25–4x) and opacity. In the preview, drag a clip to move it and drag its corners to resize it; it snaps to the center.
- **Fix a stretched film.** If people look too wide or too thin, open **Харьцаа засах** in the clip panel. Pick the shape the film should have (usually **4:3**), or drag **Өндөр** until faces look right. The preview and the export both show the picture at that shape. Replacing the file clears the fix.
- **Transitions.** Where two video clips meet on a track, hover the track to see a ✦ marker on the cut. Click it to pick a dissolve (Бүдгэрэх), a dip to black or white, a slide from any side, or a push, and a length from 0.3 to 2 s. **Бүх зүсэлтэд** applies the same transition to every cut, and **Арилгах** removes it. A transition is centred on the cut, so the project's length doesn't change: the outgoing clip plays on and the incoming one starts early, holding its last or first frame if the file has nothing more. Sound still cuts at the clip edge. The preview plays transitions, and the export renders them the same way.
- **Audio.** Set volume from 0 to 200%, add fade in/out, mute, or **detach audio**: the video clip goes silent and its sound becomes a separate clip on an audio track.
- **Logos / pictures.** PNG, JPG, WebP and BMP files go on a video track like any clip. A new picture clip lasts 5 s, and you can stretch it to any length. Transparency is kept in the preview and the export.
- **Card and rounded corners.** In a video or picture clip's panel, **Ар дэвсгэр ба булан** puts a card behind it, such as a logo on a white or dark rounded panel. Presets are **Цагаан**, **Хар** and **Булан** (rounded corners only). Then pick the card colour and set its opacity, the padding around the picture, and the corner radius (50% = pill). The picture's own corners follow the card's, and a logo keeps its transparency. The export draws the card and corner mask as still PNGs in the job folder and composites them with the clip, so they move and fade with it in transitions.
- **Replace a file.** Right-click a clip and choose **Бичлэг солих…**, or use the button in the clip panel. Pick a file from the library or your computer. The clip keeps its position, size, crop and effects (but not a stretch fix). If the clip used its whole source file, it takes the new file's full length. Overlays that ended with it (logo, watermark text, music) move to the new end, and clips that came after it shift along.
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
| ⇧S | Join split pieces back into one clip: the selected clips (one selected clip joins its neighbour), or the cut under the playhead if none is selected. Only pieces of the same recording that continue each other are joined; ⌘Z undoes it |
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
| + / − / \\, Ctrl/⌘+scroll, pinch | Zoom the timeline in / out / to fit (scroll zooms around the pointer). Fully zoomed out shows about 8 hours. |
| Scroll, ⇧+scroll | Scroll the timeline sideways (a plain scroll does this when there are no more tracks below to scroll to) |

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
| `src/app/api/convert/*`, `src/lib/server/convert.ts` | Batch converter (`/convert`): plan and run |
| `src/app/api/{upload,probe,preview,download,capabilities}` | Streaming upload, probe, Range preview, download, encoder list |
| `src/lib/server/*` | ffmpeg runner/probe, encode job streaming, temp storage, localhost guard |

## Notes

- **Export pipeline.** Each clip is opened as its own input, pre-cut with `-ss`/`-t`. Video clips are layered onto a background canvas with `overlay` (`eof_action=pass`, `enable=between(t,…)`). Audio clips are positioned with `adelay` and combined with `amix`. Text is drawn last with `drawtext`. The filtergraph is passed through `-filter_complex_script`, so long projects don't hit OS command-line length limits.
- **Temporary files.** Uploads and caches live in `os.tmpdir()/local-video-editor`. They are deleted automatically: export jobs after 12 hours, uploads after 48 hours, thumbnails and proxies after 7 days.
- **Security.** The server listens only on `127.0.0.1` and rejects requests from other hosts or origins, because the APIs can read and write local paths. Set `ALLOW_LAN=1` to turn this check off.
- **Fonts.** Text uses the system Arial/DejaVu font. Set `WATERMARK_FONT=/path/font.ttf` to use another font.
# video-editor
