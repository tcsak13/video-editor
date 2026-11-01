import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { once, sourceCacheKey } from "@/lib/server/cache";
import { availableEncoders, probeMedia, runFfmpeg } from "@/lib/server/ffmpeg";
import { PROXIES_DIR, jsonError, rejectNonLocal, resolveSource, statFile } from "@/lib/server/storage";

type ProxyEvent =
  | { type: "progress"; percent: number }
  | { type: "done"; url: string }
  | { type: "error"; message: string };

type Listener = (e: ProxyEvent) => void;
const g = globalThis as unknown as { __lveProxyListeners?: Map<string, Set<Listener>> };
const listeners = (g.__lveProxyListeners ??= new Map<string, Set<Listener>>());

/** Light 360p H.264 copy with a keyframe every 0.5s so scrubbing in the browser is instant. */
async function buildProxy(filePath: string, outPath: string, key: string) {
  const media = await probeMedia(filePath);
  const emit = (e: ProxyEvent) => listeners.get(key)?.forEach((l) => l(e));
  const tmpOut = path.join(PROXIES_DIR, `${randomUUID()}${path.extname(outPath)}`);
  const args: string[] = ["-i", filePath];

  if (media.hasVideo) {
    const useVt = process.platform === "darwin" && (await availableEncoders()).videotoolbox;
    args.push("-map", "0:V:0", "-map", "0:a:0?", "-sn", "-dn");
    args.push("-vf", "scale=w=-2:h='trunc(min(360,ih)/2)*2',fps=30,format=yuv420p");
    args.push(...(useVt ? ["-c:v", "h264_videotoolbox", "-q:v", "45"] : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-tune", "fastdecode"]));
    args.push("-g", "15");
  } else {
    args.push("-map", "0:a:0", "-vn");
  }
  args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", "-y", tmpOut);

  const run = runFfmpeg(args, PROXIES_DIR, (p) => {
    if (media.duration) emit({ type: "progress", percent: Math.min(99, (p.outTime / media.duration) * 100) });
  });
  const result = await run.done;
  if (result.code !== 0) {
    await fs.rm(tmpOut, { force: true });
    throw new Error(result.log.split("\n").slice(-3).join("\n"));
  }
  await fs.rename(tmpOut, outPath);
}

// POST /api/proxy { source } — streams NDJSON progress, ends with { type: "done", url }.
export async function POST(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { source?: unknown } | null;
  const filePath = await resolveSource(body?.source);
  if (!filePath) return jsonError("Файл олдсонгүй.", 404);

  const media = await probeMedia(filePath).catch(() => null);
  if (!media) return jsonError("Файлыг уншиж чадсангүй.", 422);
  const key = await sourceCacheKey(filePath, "proxy-v1");
  const fileName = `${key}.${media.hasVideo ? "mp4" : "m4a"}`;
  const outPath = path.join(PROXIES_DIR, fileName);
  const url = `/api/preview?proxy=${fileName}`;
  await fs.mkdir(PROXIES_DIR, { recursive: true });

  const encoder = new TextEncoder();
  let listener: Listener | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ProxyEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {}
      };
      if (!(await statFile(outPath))) {
        listener = send;
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key)!.add(listener);
        try {
          await once(`proxy:${key}`, () => buildProxy(filePath, outPath, key));
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : "Proxy үүсгэж чадсангүй." });
          controller.close();
          return;
        } finally {
          listeners.get(key)?.delete(listener);
        }
      }
      send({ type: "done", url });
      controller.close();
    },
    cancel() {
      if (listener) listeners.get(key)?.delete(listener);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}
