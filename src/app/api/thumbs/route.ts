import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { once, sourceCacheKey } from "@/lib/server/cache";
import { probeMedia, runCapture } from "@/lib/server/ffmpeg";
import { THUMBS_DIR, jsonError, rejectNonLocal, resolveSource, statFile } from "@/lib/server/storage";

const FRAME_HEIGHT = 90; // displayed at ~40px, so this stays sharp on retina screens

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** n frames evenly spaced over the file, tiled horizontally into one JPEG. */
async function buildFilmstrip(filePath: string, n: number, outPath: string) {
  const media = await probeMedia(filePath);
  if (!media.hasVideo) throw new Error("no video");
  const duration = media.duration ?? 1;
  const tmp = `${outPath}.${randomUUID()}`;
  await fs.mkdir(tmp, { recursive: true });
  try {
    const indexes = Array.from({ length: n }, (_, i) => i);
    await mapLimit(indexes, 4, async (i) => {
      const t = Math.max(0, ((i + 0.5) * duration) / n);
      await runCapture([
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-ss", t.toFixed(3), "-i", filePath,
        "-map", "0:V:0", "-frames:v", "1",
        "-vf", `scale=-2:${FRAME_HEIGHT}`, "-q:v", "5",
        "-y", path.join(tmp, `f_${String(i).padStart(3, "0")}.jpg`),
      ]);
    });
    // Seeks past the last decodable frame fail; fill gaps with the nearest good frame so tiles stay aligned.
    const frames = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const f = path.join(tmp, `f_${String(i).padStart(3, "0")}.jpg`);
        return { f, ok: !!(await statFile(f)) };
      }),
    );
    const firstGood = frames.find((x) => x.ok);
    if (!firstGood) throw new Error("no frames");
    let prev = firstGood.f;
    for (const x of frames) {
      if (x.ok) prev = x.f;
      else await fs.copyFile(prev, x.f);
    }
    const { code, stderr } = await runCapture([
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-i", path.join(tmp, "f_%03d.jpg"),
      "-vf", `tile=${n}x1`, "-frames:v", "1", "-q:v", "4", "-y", outPath,
    ]);
    if (code !== 0) throw new Error(stderr);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function buildWaveform(filePath: string, outPath: string) {
  const { code, stderr } = await runCapture([
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-i", filePath,
    "-filter_complex", "[0:a:0]aformat=channel_layouts=mono,showwavespic=s=4000x120:colors=0xc4b5fd:scale=sqrt[w]",
    "-map", "[w]", "-frames:v", "1", "-y", outPath,
  ]);
  if (code !== 0) throw new Error(stderr);
}

// GET /api/thumbs?type=film|wave&n=<frames>&src=<JSON SourceRef>
export async function GET(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const type = params.get("type") === "wave" ? "wave" : "film";
  const n = Math.min(80, Math.max(2, Math.round(Number(params.get("n")) || 20)));
  let source: unknown;
  try {
    source = JSON.parse(params.get("src") ?? "");
  } catch {
    return jsonError("src буруу.");
  }
  const filePath = await resolveSource(source);
  if (!filePath) return jsonError("Файл олдсонгүй.", 404);

  const key = await sourceCacheKey(filePath, type === "film" ? `film-${n}` : "wave");
  const outPath = path.join(THUMBS_DIR, `${key}.${type === "film" ? "jpg" : "png"}`);

  if (!(await statFile(outPath))) {
    await fs.mkdir(THUMBS_DIR, { recursive: true });
    try {
      await once(outPath, async () => {
        const tmpOut = outPath.replace(/(\.\w+)$/, `.${randomUUID()}$1`);
        if (type === "film") await buildFilmstrip(filePath, n, tmpOut);
        else await buildWaveform(filePath, tmpOut);
        await fs.rename(tmpOut, outPath);
      });
    } catch {
      return jsonError("Зураг үүсгэж чадсангүй.", 422);
    }
  }

  return new Response(new Uint8Array(await fs.readFile(outPath)), {
    headers: {
      "Content-Type": type === "film" ? "image/jpeg" : "image/png",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
