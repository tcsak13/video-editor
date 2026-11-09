import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Encoder } from "@/lib/editor-options";
import { cleanOutputName, MERGE_QUALITIES, MIXED_PROBLEM, outputRelPath, type MergeEvent, type MergeGroup, type MergeItem, type MergeQuality } from "@/lib/merge";
import { availableEncoders, frameSize, probeMedia, resolveEncoder, runFfmpeg, videoCodecArgs, type FfmpegRun } from "@/lib/server/ffmpeg";
import { planMerge, probeForJoin } from "@/lib/server/merge";
import { JOBS_DIR, jsonError, normalizeLocalPath, rejectNonLocal, sweepOldData } from "@/lib/server/storage";

type Job = { group: MergeGroup; files: string[]; dest: string; audio: boolean[]; fps: string };

const ENCODER_LABEL: Record<Exclude<Encoder, "auto">, string> = { cpu: "CPU (libx264)", nvenc: "NVIDIA NVENC", videotoolbox: "Apple VideoToolbox" };

/** ffmpeg prints NTSC rates rounded (29.97); the fps filter needs the exact fraction or it drops frames. */
function fpsExpr(fps: number | null): string {
  if (!fps || fps < 5 || fps > 240) return "25";
  const ntsc = Math.round(fps * 1.001);
  return Math.abs(fps - ntsc / 1.001) < 0.01 && Math.abs(fps - ntsc) > 0.01 ? `${ntsc * 1000}/1001` : String(fps);
}

/**
 * Re-encode join through the concat filter, so parts may differ in size, codec or fps: each is
 * fitted into the same frame (letterboxed if its shape differs) at the first part's frame rate,
 * and parts without sound get silence. Without the common fps, mixed rates make the concat output
 * rate bogus and ffmpeg duplicates frames forever.
 */
function encodeArgs(job: Job, size: [number, number], encoder: Exclude<Encoder, "auto">, tmp: string): string[] {
  const [w, h] = size;
  const withAudio = job.audio.some(Boolean);
  const inputs: string[] = [];
  const graph: string[] = [];
  let concatIn = "";
  job.files.forEach((file, i) => {
    if (encoder === "videotoolbox") inputs.push("-hwaccel", "videotoolbox");
    inputs.push("-i", file);
    graph.push(`[${i}:V:0]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${job.fps},format=yuv420p[v${i}]`);
    concatIn += `[v${i}]`;
    if (!withAudio) return;
    graph.push(
      job.audio[i]
        ? `[${i}:a:0]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${(job.group.parts[i].duration ?? 0).toFixed(3)}[a${i}]`,
    );
    concatIn += `[a${i}]`;
  });
  graph.push(`${concatIn}concat=n=${job.files.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? "[a]" : ""}`);
  return [
    ...inputs,
    "-filter_complex", graph.join(";"),
    "-map", "[v]", ...(withAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"] : []),
    ...videoCodecArgs(encoder, 23),
    "-max_muxing_queue_size", "4096", "-movflags", "+faststart", "-y", tmp,
  ];
}

function copyArgs(job: Job, list: string, tmp: string): string[] {
  const faststart = /^\.(mp4|m4v|mov)$/.test(job.group.ext) ? ["-movflags", "+faststart"] : [];
  return [
    "-f", "concat", "-safe", "0", "-i", list,
    "-map", "0:v:0", ...(job.audio[0] ? ["-map", "0:a:0"] : []),
    "-c", "copy", ...faststart, "-y", tmp,
  ];
}

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// POST /api/merge { source, out, flat, quality, items: [{ key, name }] } — joins each chosen group's
// parts, with a stream copy or a re-encode to `quality`, and streams NDJSON MergeEvents.
// Source files are never touched.
export async function POST(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { source?: unknown; out?: unknown; flat?: unknown; quality?: unknown; items?: unknown } | null;
  if (typeof body?.source !== "string" || typeof body.out !== "string" || !body.source.trim() || !body.out.trim()) {
    return jsonError("Эх болон гаралтын хавтсаа сонгоно уу.");
  }
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 5000) return jsonError("Нийлүүлэх файл сонгоогүй байна.");
  const source = normalizeLocalPath(body.source);
  const out = normalizeLocalPath(body.out);
  const flat = body.flat === true;
  const quality = MERGE_QUALITIES.includes(body.quality as MergeQuality) ? (body.quality as MergeQuality) : "copy";
  if (!(await fs.stat(source).catch(() => null))?.isDirectory()) return jsonError(`Хавтас олдсонгүй: ${source}`, 404);

  // Re-plan on the server: the client only says which groups and what to call them.
  const plan = await planMerge(source, out, flat, quality);
  const groups = new Map(plan.groups.map((g) => [g.key, g]));
  const jobs: Job[] = [];
  const dests = new Set<string>();
  for (const raw of body.items as Partial<MergeItem>[]) {
    const group = typeof raw?.key === "string" ? groups.get(raw.key) : undefined;
    if (!group) return jsonError("Файлын жагсаалт өөрчлөгдсөн байна. Дахин шалгана уу.", 409);
    if (group.problem) return jsonError(`${group.base}: ${group.problem}`);
    if (group.mixed && quality === "copy") return jsonError(`${group.base}: ${MIXED_PROBLEM}`);
    const name = cleanOutputName(typeof raw.name === "string" ? raw.name : "") || group.base;
    const dest = path.join(out, outputRelPath(group, name, flat, quality));
    if (dests.has(dest)) return jsonError(`Хоёр файл ижил нэрээр бичигдэх гэж байна: ${path.relative(out, dest)}`);
    dests.add(dest);
    const files = plan.files.get(group.key)!;
    const probes = await Promise.all(files.map((f) => probeForJoin(f)));
    jobs.push({ group, files, dest, audio: probes.map((p) => p.hasAudio), fps: fpsExpr(probes[0].fps) });
  }

  // A GPU encoder that fails to start falls back to the CPU, as in the editor's export.
  let encoders: Exclude<Encoder, "auto">[] = [];
  if (quality !== "copy") {
    if (!(await availableEncoders()).cpu) return jsonError("Энэ ffmpeg-д libx264 encoder алга.");
    const primary = await resolveEncoder("auto");
    encoders = primary === "cpu" ? ["cpu"] : [primary, "cpu"];
  }
  jobs.sort((a, b) => a.dest.localeCompare(b.dest, undefined, { numeric: true }));
  const totalDuration = jobs.reduce((s, j) => s + j.group.duration, 0);

  await sweepOldData();
  const workDir = path.join(JOBS_DIR, randomUUID());
  await fs.mkdir(workDir, { recursive: true });

  const textEncoder = new TextEncoder();
  let current: FfmpegRun | null = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    current?.kill();
  };
  request.signal.addEventListener("abort", cancel);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: MergeEvent) => {
        if (cancelled) return;
        try {
          controller.enqueue(textEncoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // client went away
        }
      };

      const startedAt = Date.now();
      let made = 0;
      let skipped = 0;
      let failed = 0;
      let doneDuration = 0;
      send({ type: "start", total: jobs.length, totalDuration, encoder: encoders.length ? ENCODER_LABEL[encoders[0]] : null });

      for (const [i, job] of jobs.entries()) {
        if (cancelled) break;
        const { key, duration } = job.group;
        const rel = path.relative(out, job.dest);
        if (await exists(job.dest)) {
          skipped++;
          send({ type: "item", key, state: "skipped", message: `Аль хэдийн бий: ${rel}` });
          doneDuration += duration;
          continue;
        }
        send({ type: "item", key, state: "running" });

        // Written under a temp name next to the destination so a cancelled run never leaves a half file.
        const tmp = `${job.dest}.partial${path.extname(job.dest)}`;
        try {
          await fs.mkdir(path.dirname(job.dest), { recursive: true });
          const onProgress = (p: { outTime: number }) => {
            const t = Math.min(p.outTime, duration);
            send({
              type: "progress",
              key,
              percent: duration ? (t / duration) * 100 : 0,
              overall: totalDuration ? ((doneDuration + t) / totalDuration) * 100 : 0,
            });
          };
          let result: { code: number | null; log: string };
          if (quality === "copy") {
            const list = path.join(workDir, `${i}.txt`);
            await fs.writeFile(list, job.files.map((f) => `file '${f.replace(/'/g, "'\\''")}'\n`).join(""));
            current = runFfmpeg(copyArgs(job, list, tmp), workDir, onProgress);
            result = await current.done;
          } else {
            const first = await probeMedia(job.files[0]);
            if (!first.width || !first.height) throw new Error("Видеоны хэмжээг уншиж чадсангүй");
            const size = frameSize(first.width, first.height, Number(quality));
            result = { code: null, log: "" };
            for (const encoder of encoders) {
              let maxOutTime = 0;
              current = runFfmpeg(encodeArgs(job, size, encoder, tmp), workDir, (p) => {
                maxOutTime = Math.max(maxOutTime, p.outTime);
                onProgress(p);
              });
              result = await current.done;
              // Only retry on the CPU when the GPU encoder failed to start, not mid-encode on bad input.
              if (result.code === 0 || cancelled || maxOutTime > 1) break;
            }
          }
          if (cancelled) throw new Error("cancelled");
          if (result.code !== 0) throw new Error(result.log.split("\n").slice(-3).join("\n") || "ffmpeg алдаа");
          const got = (await probeMedia(tmp)).duration ?? 0;
          if (duration && Math.abs(got - duration) > 2) throw new Error(`Урт таарсангүй (${Math.round(got)}с ≠ ${Math.round(duration)}с)`);
          await fs.rename(tmp, job.dest);
          made++;
          send({ type: "item", key, state: "done", path: job.dest });
        } catch (err) {
          await fs.rm(tmp, { force: true });
          if (cancelled) break;
          failed++;
          send({ type: "item", key, state: "failed", message: err instanceof Error ? err.message : String(err) });
        }
        doneDuration += duration;
      }

      await fs.rm(workDir, { recursive: true, force: true });
      send({ type: "done", made, skipped, failed, elapsedMs: Date.now() - startedAt });
      try {
        controller.close();
      } catch {}
    },
    cancel,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
