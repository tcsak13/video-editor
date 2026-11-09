import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Encoder } from "@/lib/editor-options";
import type { ConvertEvent, ConvertFile } from "@/lib/convert";
import { availableEncoders, legacyInputFlags, probeMedia, resolveEncoder, runFfmpeg, videoCodecArgs, type FfmpegRun } from "@/lib/server/ffmpeg";
import { planConvert, readConvertOptions, type ConvertProbe } from "@/lib/server/convert";
import { jsonError, rejectNonLocal } from "@/lib/server/storage";

type Job = { item: ConvertFile; file: string; dest: string; probe: ConvertProbe };

const ENCODER_LABEL: Record<Exclude<Encoder, "auto">, string> = { cpu: "CPU (libx264)", nvenc: "NVIDIA NVENC", videotoolbox: "Apple VideoToolbox" };

// Decoding is the bottleneck, so the media engine does best with three films at once (≈15× real
// time on Apple Silicon against ≈5× for one); libx264 already uses every core for one.
const PARALLEL: Record<Exclude<Encoder, "auto">, number> = { cpu: 1, nvenc: 2, videotoolbox: 3 };

/** Every audio track: copied when it's already AAC, otherwise AAC at a bitrate that keeps 5.1 clean. */
function audioArgs(probe: ConvertProbe): string[] {
  if (!probe.audioCodecs.length) return [];
  if (probe.audioCodecs.every((c) => c === "aac")) return ["-c:a", "copy"];
  return ["-c:a", "aac", "-b:a", probe.channels > 2 ? "384k" : "192k"];
}

const tail = ["-sn", "-dn", "-map_metadata", "0", "-max_muxing_queue_size", "4096", "-movflags", "+faststart"];

function copyArgs(job: Job, tmp: string): string[] {
  return [...legacyInputFlags(job.file), "-i", job.file, "-map", "0:v:0", "-map", "0:a?", "-c:v", "copy", ...audioArgs(job.probe), ...tail, "-y", tmp];
}

/**
 * CRF 20 / VideoToolbox q 65: the editor's "high" quality, visually the same as the source.
 * Bicubic downscaling looks the same as lanczos at these sizes and is a third faster.
 */
function encodeArgs(job: Job, encoder: Exclude<Encoder, "auto">, tmp: string): string[] {
  const [w, h] = job.item.outSize!;
  const same = job.item.width === w && job.item.height === h;
  return [
    ...(encoder === "videotoolbox" ? ["-hwaccel", "videotoolbox"] : []),
    ...legacyInputFlags(job.file),
    "-i", job.file,
    "-map", "0:v:0", "-map", "0:a?",
    "-vf", `${same ? "" : `scale=${w}:${h}:flags=bicubic,`}format=yuv420p`,
    ...videoCodecArgs(encoder, 20),
    ...audioArgs(job.probe),
    ...tail, "-y", tmp,
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

// POST /api/convert { sources, out, quality, copyFit, items: [key] } — converts the chosen films to
// MP4 under `out`, keeping folder and file names, and streams NDJSON ConvertEvents.
// Source files are only read, never written.
export async function POST(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { items?: unknown } | null;
  const options = await readConvertOptions(body);
  if (typeof options === "string") return jsonError(options);
  if (!Array.isArray(body?.items) || !body.items.length || body.items.length > 20000) return jsonError("Хөрвүүлэх файл сонгоогүй байна.");

  // Re-plan on the server: the client only says which files.
  const plan = await planConvert(options);
  const byKey = new Map(plan.files.map((f) => [f.key, f]));
  const jobs: Job[] = [];
  for (const key of new Set(body.items)) {
    const item = typeof key === "string" ? byKey.get(key) : undefined;
    const src = typeof key === "string" ? plan.sources.get(key) : undefined;
    if (!item) return jsonError("Файлын жагсаалт өөрчлөгдсөн байна. Дахин шалгана уу.", 409);
    if (item.problem || !src) return jsonError(`${item.source}: ${item.problem ?? "хөрвүүлэх боломжгүй"}`);
    jobs.push({ item, ...src });
  }

  // A GPU encoder that fails to start falls back to the CPU, as in the editor's export.
  if (!(await availableEncoders()).cpu) return jsonError("Энэ ffmpeg-д libx264 encoder алга.");
  const primary = await resolveEncoder("auto");
  const encoders: Exclude<Encoder, "auto">[] = primary === "cpu" ? ["cpu"] : [primary, "cpu"];
  const encoding = jobs.some((j) => j.item.action === "encode");
  const parallel = encoding ? PARALLEL[primary] : 2;
  const totalDuration = jobs.reduce((s, j) => s + (j.item.duration ?? 0), 0);

  const textEncoder = new TextEncoder();
  const running = new Set<FfmpegRun>();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    for (const run of running) run.kill();
  };
  request.signal.addEventListener("abort", cancel);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ConvertEvent) => {
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
      // Seconds already written by each film in progress, for the overall bar.
      const live = new Map<string, number>();
      const overall = () => (totalDuration ? ((doneDuration + [...live.values()].reduce((s, t) => s + t, 0)) / totalDuration) * 100 : 0);
      send({ type: "start", total: jobs.length, totalDuration, encoder: encoding ? ENCODER_LABEL[primary] : null, parallel });

      const run = (args: string[], onProgress: (p: { outTime: number; speed: number | null }) => void) => {
        const r = runFfmpeg(args, os.tmpdir(), onProgress);
        running.add(r);
        return r.done.finally(() => running.delete(r));
      };

      const convert = async (job: Job) => {
        const { key, duration } = job.item;
        const length = duration ?? 0;
        if (await exists(job.dest)) {
          skipped++;
          send({ type: "item", key, state: "skipped", message: `Аль хэдийн бий: ${key}` });
          doneDuration += length;
          return;
        }
        send({ type: "item", key, state: "running" });
        live.set(key, 0);

        // Written under a temp name next to the destination so a cancelled run never leaves a half file.
        const tmp = `${job.dest}.partial.mp4`;
        try {
          await fs.mkdir(path.dirname(job.dest), { recursive: true });
          let maxOutTime = 0;
          const onProgress = (p: { outTime: number; speed: number | null }) => {
            const t = Math.min(p.outTime, length || p.outTime);
            maxOutTime = Math.max(maxOutTime, p.outTime);
            live.set(key, t);
            send({ type: "progress", key, percent: length ? (t / length) * 100 : 0, overall: overall(), speed: p.speed });
          };
          let result = { code: null as number | null, log: "" };
          if (job.item.action === "copy") {
            result = await run(copyArgs(job, tmp), onProgress);
          } else {
            for (const encoder of encoders) {
              maxOutTime = 0;
              result = await run(encodeArgs(job, encoder, tmp), onProgress);
              // Only retry on the CPU when the GPU encoder failed to start, not mid-encode on bad input.
              if (result.code === 0 || cancelled || maxOutTime > 1) break;
            }
          }
          if (cancelled) throw new Error("cancelled");
          if (result.code !== 0) throw new Error(result.log.split("\n").slice(-3).join("\n") || "ffmpeg алдаа");
          const got = (await probeMedia(tmp)).duration ?? 0;
          if (length && Math.abs(got - length) > Math.max(3, length * 0.01)) throw new Error(`Урт таарсангүй (${Math.round(got)}с ≠ ${Math.round(length)}с)`);
          if (await exists(job.dest)) throw new Error(`Аль хэдийн бий: ${key}`);
          await fs.rename(tmp, job.dest);
          made++;
          send({ type: "item", key, state: "done", path: job.dest, size: (await fs.stat(job.dest)).size });
        } catch (err) {
          await fs.rm(tmp, { force: true });
          if (cancelled) return;
          failed++;
          send({ type: "item", key, state: "failed", message: err instanceof Error ? err.message : String(err) });
        } finally {
          live.delete(key);
          doneDuration += length;
        }
      };

      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
          while (!cancelled && next < jobs.length) await convert(jobs[next++]);
        }),
      );

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
