// Timeline project model shared by the editor UI and POST /api/render. No Node imports.
import type { Crf, Encoder, SourceRef } from "@/lib/editor-options";

export const FPS = 30;
export const MIN_CLIP = 0.1; // seconds

export const CANVAS_ASPECTS = ["16:9", "9:16", "1:1", "4:5", "4:3"] as const;
export type CanvasPreset = (typeof CANVAS_ASPECTS)[number];
/** A preset, or a custom "w:h" made by fitting the canvas to a clip's picture. */
export type CanvasAspect = CanvasPreset | `${number}:${number}`;

function parseAspect(aspect: unknown): [number, number] | null {
  const m = typeof aspect === "string" ? /^(\d{1,5}):(\d{1,5})$/.exec(aspect) : null;
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 0 && b > 0 && a / b >= 0.1 && a / b <= 10 ? [a, b] : null;
}

export function isCanvasAspect(v: unknown): v is CanvasAspect {
  return parseAspect(v) !== null;
}

/** Canvas shape for a picture of w×h: the matching preset if there is one, else the exact "w:h". */
export function aspectFromSize(w: number, h: number): CanvasAspect {
  const preset = CANVAS_ASPECTS.find((a) => Math.abs(aspectRatio(a) / (w / h) - 1) < 0.005);
  if (preset) return preset;
  let a = Math.max(1, Math.round(w));
  let b = Math.max(1, Math.round(h));
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  const g = gcd(a, b);
  a /= g;
  b /= g;
  return parseAspect(`${a}:${b}`) ? `${a}:${b}` : "16:9";
}

export const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const ROTATIONS = [0, 90, 180, 270] as const;
export type Rotation = (typeof ROTATIONS)[number];

export type TrackKind = "video" | "audio" | "text";
export type Track = { id: string; kind: TrackKind; muted: boolean; hidden: boolean; locked: boolean };

export type Crop = { l: number; r: number; t: number; b: number }; // fractions of the source frame

export type MediaClip = {
  id: string;
  trackId: string;
  type: "video" | "audio";
  mediaId: string;
  start: number; // timeline position (s)
  in: number; // source in-point (s)
  out: number; // source out-point (s)
  speed: number;
  volume: number; // 0–2
  muted: boolean;
  /** Video clip whose sound now lives in a separate audio clip. */
  audioDetached: boolean;
  /** Picture hidden in preview/export (sound still plays). */
  hidden?: boolean;
  fadeIn: number;
  fadeOut: number;
  // visual (video clips)
  x: number; // center, fraction of canvas width
  y: number; // center, fraction of canvas height
  scale: number; // 1 = fit inside the canvas
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  opacity: number;
  crop: Crop;
};

export const TEXT_STYLES = ["box", "outline", "plain"] as const;
export type TextStyle = (typeof TEXT_STYLES)[number];

export type TextClip = {
  id: string;
  trackId: string;
  type: "text";
  start: number;
  duration: number;
  text: string;
  x: number;
  y: number;
  size: number; // font size as a fraction of canvas height
  color: string; // #rrggbb
  style: TextStyle;
  hidden?: boolean;
  /** Downloaded Google Font family (see `npm run fonts`); unset = the default system font. */
  font?: string;
  /** Bold weight — only offered when the family ships a bold file. */
  bold?: boolean;
};

export type Clip = MediaClip | TextClip;

export type Project = {
  version: 1;
  tracks: Track[]; // display order, top first; higher video tracks draw in front
  clips: Clip[];
  aspect: CanvasAspect;
  background: string; // #rrggbb
};

export const EXPORT_RESOLUTIONS = ["720", "1080", "480"] as const;
export const EXPORT_FORMATS = ["mp4", "mov", "mkv", "mp3"] as const;
export type ExportSettings = {
  resolution: (typeof EXPORT_RESOLUTIONS)[number];
  crf: Crf;
  encoder: Encoder;
  format: (typeof EXPORT_FORMATS)[number];
};

export type RenderRequest = {
  project: Project;
  media: { id: string; source: SourceRef }[];
  settings: ExportSettings;
};

export const NO_CROP: Crop = { l: 0, r: 0, t: 0, b: 0 };

export function clipDuration(c: Clip): number {
  return c.type === "text" ? c.duration : (c.out - c.in) / c.speed;
}

export function clipEnd(c: Clip): number {
  return c.start + clipDuration(c);
}

export function projectDuration(clips: Clip[]): number {
  return clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}

/** Even pixel size of the export canvas; the short side equals `shortSide`. */
export function canvasSize(aspect: CanvasAspect, shortSide: number): { w: number; h: number } {
  const [a, b] = parseAspect(aspect) ?? [16, 9];
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return a >= b ? { w: even((shortSide * a) / b), h: shortSide } : { w: shortSide, h: even((shortSide * b) / a) };
}

export function aspectRatio(aspect: CanvasAspect): number {
  const [a, b] = parseAspect(aspect) ?? [16, 9];
  return a / b;
}

/** Canvas preset closest to a source's aspect ratio (used for the first clip added). */
export function nearestAspect(w: number, h: number): CanvasAspect {
  const r = w / h;
  return CANVAS_ASPECTS.reduce((best, a) =>
    Math.abs(Math.log(aspectRatio(a) / r)) < Math.abs(Math.log(aspectRatio(best) / r)) ? a : best,
  );
}

/** Largest fraction cropped off one axis — at least 5% of the picture always remains. */
export const MAX_CROP = 0.95;

/** Clamp crop insets so each axis keeps at least (1 - MAX_CROP) of the frame. */
export function clampCrop(c: Crop): Crop {
  const f = (v: number) => (Number.isFinite(v) ? Math.min(MAX_CROP, Math.max(0, v)) : 0);
  const axis = (a: number, b: number) => {
    const k = a + b > MAX_CROP ? MAX_CROP / (a + b) : 1;
    return [a * k, b * k];
  };
  const [l, r] = axis(f(c.l), f(c.r));
  const [t, b] = axis(f(c.t), f(c.b));
  return { l, r, t, b };
}

/**
 * Crop insets are stored in source-frame space (ffmpeg crops before transpose/flip).
 * These convert them to/from the frame as it appears on screen after rotation + flips.
 */
export function cropToDisplay(c: Crop, rotate: Rotation, flipH: boolean, flipV: boolean): Crop {
  let d: Crop =
    rotate === 90
      ? { l: c.b, t: c.l, r: c.t, b: c.r }
      : rotate === 180
        ? { l: c.r, t: c.b, r: c.l, b: c.t }
        : rotate === 270
          ? { l: c.t, t: c.r, r: c.b, b: c.l }
          : { ...c };
  if (flipH) d = { ...d, l: d.r, r: d.l };
  if (flipV) d = { ...d, t: d.b, b: d.t };
  return d;
}

export function cropFromDisplay(d: Crop, rotate: Rotation, flipH: boolean, flipV: boolean): Crop {
  if (flipH) d = { ...d, l: d.r, r: d.l };
  if (flipV) d = { ...d, t: d.b, b: d.t };
  if (rotate === 90) return { l: d.t, t: d.r, r: d.b, b: d.l };
  if (rotate === 180) return { l: d.r, t: d.b, r: d.l, b: d.t };
  if (rotate === 270) return { l: d.b, t: d.l, r: d.t, b: d.r };
  return { ...d };
}

/** Size of the clip's picture after crop and rotation, in source pixels. */
export function visualSize(srcW: number, srcH: number, crop: Crop, rotate: Rotation): { w: number; h: number } {
  const w = srcW * (1 - crop.l - crop.r);
  const h = srcH * (1 - crop.t - crop.b);
  return rotate === 90 || rotate === 270 ? { w: h, h: w } : { w, h };
}

/** Clip size on a canvas of cw×ch: contain-fit, then multiplied by clip.scale. */
export function clipBoxSize(
  srcW: number,
  srcH: number,
  clip: Pick<MediaClip, "crop" | "rotate" | "scale">,
  cw: number,
  ch: number,
): { w: number; h: number } {
  const v = visualSize(srcW, srcH, clip.crop, clip.rotate);
  const fit = Math.min(cw / v.w, ch / v.h);
  return { w: v.w * fit * clip.scale, h: v.h * fit * clip.scale };
}

/** clip.scale value that makes the picture cover the whole canvas (no bars). */
export function coverScale(srcW: number, srcH: number, clip: Pick<MediaClip, "crop" | "rotate">, aspect: CanvasAspect): number {
  const v = visualSize(srcW, srcH, clip.crop, clip.rotate);
  const ar = aspectRatio(aspect);
  const fitW = Math.min(ar / v.w, 1 / v.h);
  const coverW = Math.max(ar / v.w, 1 / v.h);
  return coverW / fitW;
}

export const TEXT_LINE_HEIGHT = 1.25;
