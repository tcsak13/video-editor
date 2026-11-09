// Shared between /merge and /api/merge: joining split parts (KINO_X_1, KINO_X_2 …) into one file.

export type MergePart = { name: string; part: number; duration: number | null; size: number };

export type MergeGroup = {
  /** Stable id: folder (relative to the source) + name without the part number. */
  key: string;
  /** Folder relative to the source ("" for the source itself). */
  relDir: string;
  /** Name without the part number, e.g. KINO_DUULIANT_18_NAS_1. */
  base: string;
  ext: string;
  parts: MergePart[];
  duration: number;
  size: number;
  /** Why this group can't be joined at all (missing or duplicate part …), or null. */
  problem: string | null;
  /** Parts differ in size, codec or fps: only joinable when re-encoding. */
  mixed: boolean;
  /** The output already exists under the default name. */
  exists: boolean;
};

/** "copy" joins without re-encoding; the others re-encode to H.264/AAC MP4 at that height. */
export const MERGE_QUALITIES = ["copy", "1080", "720", "480"] as const;
export type MergeQuality = (typeof MERGE_QUALITIES)[number];

export const MIXED_PROBLEM = "Формат зөрүүтэй (хэмжээ, кодек эсвэл fps өөр) — encode сонговол нийлүүлнэ";

/** Re-encodes always come out as MP4; a copy keeps the parts' container. */
export function outputExt(group: Pick<MergeGroup, "ext">, quality: MergeQuality): string {
  return quality === "copy" ? group.ext : ".mp4";
}

export type MergePlan = { source: string; out: string; groups: MergeGroup[]; unmatched: string[] };

export type MergeItem = { key: string; name: string };

export type MergeRequest = { source: string; out: string; flat: boolean; quality: MergeQuality; items: MergeItem[] };

export type MergeEvent =
  | { type: "start"; total: number; totalDuration: number; encoder: string | null }
  | { type: "item"; key: string; state: "running" }
  | { type: "progress"; key: string; percent: number; overall: number }
  | { type: "item"; key: string; state: "done"; path: string }
  | { type: "item"; key: string; state: "skipped" | "failed"; message: string }
  | { type: "done"; made: number; skipped: number; failed: number; elapsedMs: number }
  | { type: "error"; message: string };

export type FsEntry = { name: string; path: string };

export type FsFile = FsEntry & { size: number };

/** `files` (every video in the folder) only when asked for with ?files=1. */
export type FsListing = { path: string; parent: string | null; dirs: FsEntry[]; videos: number; files?: FsFile[] };

/** Containers ffmpeg's concat demuxer can stream-copy. */
export const JOINABLE_RE = /\.(mp4|m4v|mov|mkv|ts|m2ts|mts)$/i;

/** "<name>_<n>" with an optional "ok" after the part number (KINO_X_1, KINO_X_1_ok, KINO_X_1ok). */
const PART_RE = /^(.*)_(\d+)_?ok$|^(.*)_(\d+)$/i;

export function splitPartName(fileName: string): { base: string; part: number } | null {
  const m = PART_RE.exec(fileName.replace(JOINABLE_RE, ""));
  if (!m) return null;
  const base = m[1] ?? m[3];
  return base ? { base, part: Number(m[2] ?? m[4]) } : null;
}

/** Characters that are invalid in file names on Windows/macOS/Linux. */
export function cleanOutputName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim().slice(0, 150);
}

/** Where a group lands relative to the output folder. */
export function outputRelPath(group: Pick<MergeGroup, "relDir" | "ext">, name: string, flat: boolean, quality: MergeQuality): string {
  const file = cleanOutputName(name) + outputExt(group, quality);
  return flat || !group.relDir ? file : `${group.relDir}/${file}`;
}
