// Shared between /convert and /api/convert: re-encoding every film under some folders to one size.

/** Short side of the output frame: 1080 → 1920×1080 (or 1080×1920 for vertical video). */
export const CONVERT_QUALITIES = ["1080", "720"] as const;
export type ConvertQuality = (typeof CONVERT_QUALITIES)[number];

/** Video files the batch converter picks up (anything ffmpeg reads well). */
export const VIDEO_RE = /\.(mp4|m4v|mov|mkv|avi|wmv|asf|flv|webm|ts|m2ts|mts|mpg|mpeg|vob|3gp|divx|rm|rmvb)$/i;

/** "encode" re-encodes to H.264; "copy" keeps the picture untouched (already H.264 at or below the size). */
export type ConvertAction = "encode" | "copy";

export type ConvertFile = {
  /** Output path relative to the output folder, "/"-separated: unique, so it doubles as the id. */
  key: string;
  /** Output folder relative to the output folder ("Кино/Сериал"). */
  folder: string;
  /** Source file name. */
  source: string;
  duration: number | null;
  size: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  action: ConvertAction | null;
  /** Output frame size when encoding. */
  outSize: [number, number] | null;
  /** Why this file can't be converted (unreadable, name clash …), or null. */
  problem: string | null;
  /** The output already exists. */
  exists: boolean;
};

export type ConvertPlan = { out: string; files: ConvertFile[] };

/**
 * `sources` are folders read recursively; `files` are single films that land straight in `out`.
 * `aspect` (width / height) fixes a stretched picture: the frame is resized to that shape, null keeps it.
 */
export type ConvertOptions = { sources: string[]; files: string[]; out: string; quality: ConvertQuality; copyFit: boolean; aspect: number | null };

export { ASPECT_PRESETS, aspectLabel, CLIP_ASPECT_MAX as ASPECT_MAX, CLIP_ASPECT_MIN as ASPECT_MIN } from "./timeline";

export type ConvertRequest = ConvertOptions & { items: string[] };

export type ConvertEvent =
  | { type: "start"; total: number; totalDuration: number; encoder: string | null; parallel: number }
  | { type: "item"; key: string; state: "running" }
  | { type: "progress"; key: string; percent: number; overall: number; speed: number | null }
  | { type: "item"; key: string; state: "done"; path: string; size: number }
  | { type: "item"; key: string; state: "skipped" | "failed"; message: string }
  | { type: "done"; made: number; skipped: number; failed: number; elapsedMs: number }
  | { type: "error"; message: string };

/** The output file name for a source file: same name, .mp4. */
export function convertedName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "") + ".mp4";
}
