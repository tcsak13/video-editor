import fs from "node:fs/promises";
import path from "node:path";
import { JOINABLE_RE, outputRelPath, splitPartName, type MergeGroup, type MergePlan, type MergeQuality } from "@/lib/merge";
import { parseTimestamp, runCapture } from "@/lib/server/ffmpeg";

type JoinProbe = { duration: number | null; size: number; signature: string; hasAudio: boolean; fps: number | null };

// Re-planning after a rename or a layout switch shouldn't re-read hundreds of files from a USB drive.
const probeCache = new Map<string, { mtimeMs: number; size: number; probe: JoinProbe }>();

/**
 * The codec parameters that must match for a stream-copy join, read from `ffmpeg -i`
 * (ffmpeg-static has no ffprobe). Bitrates and stream flags differ between parts and don't matter.
 */
export async function probeForJoin(file: string): Promise<JoinProbe> {
  const st = await fs.stat(file);
  const cached = probeCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.probe;

  const { stderr } = await runCapture(["-hide_banner", "-nostdin", "-i", file]);
  const durMatch = /Duration: (\d+:\d{2}:\d{2}(?:\.\d+)?)/.exec(stderr);
  const streams = stderr
    .split(/\r?\n/)
    .filter((l) => /Stream #\d+:\d+.*: (Video|Audio): /.test(l) && !/attached pic/.test(l))
    .map((l) =>
      l
        .replace(/^.*?: (Video|Audio): /, "$1: ")
        .replace(/,\s*\d+(\.\d+)? kb\/s/g, "")
        .replace(/\s*\((default|forced|dub|original|comment|lyrics|karaoke)\)/g, "")
        .trim(),
    );
  const probe: JoinProbe = {
    duration: durMatch ? parseTimestamp(durMatch[1]) : null,
    size: st.size,
    signature: streams.join(" | "),
    hasAudio: streams.some((s) => s.startsWith("Audio:")),
    fps: Number(/, (\d+(?:\.\d+)?) fps/.exec(streams.find((s) => s.startsWith("Video:")) ?? "")?.[1]) || null,
  };
  probeCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, probe });
  return probe;
}

const SKIP_DIRS = new Set(["$RECYCLE.BIN", "System Volume Information", "node_modules"]);

async function listJoinable(dir: string, exclude: string, out: string[] = []): Promise<string[]> {
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
      if (p !== exclude) await listJoinable(p, exclude, out);
    } else if (JOINABLE_RE.test(e.name)) out.push(p);
  }
  return out;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Absolute paths of each group's parts, in order, keyed by group key (kept server-side only). */
export type PlanFiles = Map<string, string[]>;

/**
 * Finds every "<name>_<n>" file under `source` (skipping `out` if it's inside), groups the parts
 * per folder and checks that each group can be joined (mixed formats only by re-encoding).
 */
export async function planMerge(source: string, out: string, flat: boolean, quality: MergeQuality): Promise<MergePlan & { files: PlanFiles }> {
  const all = (await listJoinable(source, out)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const byKey = new Map<string, { relDir: string; base: string; ext: string; parts: { file: string; part: number }[] }>();
  const unmatched: string[] = [];
  for (const file of all) {
    const split = splitPartName(path.basename(file));
    const relDir = path.relative(source, path.dirname(file)).split(path.sep).join("/");
    if (!split) {
      unmatched.push(relDir ? `${relDir}/${path.basename(file)}` : path.basename(file));
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    const key = `${relDir}/${split.base}${ext}`;
    if (!byKey.has(key)) byKey.set(key, { relDir, base: split.base, ext, parts: [] });
    byKey.get(key)!.parts.push({ file, part: split.part });
  }

  const probes = new Map<string, JoinProbe>();
  await mapLimit([...byKey.values()].flatMap((g) => g.parts.map((p) => p.file)), 8, async (file) => {
    try {
      probes.set(file, await probeForJoin(file));
    } catch {
      // reported below as unreadable
    }
  });

  const files: PlanFiles = new Map();
  const groups: MergeGroup[] = [];
  for (const [key, g] of byKey) {
    g.parts.sort((a, b) => a.part - b.part);
    const nums = g.parts.map((p) => p.part);
    const missing: number[] = [];
    for (let i = 1; i <= Math.max(...nums); i++) if (!nums.includes(i)) missing.push(i);
    const signatures = new Set(g.parts.map((p) => probes.get(p.file)?.signature));
    const unreadable = g.parts.filter((p) => !probes.get(p.file)?.signature);

    let problem: string | null = null;
    if (new Set(nums).size !== nums.length) problem = `Давхардсан хэсэг: ${nums.join(", ")}`;
    else if (missing.length) problem = `${missing.join(", ")}-р хэсэг дутуу`;
    else if (unreadable.length) problem = `Уншиж чадсангүй: ${unreadable.map((p) => path.basename(p.file)).join(", ")}`;
    else if (g.parts.length < 2) problem = "Ганц хэсэгтэй";

    const parts = g.parts.map((p) => ({
      name: path.basename(p.file),
      part: p.part,
      duration: probes.get(p.file)?.duration ?? null,
      size: probes.get(p.file)?.size ?? 0,
    }));
    const dest = path.join(out, outputRelPath(g, g.base, flat, quality));
    files.set(key, g.parts.map((p) => p.file));
    groups.push({
      key,
      relDir: g.relDir,
      base: g.base,
      ext: g.ext,
      parts,
      duration: parts.reduce((s, p) => s + (p.duration ?? 0), 0),
      size: parts.reduce((s, p) => s + p.size, 0),
      problem,
      mixed: signatures.size > 1,
      exists: await exists(dest),
    });
  }
  groups.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  return { source, out, groups, unmatched, files };
}
