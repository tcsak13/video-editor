import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { CRF_VALUES, ENCODERS, type Encoder, type MediaInfo } from "@/lib/editor-options";
import {
  availableEncoders,
  legacyInputFlags,
  probeMedia,
  resolveEncoder,
  videoCodecArgs,
} from "@/lib/server/ffmpeg";
import { findFont, streamEncodeJob } from "@/lib/server/job";
import { MAX_MEDIA, pick, sanitizeProject, str } from "@/lib/server/project";
import { fontFile } from "@/lib/server/fonts";
import { JOBS_DIR, jsonError, rejectNonLocal, resolveSource, statFile, sweepOldData } from "@/lib/server/storage";
import {
  EXPORT_FORMATS,
  EXPORT_RESOLUTIONS,
  FPS,
  MIN_CLIP,
  TEXT_LINE_HEIGHT,
  canvasSize,
  clipBoxSize,
  clipDuration,
  clipEnd,
  type ExportSettings,
  type MediaClip,
  type Project,
  type TextClip,
} from "@/lib/timeline";

function sanitizeSettings(raw: unknown): ExportSettings {
  const s = (raw ?? {}) as Partial<ExportSettings>;
  return {
    resolution: pick(EXPORT_RESOLUTIONS, s.resolution, "720"),
    crf: pick(CRF_VALUES, s.crf, 23),
    encoder: pick(ENCODERS, s.encoder, "auto"),
    format: pick(EXPORT_FORMATS, s.format, "mp4"),
  };
}

// ---------------------------------------------------------------------------
// Filtergraph builder — one input per clip (pre-trimmed with -ss/-t), video clips
// overlaid onto a background canvas bottom track → top track, audio delayed into
// place and mixed, text burned in last. Everything renders in a single pass.
// ---------------------------------------------------------------------------

type ResolvedMedia = { path: string; info: MediaInfo; size: number };

const f = (n: number) => Number(n.toFixed(4)).toString();
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const hex = (c: string) => "0x" + c.slice(1);

function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push("atempo=2");
    s /= 2;
  }
  while (s < 0.5) {
    out.push("atempo=0.5");
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${f(s)}`);
  return out;
}

function textFilters(clip: TextClip, W: number, H: number, fontFile: string, fileFor: (line: number) => string): string[] {
  const lines = clip.text.split("\n");
  const fontSize = Math.max(8, Math.round(clip.size * H));
  const lineH = fontSize * TEXT_LINE_HEIGHT;
  const top = clip.y * H - (lines.length * lineH) / 2;
  const style =
    clip.style === "box"
      ? `box=1:boxcolor=black@0.55:boxborderw=${Math.round(fontSize * 0.25)}`
      : clip.style === "outline"
        ? `borderw=${Math.max(1, Math.round(fontSize / 14))}:bordercolor=black`
        : "shadowcolor=black@0.6:shadowx=2:shadowy=2";
  return lines.flatMap((line, i) =>
    line.trim()
      ? [
          `drawtext=fontfile=${fontFile}:textfile=${fileFor(i)}:expansion=none:fontsize=${fontSize}:fontcolor=${hex(clip.color)}` +
            `:x='${f(clip.x * W)}-text_w/2':y=${f(top + i * lineH + (lineH - fontSize) / 2)}:${style}` +
            `:enable='between(t,${f(clip.start)},${f(clipEnd(clip))})'`,
        ]
      : [],
  );
}

type Plan = {
  inputs: string[][]; // per-input arg groups (each ends with -i path)
  graph: string[];
  hasVideo: boolean;
  hasAudio: boolean;
  textFiles: { name: string; content: string }[];
};

function buildPlan(
  project: Project,
  media: Map<string, ResolvedMedia>,
  settings: ExportSettings,
  encoder: Encoder,
  total: number,
  clipFonts: Map<string, string>, // text clip id → font file in the job dir (default: font.ttf)
): Plan {
  const { w: W, h: H } = canvasSize(project.aspect, Number(settings.resolution));
  const tracks = new Map(project.tracks.map((t) => [t.id, t]));
  const trackOrder = new Map(project.tracks.map((t, i) => [t.id, i]));
  const audioOnly = settings.format === "mp3";

  const inputs: string[][] = [];
  const graph: string[] = [];
  const audioLabels: string[] = [];
  const textFiles: Plan["textFiles"] = [];

  // Visual clips draw bottom track first so upper tracks end up in front.
  const mediaClips = project.clips
    .filter((c): c is MediaClip => c.type !== "text")
    .sort((a, b) => trackOrder.get(b.trackId)! - trackOrder.get(a.trackId)! || a.start - b.start);

  let canvas = "base";
  if (!audioOnly) graph.push(`color=c=${hex(project.background)}:s=${W}x${H}:r=${FPS}:d=${f(total)},format=yuv420p[base]`);

  mediaClips.forEach((clip, k) => {
    const m = media.get(clip.mediaId);
    const track = tracks.get(clip.trackId);
    if (!m || !track) return;
    const start = clip.start;
    const end = clipEnd(clip);

    const visible =
      !audioOnly && clip.type === "video" && !track.hidden && !clip.hidden && m.info.hasVideo && clip.opacity > 0;
    const audible =
      m.info.hasAudio && !track.muted && !clip.muted && clip.volume > 0 && !(clip.type === "video" && clip.audioDetached);
    if (!visible && !audible) return;

    const i = inputs.length;
    inputs.push(
      m.info.isImage
        ? // A still picture is looped into a stream exactly as long as its clip.
          ["-loop", "1", "-framerate", String(FPS), "-t", f(clip.out - clip.in), "-i", m.path]
        : [
            ...(visible && encoder === "videotoolbox" ? ["-hwaccel", "videotoolbox"] : []),
            ...legacyInputFlags(m.path),
            "-ss", f(clip.in),
            "-t", f(clip.out - clip.in),
            "-i", m.path,
          ],
    );

    if (visible) {
      const vf = ["setpts=PTS-STARTPTS"];
      const { l, r, t, b } = clip.crop;
      if (l || r || t || b) {
        vf.push(
          `crop=w='trunc(iw*${f(1 - l - r)}/2)*2':h='trunc(ih*${f(1 - t - b)}/2)*2':x='trunc(iw*${f(l)}/2)*2':y='trunc(ih*${f(t)}/2)*2'`,
        );
      }
      if (clip.rotate === 90) vf.push("transpose=clock");
      else if (clip.rotate === 180) vf.push("hflip", "vflip");
      else if (clip.rotate === 270) vf.push("transpose=cclock");
      if (clip.flipH) vf.push("hflip");
      if (clip.flipV) vf.push("vflip");
      if (clip.speed !== 1) vf.push(`setpts=PTS/${f(clip.speed)}`);
      vf.push(`fps=${FPS}`);

      const box = clipBoxSize(m.info.width ?? W, m.info.height ?? H, clip, W, H);
      const bw = even(box.w);
      const bh = even(box.h);
      vf.push(`scale=${bw}:${bh}`, "setsar=1");
      if (clip.opacity < 1) vf.push("format=yuva420p", `colorchannelmixer=aa=${f(clip.opacity)}`);
      vf.push(`setpts=PTS+${f(start)}/TB`);
      graph.push(`[${i}:v]${vf.join(",")}[v${k}]`);

      const x = Math.round(clip.x * W - bw / 2);
      const y = Math.round(clip.y * H - bh / 2);
      graph.push(`[${canvas}][v${k}]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${f(start)},${f(end)})'[o${k}]`);
      canvas = `o${k}`;
    }

    if (audible) {
      const dur = clipDuration(clip);
      const af = ["asetpts=PTS-STARTPTS", ...atempoChain(clip.speed)];
      if (clip.volume !== 1) af.push(`volume=${f(clip.volume)}`);
      if (clip.fadeIn > 0) af.push(`afade=t=in:st=0:d=${f(Math.min(clip.fadeIn, dur))}`);
      if (clip.fadeOut > 0) af.push(`afade=t=out:st=${f(Math.max(0, dur - clip.fadeOut))}:d=${f(Math.min(clip.fadeOut, dur))}`);
      af.push("aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo");
      if (start > 0) af.push(`adelay=${Math.round(start * 1000)}:all=1`);
      graph.push(`[${i}:a]${af.join(",")}[a${k}]`);
      audioLabels.push(`[a${k}]`);
    }
  });

  // Text overlays on top of everything.
  if (!audioOnly) {
    const textClips = project.clips.filter(
      (c): c is TextClip => c.type === "text" && !c.hidden && !tracks.get(c.trackId)?.hidden,
    );
    const drawtexts = textClips.flatMap((clip, k) =>
      textFilters(clip, W, H, clipFonts.get(clip.id) ?? "font.ttf", (line) => {
        const name = `text_${k}_${line}.txt`;
        textFiles.push({ name, content: clip.text.split("\n")[line] });
        return name;
      }),
    );
    graph.push(`[${canvas}]${[...drawtexts, "format=yuv420p"].join(",")}[vout]`);
  }

  // Pad silence up to the timeline end. An unbounded apad makes ffmpeg 6 emit audio with broken
  // timestamps forever once the video side lags, starving the video encoder (export stalls at ~0x).
  const pad = `apad=whole_dur=${f(total)}`;
  if (audioLabels.length === 1) graph.push(`${audioLabels[0]}${pad}[aout]`);
  else if (audioLabels.length > 1) {
    graph.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0,${pad}[aout]`);
  }

  return { inputs, graph, hasVideo: !audioOnly, hasAudio: audioLabels.length > 0, textFiles };
}

// ---------------------------------------------------------------------------
// POST /api/render — streams NDJSON ProcessEvents like /api/process.
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { project?: unknown; media?: unknown; settings?: unknown } | null;
  const project = sanitizeProject(body?.project);
  if (typeof project === "string") return jsonError(project);
  const settings = sanitizeSettings(body?.settings);
  if (!Array.isArray(body?.media) || body.media.length > MAX_MEDIA) return jsonError("Медиа жагсаалт буруу.");

  // Resolve and probe every media file the project uses.
  const usedIds = new Set(project.clips.flatMap((c) => (c.type === "text" ? [] : [c.mediaId])));
  const media = new Map<string, ResolvedMedia>();
  for (const item of body.media as { id?: unknown; source?: unknown }[]) {
    const id = str(item?.id);
    if (!usedIds.has(id) || media.has(id)) continue;
    const filePath = await resolveSource(item.source);
    if (!filePath) return jsonError("Нэг медиа файл олдсонгүй (устсан эсвэл хугацаа нь дууссан). Дахин нэмнэ үү.", 404);
    try {
      const [info, st] = await Promise.all([probeMedia(filePath), fs.stat(filePath)]);
      media.set(id, { path: filePath, info, size: st.size });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Файлыг уншиж чадсангүй.", 422);
    }
  }
  project.clips = project.clips.filter((c) => c.type === "text" || media.has(c.mediaId));

  const total = project.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
  if (total < MIN_CLIP) return jsonError("Timeline хоосон байна.");

  const available = await availableEncoders();
  if (!available[settings.encoder]) return jsonError("Сонгосон хөдөлгүүр энэ ffmpeg-д байхгүй байна.");
  const primary = await resolveEncoder(settings.encoder);

  // Each text clip draws with its Google Font when downloaded, else with the system font.
  const textClips = settings.format === "mp3" ? [] : project.clips.filter((c): c is TextClip => c.type === "text");
  const clipFonts = new Map<string, string>();
  const fontCopies = new Map<string, string>(); // absolute path → name inside the job dir
  for (const clip of textClips) {
    const file = clip.font ? await fontFile(clip.font, !!clip.bold) : null;
    if (!file || !(await statFile(file))) continue;
    if (!fontCopies.has(file)) fontCopies.set(file, `font_${fontCopies.size}.ttf`);
    clipFonts.set(clip.id, fontCopies.get(file)!);
  }
  const needsFont = textClips.some((c) => !clipFonts.has(c.id));
  const systemFont = needsFont ? await findFont() : null;
  if (needsFont && !systemFont) return jsonError("Текст зурах фонт олдсонгүй. WATERMARK_FONT-оор .ttf заана уу.");

  // Probe the plan once up front so obvious problems are reported before streaming starts.
  const probePlan = buildPlan(project, media, settings, primary, total, clipFonts);
  if (settings.format === "mp3" && !probePlan.hasAudio) return jsonError("Timeline-д сонсогдох дуу алга — MP3 гаргах боломжгүй.");

  await sweepOldData();
  const jobId = randomUUID();
  const jobDir = path.join(JOBS_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });
  if (systemFont) await fs.copyFile(systemFont, path.join(jobDir, "font.ttf"));
  for (const [file, name] of fontCopies) await fs.copyFile(file, path.join(jobDir, name));
  for (const file of probePlan.textFiles) await fs.writeFile(path.join(jobDir, file.name), file.content, "utf8");

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const outputName = `video_edit_${stamp}.${settings.format}`;
  const outputPath = path.join(jobDir, outputName);
  await fs.writeFile(path.join(jobDir, "job.json"), JSON.stringify({ outputPath, outputName }));

  const buildArgs = (encoder: Encoder) => {
    const plan = buildPlan(project, media, settings, encoder, total, clipFonts);
    // The graph can be thousands of characters; a script file avoids OS argument limits.
    const script = `filter_${encoder}.txt`;
    writeFileSync(path.join(jobDir, script), plan.graph.join(";\n"), "utf8");
    const args = [...plan.inputs.flat(), "-filter_complex_script", script];
    if (plan.hasVideo) {
      args.push("-map", "[vout]", ...videoCodecArgs(encoder, settings.crf), "-r", String(FPS));
    }
    if (plan.hasAudio) {
      args.push("-map", "[aout]");
      args.push(...(settings.format === "mp3" ? ["-c:a", "libmp3lame", "-q:a", "2"] : ["-c:a", "aac", "-b:a", "192k"]));
    }
    args.push("-t", f(total), "-max_muxing_queue_size", "9999");
    if (settings.format === "mp4" || settings.format === "mov") args.push("-movflags", "+faststart");
    args.push("-y", outputPath);
    return args;
  };

  const originalSize = [...media.values()].reduce((sum, m) => sum + m.size, 0);
  return streamEncodeJob({
    request,
    encoderOrder: primary === "cpu" || settings.format === "mp3" ? ["cpu"] : [primary, "cpu"],
    buildArgs,
    cwd: jobDir,
    jobId,
    outputPath,
    outputName,
    visibleOutputPath: null,
    originalSize,
    expectedDuration: total,
  });
}
