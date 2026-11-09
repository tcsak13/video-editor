#!/usr/bin/env node
// Joins split movies/episodes back into one file each, losslessly (stream copy, no re-encode).
//   KINO_X_1.mp4, KINO_X_2.mp4, KINO_X_3.mp4         → KINO_X.mp4
//   KINO_SERIES_4_1.mp4, KINO_SERIES_4_2.mp4          → KINO_SERIES_4.mp4
// A trailing "ok" on the part number is ignored (KINO_X_1_ok, KINO_X_1ok, KINO_X_1_OK).
// The folder layout under <source> is mirrored under <out>. Source files are never modified.
//
//   node scripts/merge-parts.mjs <source> <out>            # dry run: show what would be joined
//   node scripts/merge-parts.mjs <source> <out> --yes      # write the files
//   --skip NAME           leave out the group whose joined name is NAME (repeatable)
//   --rename OLD=NEW      write group OLD as NEW (repeatable)
//
// Needs ffmpeg + ffprobe on PATH (or FFMPEG / FFPROBE env vars).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";
const PART_RE = /^(.*)_(\d+)_?ok$|^(.*)_(\d+)$/i;
const VIDEO_RE = /\.(mp4|mov|m4v|mkv)$/i;

function parseArgs(argv) {
  const opts = { positional: [], yes: false, skip: new Set(), rename: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--skip") opts.skip.add(argv[++i]);
    else if (a === "--rename") {
      const [from, to] = String(argv[++i]).split("=");
      if (!from || !to) throw new Error(`--rename OLD=NEW хэлбэртэй байх ёстой`);
      opts.rename.set(from, to);
    } else opts.positional.push(a);
  }
  if (opts.positional.length !== 2) {
    throw new Error("Хэрэглээ: node scripts/merge-parts.mjs <эх хавтас> <гаралтын хавтас> [--yes] [--skip NAME] [--rename OLD=NEW]");
  }
  return opts;
}

async function listVideos(dir, exclude) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name.startsWith("$")) continue;
    const p = path.join(dir, e.name);
    if (p === exclude) continue;
    if (e.isDirectory()) out.push(...(await listVideos(p, exclude)));
    else if (VIDEO_RE.test(e.name)) out.push(p);
  }
  return out;
}

/** Codec parameters that must match for a stream-copy join, plus the duration. */
function probe(file) {
  const j = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file]).toString());
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  const sig = [
    v ? [v.codec_name, v.profile, `${v.width}x${v.height}`, v.pix_fmt, v.r_frame_rate].join(" ") : "no video",
    a ? [a.codec_name, a.profile, a.sample_rate, a.channels].join(" ") : "no audio",
  ].join(" | ");
  return { sig, duration: Number(j.format.duration) || 0, size: Number(j.format.size) || 0, hasAudio: !!a };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split("\n").slice(-3).join("\n")))));
  });
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const fmtDur = (s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtGB = (b) => `${(b / 1e9).toFixed(2)} GB`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const src = path.resolve(opts.positional[0]);
  const out = path.resolve(opts.positional[1]);

  // Group files by folder + name without the part number.
  const groups = new Map();
  const unmatched = [];
  for (const file of (await listVideos(src, out)).sort()) {
    const name = path.basename(file).replace(VIDEO_RE, "");
    const m = PART_RE.exec(name);
    if (!m) {
      unmatched.push(file);
      continue;
    }
    const base = m[1] ?? m[3];
    const part = Number(m[2] ?? m[4]);
    const key = `${path.dirname(file)}\0${base}`;
    if (!groups.has(key)) groups.set(key, { dir: path.dirname(file), base, parts: [] });
    groups.get(key).parts.push({ file, part });
  }

  const jobs = [];
  const problems = [];
  for (const g of groups.values()) {
    if (opts.skip.has(g.base)) {
      console.log(`  - алгасав: ${g.base}`);
      continue;
    }
    g.parts.sort((a, b) => a.part - b.part);
    const nums = g.parts.map((p) => p.part);
    const name = opts.rename.get(g.base) ?? g.base;
    const rel = path.relative(src, g.dir);
    const dest = path.join(out, rel, `${name}${path.extname(g.parts[0].file)}`);
    const label = path.join(rel, name);
    if (new Set(nums).size !== nums.length) {
      problems.push(`${label}: давхардсан хэсэг (${nums.join(", ")})`);
      continue;
    }
    const missing = [];
    for (let i = 1; i <= Math.max(...nums); i++) if (!nums.includes(i)) missing.push(i);
    if (missing.length) {
      problems.push(`${label}: ${missing.join(", ")}-р хэсэг дутуу`);
      continue;
    }
    for (const p of g.parts) Object.assign(p, probe(p.file));
    const sigs = new Set(g.parts.map((p) => p.sig));
    if (sigs.size > 1) {
      problems.push(`${label}: хэсгүүдийн формат өөр тул шууд залгах боломжгүй\n      ${[...sigs].join("\n      ")}`);
      continue;
    }
    jobs.push({ label, dest, parts: g.parts, duration: g.parts.reduce((s, p) => s + p.duration, 0), size: g.parts.reduce((s, p) => s + p.size, 0) });
  }
  if (new Set(jobs.map((j) => j.dest)).size !== jobs.length) throw new Error("Хоёр бүлэг ижил нэртэй файл руу бичих гэж байна. --rename/--skip ашиглана уу.");

  jobs.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  for (const j of jobs) {
    const done = (await exists(j.dest)) ? "  (аль хэдийн бий)" : "";
    console.log(`${j.label.padEnd(56)} ${String(j.parts.length).padStart(2)} хэсэг  ${fmtDur(j.duration)}  ${fmtGB(j.size)}${done}`);
  }
  for (const f of unmatched) console.log(`  ? хэсгийн дугааргүй тул алгасав: ${path.relative(src, f)}`);
  for (const p of problems) console.log(`  ! ${p}`);
  const total = jobs.reduce((s, j) => s + j.size, 0);
  console.log(`\nНийт ${jobs.length} файл, ${fmtGB(total)} → ${out}`);
  if (!opts.yes) {
    console.log("Энэ бол туршилт (dry run). Бичихийн тулд --yes нэмж ажиллуулна уу.");
    return;
  }

  const listDir = await fs.mkdtemp(path.join(os.tmpdir(), "merge-parts-"));
  let made = 0;
  let failed = 0;
  const started = Date.now();
  for (const [i, j] of jobs.entries()) {
    const tag = `[${i + 1}/${jobs.length}] ${j.label}`;
    if (await exists(j.dest)) {
      console.log(`${tag}: аль хэдийн бий, алгасав`);
      continue;
    }
    await fs.mkdir(path.dirname(j.dest), { recursive: true });
    const list = path.join(listDir, `${i}.txt`);
    await fs.writeFile(list, j.parts.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'\n`).join(""));
    // Write next to the destination under a temp name so an interrupted run never leaves a half file.
    const tmp = `${j.dest}.partial${path.extname(j.dest)}`;
    try {
      await run(FFMPEG, [
        "-hide_banner", "-nostdin", "-v", "error", "-f", "concat", "-safe", "0", "-i", list,
        "-map", "0:v:0", ...(j.parts[0].hasAudio ? ["-map", "0:a:0"] : []),
        "-c", "copy", "-movflags", "+faststart", "-y", tmp,
      ]);
      const got = probe(tmp).duration;
      if (Math.abs(got - j.duration) > 2) throw new Error(`урт таарсангүй: ${fmtDur(got)} ≠ ${fmtDur(j.duration)}`);
      await fs.rename(tmp, j.dest);
      made++;
      console.log(`${tag}: ✓ ${fmtDur(got)}  (${Math.round((Date.now() - started) / 1000)}s)`);
    } catch (err) {
      failed++;
      await fs.rm(tmp, { force: true });
      console.log(`${tag}: ✗ ${err.message}`);
    }
  }
  await fs.rm(listDir, { recursive: true, force: true });
  console.log(`\nДууслаа: ${made} шинэ файл, ${failed} алдаа, ${Math.round((Date.now() - started) / 60000)} мин.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
