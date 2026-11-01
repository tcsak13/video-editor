import { spawn } from "node:child_process";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import type { Crf, Encoder, MediaInfo } from "@/lib/editor-options";

export const FFMPEG_PATH = process.env.FFMPEG_PATH || ffmpegStatic || "ffmpeg";

/** Runs ffmpeg to completion and returns its exit code and output (probing, thumbnails). */
export function runCapture(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseTimestamp(ts: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(ts.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * ffmpeg-static ships without ffprobe, so we read the stream summary that `ffmpeg -i` prints.
 * ffmpeg exits with code 1 ("At least one output file must be specified"), which is expected.
 */
export async function probeMedia(filePath: string): Promise<MediaInfo> {
  const { stderr } = await runCapture(["-hide_banner", "-nostdin", "-i", filePath]);
  if (!/Stream #/.test(stderr)) {
    throw new Error("Файлыг уншиж чадсангүй — видео файл мөн эсэхийг шалгана уу.");
  }

  const container = /Input #0, (.+?), from /.exec(stderr)?.[1] ?? null;
  const durMatch = /Duration: (\d+:\d{2}:\d{2}(?:\.\d+)?)/.exec(stderr);
  const duration = durMatch ? parseTimestamp(durMatch[1]) : null;

  const lines = stderr.split(/\r?\n/);
  let width: number | null = null;
  let height: number | null = null;
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let videoLineIdx = -1;

  lines.forEach((line, i) => {
    if (videoCodec === null && /Stream #\d+:\d+.*: Video: /.test(line) && !/attached pic/.test(line)) {
      videoCodec = /Video: ([\w-]+)/.exec(line)?.[1] ?? "unknown";
      const dims = /, (\d{2,5})x(\d{2,5})(?=[ ,]|$)/.exec(line);
      if (dims) {
        width = Number(dims[1]);
        height = Number(dims[2]);
      }
      videoLineIdx = i;
    }
    if (audioCodec === null && /Stream #\d+:\d+.*: Audio: /.test(line)) {
      audioCodec = /Audio: ([\w-]+)/.exec(line)?.[1] ?? "unknown";
    }
  });

  // Phone videos carry a display-matrix rotation; ffmpeg auto-rotates on encode, so report display size.
  if (videoLineIdx >= 0 && width && height) {
    for (let i = videoLineIdx + 1; i < lines.length && !/Stream #/.test(lines[i]); i++) {
      const rot = /rotation of (-?[\d.]+) degrees/.exec(lines[i]);
      if (rot && Math.abs(Math.round(Number(rot[1]))) % 180 === 90) {
        [width, height] = [height, width];
        break;
      }
    }
  }

  // Single pictures come through ffmpeg's image demuxers (png_pipe, jpeg_pipe, image2, …).
  const isImage = videoCodec !== null && audioCodec === null && /(_pipe|image2)\b/.test(container ?? "");

  return {
    duration: isImage ? null : duration,
    width,
    height,
    videoCodec,
    audioCodec,
    hasVideo: videoCodec !== null,
    hasAudio: audioCodec !== null,
    container,
    isImage,
  };
}

let encoderCache: Promise<Record<Encoder, boolean>> | null = null;

/** Which H.264 encoders this ffmpeg build includes (not whether the GPU is actually present). */
export function availableEncoders(): Promise<Record<Encoder, boolean>> {
  encoderCache ??= runCapture(["-hide_banner", "-encoders"])
    .then(({ stdout }) => ({
      auto: true,
      cpu: /\blibx264\b/.test(stdout),
      nvenc: /\bh264_nvenc\b/.test(stdout),
      videotoolbox: /\bh264_videotoolbox\b/.test(stdout),
    }))
    .catch(() => {
      encoderCache = null;
      return { auto: true, cpu: false, nvenc: false, videotoolbox: false };
    });
  return encoderCache;
}

/** "auto" → Apple VideoToolbox on macOS when this ffmpeg has it, otherwise libx264. */
export async function resolveEncoder(encoder: Encoder): Promise<Exclude<Encoder, "auto">> {
  if (encoder !== "auto") return encoder;
  const available = await availableEncoders();
  return process.platform === "darwin" && available.videotoolbox ? "videotoolbox" : "cpu";
}

// VideoToolbox has no CRF; -q:v (1–100, Apple Silicon) is its constant-quality knob.
const VT_QUALITY: Record<Crf, number> = { 20: 65, 23: 58, 27: 48 };

export function videoCodecArgs(encoder: Encoder, crf: Crf): string[] {
  switch (encoder) {
    case "auto":
    case "cpu":
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-profile:v", "high"];
    case "nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", String(crf), "-b:v", "0", "-profile:v", "high"];
    case "videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-q:v", String(VT_QUALITY[crf]), "-profile:v", "high"];
  }
}

// Old containers often have missing timestamps; +genpts regenerates them.
const LEGACY_CONTAINERS = new Set([".avi", ".flv", ".wmv", ".asf", ".mpeg", ".mpg", ".vob", ".divx", ".rm", ".rmvb"]);

export function legacyInputFlags(filePath: string): string[] {
  return LEGACY_CONTAINERS.has(path.extname(filePath).toLowerCase()) ? ["-fflags", "+genpts"] : [];
}

export type FfmpegProgress = { outTime: number; speed: number | null; fps: number | null };

export type FfmpegRun = {
  done: Promise<{ code: number | null; log: string }>;
  kill: () => void;
};

/**
 * Spawns ffmpeg with `-progress pipe:1` and reports parsed progress blocks.
 * Keeps only the tail of stderr so multi-hour encodes don't accumulate memory.
 */
export function runFfmpeg(args: string[], cwd: string, onProgress: (p: FfmpegProgress) => void): FfmpegRun {
  const child = spawn(FFMPEG_PATH, ["-hide_banner", "-nostdin", "-progress", "pipe:1", "-nostats", ...args], {
    cwd,
    windowsHide: true,
  });

  let stdoutBuf = "";
  let block: Record<string, string> = {};
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      block[key] = value;
      if (key === "progress") {
        const us = Number(block.out_time_us ?? block.out_time_ms);
        const speed = parseFloat(block.speed ?? "");
        const fps = parseFloat(block.fps ?? "");
        if (Number.isFinite(us) && us >= 0) {
          onProgress({
            outTime: us / 1e6,
            speed: Number.isFinite(speed) ? speed : null,
            fps: Number.isFinite(fps) ? fps : null,
          });
        }
        block = {};
      }
    }
  });

  const logLines: string[] = [];
  let stderrBuf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuf += chunk;
    const parts = stderrBuf.split(/\r?\n|\r/);
    stderrBuf = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      logLines.push(part);
      if (logLines.length > 60) logLines.shift();
    }
  });

  const done = new Promise<{ code: number | null; log: string }>((resolve) => {
    child.on("error", (err) => resolve({ code: -1, log: String(err) }));
    child.on("close", (code) => resolve({ code, log: [...logLines, stderrBuf].join("\n").trim() }));
  });

  return {
    done,
    kill: () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    },
  };
}
