// Shared between the browser UI and the API routes. Keep this file free of Node imports.

export const RESOLUTIONS = ["720", "1080", "480", "original"] as const;
export const CRF_VALUES = [23, 20, 27] as const;
export const ASPECTS = ["original", "16:9", "9:16", "1:1"] as const;
export const ROTATIONS = [0, 90, 180, 270] as const;
export const SPEEDS = [0.5, 1, 1.25, 1.5, 2] as const;
export const VOLUMES = [0.5, 1, 1.5, 2] as const;
export const TEXT_POSITIONS = ["top-left", "center", "bottom-right"] as const;
export const TEXT_SIZES = ["small", "medium", "large"] as const;
export const ENCODERS = ["auto", "cpu", "nvenc", "videotoolbox"] as const;
export const OUTPUT_FORMATS = ["mp4", "mkv", "mov", "mp3"] as const;

export type Resolution = (typeof RESOLUTIONS)[number];
export type Crf = (typeof CRF_VALUES)[number];
export type Aspect = (typeof ASPECTS)[number];
export type Rotation = (typeof ROTATIONS)[number];
export type Speed = (typeof SPEEDS)[number];
export type Volume = (typeof VOLUMES)[number];
export type TextPosition = (typeof TEXT_POSITIONS)[number];
export type TextSize = (typeof TEXT_SIZES)[number];
export type Encoder = (typeof ENCODERS)[number];
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type EditOptions = {
  trimStart: number | null; // seconds
  trimEnd: number | null; // seconds
  resolution: Resolution;
  crf: Crf;
  aspect: Aspect;
  rotate: Rotation;
  hflip: boolean;
  vflip: boolean;
  speed: Speed;
  mute: boolean;
  volume: Volume;
  text: string;
  textPosition: TextPosition;
  textSize: TextSize;
  encoder: Encoder;
  format: OutputFormat;
};

export type SourceRef = { kind: "upload"; id: string } | { kind: "path"; path: string };

export type ProcessRequest = {
  source: SourceRef;
  options: EditOptions;
  saveNextToSource: boolean;
};

export const DEFAULT_OPTIONS: EditOptions = {
  trimStart: null,
  trimEnd: null,
  resolution: "720",
  crf: 23,
  aspect: "original",
  rotate: 0,
  hflip: false,
  vflip: false,
  speed: 1,
  mute: false,
  volume: 1,
  text: "",
  textPosition: "bottom-right",
  textSize: "medium",
  encoder: "auto",
  format: "mp4",
};

export type MediaInfo = {
  duration: number | null; // seconds
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  container: string | null;
  /** Still picture (PNG/JPG/WebP…): no duration of its own, shown for as long as its clip lasts. */
  isImage?: boolean;
};

export type SourceInfo = {
  name: string;
  size: number;
  media: MediaInfo;
};

// Newline-delimited JSON events streamed by POST /api/process.
export type ProcessEvent =
  | { type: "start"; expectedDuration: number | null; encoder: Encoder; outputName: string }
  | { type: "progress"; percent: number | null; outTime: number; speed: number | null; fps: number | null }
  | { type: "fallback"; from: Encoder; to: Encoder; reason: string }
  | {
      type: "done";
      jobId: string;
      outputName: string;
      outputPath: string | null; // set when saved next to the source file
      originalSize: number;
      newSize: number;
      elapsedMs: number;
      encoder: Encoder;
    }
  | { type: "error"; message: string; log?: string };

export const VIDEO_EXTENSIONS = [
  "mp4", "m4v", "mkv", "mov", "avi", "webm", "flv", "wmv", "mpeg", "mpg", "m2ts", "mts", "ts",
  "3gp", "3g2", "ogv", "vob", "asf", "f4v", "divx", "rm", "rmvb", "mxf", "dv",
] as const;

export const FILE_ACCEPT = "video/*," + VIDEO_EXTENSIONS.map((e) => "." + e).join(",");

export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma", "aiff", "aif", "ac3"] as const;

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp"] as const;

export const IMAGE_ACCEPT = IMAGE_EXTENSIONS.map((e) => "." + e).join(",");

export const MEDIA_ACCEPT = FILE_ACCEPT + ",audio/*," + AUDIO_EXTENSIONS.map((e) => "." + e).join(",") + "," + IMAGE_ACCEPT;
