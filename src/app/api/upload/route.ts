import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { SourceInfo } from "@/lib/editor-options";
import { probeMedia } from "@/lib/server/ffmpeg";
import { UPLOADS_DIR, jsonError, rejectNonLocal, safeBaseName, sweepOldData } from "@/lib/server/storage";

// PUT /api/upload?name=<file name> with the raw file as the body.
// The body is piped straight to disk, so multi-GB files never sit in memory.
export async function PUT(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;
  if (!request.body) return jsonError("Файл хоосон байна.");

  const name = new URL(request.url).searchParams.get("name") || "video.mp4";
  const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);

  await sweepOldData();
  const id = randomUUID();
  const dir = path.join(UPLOADS_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, safeBaseName(name) + ext);

  try {
    await pipeline(Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>), createWriteStream(filePath));
  } catch {
    await fs.rm(dir, { recursive: true, force: true });
    return jsonError("Байршуулалт тасарсан.", 400);
  }

  try {
    const [stat, media] = await Promise.all([fs.stat(filePath), probeMedia(filePath)]);
    const info: SourceInfo = { name, size: stat.size, media };
    return Response.json({ id, info });
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    return jsonError(err instanceof Error ? err.message : "Файлыг уншиж чадсангүй.", 422);
  }
}
