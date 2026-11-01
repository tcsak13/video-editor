import fs from "node:fs/promises";
import type { Encoder, ProcessEvent } from "@/lib/editor-options";
import { runFfmpeg, type FfmpegRun } from "@/lib/server/ffmpeg";
import { statFile } from "@/lib/server/storage";

type EncodeJob = {
  request: Request;
  /** Encoders to try in order; a GPU encoder that fails to start falls through to the next one. */
  encoderOrder: Exclude<Encoder, "auto">[];
  buildArgs: (encoder: Encoder) => string[];
  cwd: string;
  jobId: string;
  outputPath: string;
  outputName: string;
  /** Set when the output was written somewhere the user chose (shown instead of auto-downloading). */
  visibleOutputPath: string | null;
  originalSize: number;
  expectedDuration: number | null;
  cleanup?: () => Promise<void>;
};

/**
 * Runs an ffmpeg encode and streams newline-delimited ProcessEvents. Aborting the request
 * kills ffmpeg and removes the partial output file.
 */
export function streamEncodeJob(job: EncodeJob): Response {
  const textEncoder = new TextEncoder();
  let current: FfmpegRun | null = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    current?.kill();
  };
  job.request.signal.addEventListener("abort", cancel);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ProcessEvent) => {
        if (cancelled) return;
        try {
          controller.enqueue(textEncoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // client went away
        }
      };

      const { encoderOrder, expectedDuration, outputPath } = job;
      const startedAt = Date.now();
      let result = { code: null as number | null, log: "" };
      let usedEncoder: Encoder = encoderOrder[0];

      for (let i = 0; i < encoderOrder.length && !cancelled; i++) {
        usedEncoder = encoderOrder[i];
        if (i > 0) {
          send({ type: "fallback", from: encoderOrder[0], to: usedEncoder, reason: result.log.split("\n").slice(-3).join("\n") });
        }
        send({ type: "start", expectedDuration, encoder: usedEncoder, outputName: job.outputName });

        let maxOutTime = 0;
        current = runFfmpeg(job.buildArgs(usedEncoder), job.cwd, (p) => {
          maxOutTime = Math.max(maxOutTime, p.outTime);
          const percent = expectedDuration ? Math.min(99.9, (p.outTime / expectedDuration) * 100) : null;
          send({ type: "progress", percent, outTime: p.outTime, speed: p.speed, fps: p.fps });
        });
        result = await current.done;

        if (result.code === 0 || cancelled) break;
        await fs.rm(outputPath, { force: true });
        // Only fall back to CPU when the GPU encoder failed to start, not mid-encode on bad input.
        if (maxOutTime > 1) break;
      }

      await job.cleanup?.();

      if (cancelled) {
        await fs.rm(outputPath, { force: true });
        try {
          controller.close();
        } catch {}
        return;
      }

      if (result.code !== 0) {
        await fs.rm(outputPath, { force: true });
        send({ type: "error", message: "ffmpeg боловсруулалт амжилтгүй боллоо.", log: result.log });
      } else {
        const outStat = await statFile(outputPath);
        send({
          type: "done",
          jobId: job.jobId,
          outputName: job.outputName,
          outputPath: job.visibleOutputPath,
          originalSize: job.originalSize,
          newSize: outStat?.size ?? 0,
          elapsedMs: Date.now() - startedAt,
          encoder: usedEncoder,
        });
      }
      controller.close();
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

/** Font for drawtext that covers Cyrillic incl. Ө/Ү. */
const FONT_CANDIDATES = [
  process.env.WATERMARK_FONT,
  // macOS
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Verdana.ttf",
  // Windows
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
  // Linux
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
].filter((p): p is string => !!p);

export async function findFont(): Promise<string | null> {
  for (const candidate of FONT_CANDIDATES) {
    if (await statFile(candidate)) return candidate;
  }
  return null;
}
