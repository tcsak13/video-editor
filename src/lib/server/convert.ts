import fs from "node:fs/promises";
import path from "node:path";
import type { MediaInfo } from "@/lib/editor-options";
import { CONVERT_QUALITIES, convertedName, VIDEO_RE, type ConvertFile, type ConvertOptions, type ConvertPlan, type ConvertQuality } from "@/lib/convert";
import { frameSize, parseMediaInfo, runCapture } from "@/lib/server/ffmpeg";
import { mapLimit } from "@/lib/server/merge";
import { normalizeLocalPath } from "@/lib/server/storage";

export type ConvertProbe = {
  info: MediaInfo;
  /** Codec of every audio track, in order. */
  audioCodecs: string[];
  /** Most channels on any audio track (2 for stereo, 6 for 5.1). */
  channels: number;
  /** 8-bit 4:2:0, the only pixel format worth stream-copying into an H.264 MP4. */
  plain420: boolean;
};

const CHANNELS: Record<string, number> = { mono: 1, stereo: 2, "2.1": 3, quad: 4, "4.0": 4, "5.0": 5, "5.1": 6, "6.1": 7, "7.1": 8 };

// Re-checking after a quality switch shouldn't re-read hundreds of files from a USB drive.
const probeCache = new Map<string, { mtimeMs: number; size: number; probe: ConvertProbe }>();

async function probeForConvert(file: string, st: { mtimeMs: number; size: number }): Promise<ConvertProbe> {
  const cached = probeCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.probe;

  const { stderr } = await runCapture(["-hide_banner", "-nostdin", "-i", file]);
  const info = parseMediaInfo(stderr);
  const lines = stderr.split(/\r?\n/).filter((l) => /Stream #\d+:\d+/.test(l));
  const audio = lines.filter((l) => /: Audio: /.test(l));
  const video = lines.find((l) => /: Video: /.test(l) && !/attached pic/.test(l)) ?? "";
  const probe: ConvertProbe = {
    info,
    audioCodecs: audio.map((l) => /Audio: ([\w-]+)/.exec(l)?.[1] ?? "unknown"),
    channels: Math.max(0, ...audio.map((l) => CHANNELS[/Hz, ([\w.]+)/.exec(l)?.[1] ?? ""] ?? 2)),
    plain420: /\byuvj?420p\b/.test(video),
  };
  probeCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, probe });
  return probe;
}

const SKIP_DIRS = new Set(["$RECYCLE.BIN", "System Volume Information", "node_modules"]);

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

async function listVideos(dir: string, exclude: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!inside(p, exclude)) await listVideos(p, exclude, out);
    } else if (VIDEO_RE.test(e.name) && !e.name.includes(".partial.")) out.push(p);
  }
  return out;
}

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Where each planned file comes from and what it holds (kept server-side only). */
export type PlanSources = Map<string, { file: string; dest: string; probe: ConvertProbe }>;

/**
 * Lists every video under the chosen folders and decides what happens to it: each lands in
 * `out/<folder name>/<same sub-folders>/<same name>.mp4`. H.264 that is already small enough keeps
 * its picture untouched when `copyFit` is on; everything else is re-encoded to `quality`.
 */
export async function planConvert({ sources, files: singles, out, quality, copyFit }: ConvertOptions): Promise<ConvertPlan & { sources: PlanSources }> {
  // A folder inside another chosen folder would list the same films twice.
  const roots = [...new Set(sources)].filter((s, _, all) => !all.some((o) => o !== s && inside(s, o)));
  const rootNames = new Map<string, string>();
  const used = new Set<string>();
  for (const root of roots) {
    const base = path.basename(root) || "root";
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    rootNames.set(root, name);
  }

  const found: { file: string; key: string; dest: string }[] = [];
  for (const root of roots) {
    const files = await listVideos(root, out);
    for (const file of files) {
      const rel = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean);
      const key = [rootNames.get(root)!, ...rel, convertedName(path.basename(file))].join("/");
      found.push({ file, key, dest: path.join(out, ...key.split("/")) });
    }
  }
  for (const file of new Set(singles)) {
    const key = convertedName(path.basename(file));
    found.push({ file, key, dest: path.join(out, key) });
  }
  found.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));

  const stats = new Map<string, { mtimeMs: number; size: number }>();
  const probes = new Map<string, ConvertProbe | string>();
  await mapLimit(found, 8, async ({ file }) => {
    try {
      const st = await fs.stat(file);
      stats.set(file, st);
      probes.set(file, await probeForConvert(file, st));
    } catch (err) {
      probes.set(file, err instanceof Error ? err.message : "Уншиж чадсангүй");
    }
  });

  const target = Number(quality);
  const seen = new Map<string, string>();
  const planned: PlanSources = new Map();
  const files: ConvertFile[] = [];
  for (const { file, key, dest } of found) {
    const probe = probes.get(file);
    const info = typeof probe === "object" ? probe.info : null;
    const w = info?.width ?? null;
    const h = info?.height ?? null;

    let problem: string | null = typeof probe === "string" ? "Уншиж чадсангүй" : null;
    if (!problem && (!info?.hasVideo || !w || !h)) problem = "Видео дүрс олдсонгүй";
    // "Film.mkv" and "Film.avi" in one folder would both become Film.mp4.
    const twin = seen.get(key.toLowerCase());
    if (!problem && twin) problem = `Ижил нэртэй: ${twin}`;
    if (!problem && path.resolve(dest) === path.resolve(file)) problem = "Эх файлын байранд бичигдэх гэж байна — өөр гаралтын хавтас сонгоно уу";
    if (!twin) seen.set(key.toLowerCase(), path.basename(file));

    let action: ConvertFile["action"] = null;
    if (!problem && typeof probe === "object" && w && h) {
      const fits = Math.min(w, h) <= target;
      // The picture is copied as is; sound that isn't AAC is still re-encoded (cheap).
      const copyable = info?.videoCodec === "h264" && probe.plain420;
      action = copyFit && fits && copyable ? "copy" : "encode";
      planned.set(key, { file, dest, probe });
    }
    files.push({
      // The twin keeps its own extension so every row stays unique; it never gets a destination.
      key: twin ? key.replace(/[^/]+$/, path.basename(file)) : key,
      folder: key.split("/").slice(0, -1).join("/"),
      source: path.basename(file),
      duration: info?.duration ?? null,
      size: stats.get(file)?.size ?? 0,
      width: w,
      height: h,
      videoCodec: info?.videoCodec ?? null,
      action,
      outSize: action === "encode" && w && h ? frameSize(w, h, target) : null,
      problem,
      exists: await exists(dest),
    });
  }
  return { out, files, sources: planned };
}

/** Checks a request body's folders and settings; a string is the error to show. */
export async function readConvertOptions(body: unknown): Promise<ConvertOptions | string> {
  const b = (body ?? {}) as Partial<Record<keyof ConvertOptions, unknown>>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()) : []);
  const raw = list(b.sources);
  const rawFiles = list(b.files);
  if ((!raw.length && !rawFiles.length) || raw.length > 100 || rawFiles.length > 1000) return "Хөрвүүлэх хавтас эсвэл файлаа сонгоно уу.";
  if (typeof b.out !== "string" || !b.out.trim()) return "Гаралтын хавтас сонгоно уу.";
  const sources = raw.map(normalizeLocalPath);
  for (const s of sources) if (!(await fs.stat(s).catch(() => null))?.isDirectory()) return `Хавтас олдсонгүй: ${s}`;
  const files = rawFiles.map(normalizeLocalPath);
  for (const f of files) {
    if (!VIDEO_RE.test(f) || !(await fs.stat(f).catch(() => null))?.isFile()) return `Видео файл олдсонгүй: ${f}`;
  }
  return {
    sources,
    files,
    out: normalizeLocalPath(b.out),
    quality: CONVERT_QUALITIES.includes(b.quality as ConvertQuality) ? (b.quality as ConvertQuality) : "1080",
    copyFit: b.copyFit !== false,
  };
}
