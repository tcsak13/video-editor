import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ASPECTS,
  CRF_VALUES,
  DEFAULT_OPTIONS,
  ENCODERS,
  OUTPUT_FORMATS,
  RESOLUTIONS,
  ROTATIONS,
  SPEEDS,
  TEXT_POSITIONS,
  TEXT_SIZES,
  VOLUMES,
  type Aspect,
  type EditOptions,
  type Encoder,
  type ProcessRequest,
} from "@/lib/editor-options";
import { availableEncoders, legacyInputFlags, probeMedia, resolveEncoder, videoCodecArgs } from "@/lib/server/ffmpeg";
import { findFont, streamEncodeJob } from "@/lib/server/job";
import {
  JOBS_DIR,
  jsonError,
  normalizeLocalPath,
  rejectNonLocal,
  safeBaseName,
  statFile,
  sweepOldData,
  uniquePath,
  uploadedFilePath,
} from "@/lib/server/storage";

// ---------------------------------------------------------------------------
// Option validation — everything that reaches ffmpeg comes from these whitelists.
// ---------------------------------------------------------------------------

function pick<T>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sanitizeOptions(raw: unknown): EditOptions {
  const o = (raw ?? {}) as Partial<Record<keyof EditOptions, unknown>>;
  const d = DEFAULT_OPTIONS;
  return {
    trimStart: seconds(o.trimStart),
    trimEnd: seconds(o.trimEnd),
    resolution: pick(RESOLUTIONS, o.resolution, d.resolution),
    crf: pick(CRF_VALUES, o.crf, d.crf),
    aspect: pick(ASPECTS, o.aspect, d.aspect),
    rotate: pick(ROTATIONS, o.rotate, d.rotate),
    hflip: o.hflip === true,
    vflip: o.vflip === true,
    speed: pick(SPEEDS, o.speed, d.speed),
    mute: o.mute === true,
    volume: pick(VOLUMES, o.volume, d.volume),
    text: typeof o.text === "string" ? o.text.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200) : "",
    textPosition: pick(TEXT_POSITIONS, o.textPosition, d.textPosition),
    textSize: pick(TEXT_SIZES, o.textSize, d.textSize),
    encoder: pick(ENCODERS, o.encoder, d.encoder),
    format: pick(OUTPUT_FORMATS, o.format, d.format),
  };
}

// ---------------------------------------------------------------------------
// Filtergraph builder — every edit is combined into one -vf / -af chain so the
// whole job is a single decode → filter → encode pass.
// ---------------------------------------------------------------------------

const ASPECT_RATIOS: Record<Exclude<Aspect, "original">, [number, number]> = {
  "16:9": [16, 9],
  "9:16": [9, 16],
  "1:1": [1, 1],
};

const TEXT_SIZE_DIVISOR = { small: 32, medium: 20, large: 12 } as const;

// Single quotes protect the commas inside expressions from the filtergraph parser.
const TEXT_XY = {
  "top-left": "x='min(w,h)/30':y='min(w,h)/30'",
  center: "x='(w-text_w)/2':y='(h-text_h)/2'",
  "bottom-right": "x='w-text_w-min(w,h)/30':y='h-text_h-min(w,h)/30'",
} as const;

function buildVideoFilters(o: EditOptions, fontFile: string | null): string[] {
  const filters: string[] = [];
  const quarterTurn = o.rotate === 90 || o.rotate === 270;

  // 1. Center crop. It runs before rotation (cheaper on big frames), so for 90°/270°
  //    we crop to the inverted ratio — after rotating, the frame has the chosen ratio.
  if (o.aspect !== "original") {
    const [rw, rh] = quarterTurn ? [...ASPECT_RATIOS[o.aspect]].reverse() : ASPECT_RATIOS[o.aspect];
    filters.push(`crop=w='trunc(min(iw,ih*${rw}/${rh})/2)*2':h='trunc(min(ih,iw*${rh}/${rw})/2)*2'`);
  }

  // 2. Scale so the SHORT side equals the target (720p works for portrait/Reels too),
  //    never upscale, and keep both dimensions even as yuv420p requires.
  if (o.resolution !== "original") {
    const t = Number(o.resolution);
    filters.push(
      `scale=w='if(gte(iw,ih),-2,trunc(min(${t},iw)/2)*2)':h='if(gte(iw,ih),trunc(min(${t},ih)/2)*2,-2)':flags=lanczos`,
    );
  } else {
    filters.push("scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'");
  }

  // 3. Rotate & flip.
  if (o.rotate === 90) filters.push("transpose=clock");
  else if (o.rotate === 180) filters.push("hflip", "vflip");
  else if (o.rotate === 270) filters.push("transpose=cclock");
  if (o.hflip) filters.push("hflip");
  if (o.vflip) filters.push("vflip");

  // 4. Playback speed.
  if (o.speed !== 1) filters.push(`setpts=PTS/${o.speed}`);

  // 5. Text watermark. Font and text are files in the job's working dir, which avoids
  //    all filtergraph escaping issues (Windows drive colons, quotes, % in the text).
  if (fontFile) {
    const size = `'min(w,h)/${TEXT_SIZE_DIVISOR[o.textSize]}'`;
    filters.push(
      `drawtext=fontfile=${fontFile}:textfile=text.txt:expansion=none:fontsize=${size}:fontcolor=white` +
        `:borderw=2:bordercolor=black@0.45:shadowcolor=black@0.5:shadowx=2:shadowy=2:${TEXT_XY[o.textPosition]}`,
    );
  }

  // 6. 8-bit 4:2:0 plays everywhere (converts 10-bit HDR, 4:2:2 ProRes, paletted AVI…).
  filters.push("format=yuv420p");
  return filters;
}

function buildAudioFilters(o: EditOptions): string[] {
  const filters: string[] = [];
  if (o.speed !== 1) filters.push(`atempo=${o.speed}`);
  if (o.volume !== 1) filters.push(`volume=${o.volume}`);
  return filters;
}

function buildArgs(
  o: EditOptions,
  input: { path: string; hasAudio: boolean },
  encoder: Encoder,
  fontFile: string | null,
  outputPath: string,
): string[] {
  const args: string[] = [];

  if (encoder === "videotoolbox" && o.format !== "mp3") args.push("-hwaccel", "videotoolbox");
  args.push(...legacyInputFlags(input.path));
  // Input-side -ss/-to: fast keyframe seek, then frame-accurate decode to the exact start.
  if (o.trimStart) args.push("-ss", o.trimStart.toFixed(3));
  if (o.trimEnd !== null) args.push("-to", o.trimEnd.toFixed(3));
  args.push("-i", input.path);

  const audioFilters = buildAudioFilters(o);
  const keepAudio = input.hasAudio && !o.mute;

  if (o.format === "mp3") {
    args.push("-map", "0:a:0", "-vn", "-sn", "-dn");
    if (audioFilters.length) args.push("-af", audioFilters.join(","));
    args.push("-c:a", "libmp3lame", "-q:a", "2", "-ac", "2");
  } else {
    // 0:V (capital) skips cover-art "video" streams; subtitles/data are dropped because
    // e.g. MKV PGS/ASS subtitles can't go into MP4 and would fail the whole job.
    args.push("-map", "0:V:0");
    if (keepAudio) args.push("-map", "0:a:0");
    args.push("-sn", "-dn");
    args.push("-vf", buildVideoFilters(o, fontFile).join(","));
    args.push(...videoCodecArgs(encoder, o.crf));
    if (keepAudio) {
      if (audioFilters.length) args.push("-af", audioFilters.join(","));
      args.push("-c:a", "aac", "-b:a", "128k");
    } else {
      args.push("-an");
    }
    args.push("-max_muxing_queue_size", "4096");
    if (o.format === "mp4" || o.format === "mov") args.push("-movflags", "+faststart");
  }

  args.push("-y", outputPath);
  return args;
}

// ---------------------------------------------------------------------------
// POST /api/process — streams newline-delimited JSON ProcessEvents.
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as Partial<ProcessRequest> | null;
  if (!body?.source) return jsonError("Эх файл сонгоогүй байна.");
  const o = sanitizeOptions(body.options);

  // Resolve the input file.
  let inputPath: string | null = null;
  let sourceName = "video";
  if (body.source.kind === "upload") {
    inputPath = await uploadedFilePath(body.source.id);
    if (inputPath) sourceName = path.basename(inputPath);
  } else if (body.source.kind === "path" && typeof body.source.path === "string") {
    inputPath = normalizeLocalPath(body.source.path);
    sourceName = path.basename(inputPath);
  }
  const inputStat = inputPath ? await statFile(inputPath) : null;
  if (!inputPath || !inputStat) return jsonError("Эх файл олдсонгүй. Дахин сонгоно уу.", 404);

  let media;
  try {
    media = await probeMedia(inputPath);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Файлыг уншиж чадсангүй.", 422);
  }

  // Validate the combination of options against the actual file.
  if (o.format === "mp3") {
    if (!media.hasAudio) return jsonError("Энэ файлд дууны урсгал алга — MP3 гаргах боломжгүй.");
    if (o.mute) return jsonError("Дууг хаасан үед MP3 гаргах боломжгүй.");
  } else if (!media.hasVideo) {
    return jsonError("Энэ файлд видео урсгал олдсонгүй.");
  }
  if (o.trimStart !== null && o.trimEnd !== null && o.trimEnd <= o.trimStart) {
    return jsonError("Дуусах цаг эхлэх цагаас хойш байх ёстой.");
  }
  if (media.duration && o.trimStart !== null && o.trimStart >= media.duration) {
    return jsonError("Эхлэх цаг видеоны уртаас хэтэрсэн байна.");
  }
  const encoders = await availableEncoders();
  if (!encoders[o.encoder]) return jsonError("Сонгосон хөдөлгүүр энэ ffmpeg-д байхгүй байна. CPU сонгоно уу.");
  const primaryEncoder = await resolveEncoder(o.encoder);

  const wantsText = o.text !== "" && o.format !== "mp3";
  const systemFont = wantsText ? await findFont() : null;
  if (wantsText && !systemFont) {
    return jsonError("Текст зурах фонт олдсонгүй. WATERMARK_FONT орчны хувьсагчаар .ttf файл заана уу.");
  }

  // Prepare the job directory (ffmpeg runs with it as cwd).
  await sweepOldData();
  const jobId = randomUUID();
  const jobDir = path.join(JOBS_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  let fontFile: string | null = null;
  if (systemFont) {
    fontFile = "font" + path.extname(systemFont).toLowerCase();
    await fs.copyFile(systemFont, path.join(jobDir, fontFile));
    await fs.writeFile(path.join(jobDir, "text.txt"), o.text, "utf8");
  }

  const saveNextToSource = body.source.kind === "path" && body.saveNextToSource === true;
  const outputPath = await uniquePath(
    saveNextToSource ? path.dirname(inputPath) : jobDir,
    `${safeBaseName(sourceName)}_edited`,
    o.format,
  );
  const outputName = path.basename(outputPath);
  await fs.writeFile(path.join(jobDir, "job.json"), JSON.stringify({ outputPath, outputName }));

  // Duration of the output, used for the progress percentage.
  const start = o.trimStart ?? 0;
  const end = Math.min(o.trimEnd ?? Infinity, media.duration ?? Infinity);
  const expectedDuration = Number.isFinite(end) && end > start ? (end - start) / o.speed : null;

  const input = { path: inputPath, hasAudio: media.hasAudio };

  return streamEncodeJob({
    request,
    encoderOrder: primaryEncoder === "cpu" ? ["cpu"] : [primaryEncoder, "cpu"],
    buildArgs: (encoder) => buildArgs(o, input, encoder, fontFile, outputPath),
    cwd: jobDir,
    jobId,
    outputPath,
    outputName,
    visibleOutputPath: saveNextToSource ? outputPath : null,
    originalSize: inputStat.size,
    expectedDuration,
    cleanup: async () => {
      if (!fontFile) return;
      await fs.rm(path.join(jobDir, fontFile), { force: true });
      await fs.rm(path.join(jobDir, "text.txt"), { force: true });
    },
  });
}
