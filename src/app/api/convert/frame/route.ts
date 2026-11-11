import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { VIDEO_RE } from "@/lib/convert";
import { FFMPEG_PATH, probeMedia } from "@/lib/server/ffmpeg";
import { jsonError, normalizeLocalPath, rejectNonLocal } from "@/lib/server/storage";

// GET /api/convert/frame?path=FILE&at=0.3 — one JPEG frame at that fraction of the film, at its
// display shape (square pixels), for checking a stretched picture before converting it.
export async function GET(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const raw = params.get("path");
  if (!raw || !VIDEO_RE.test(raw)) return jsonError("Видео файл сонгоно уу.");
  const file = normalizeLocalPath(raw);
  if (!(await fs.stat(file).catch(() => null))?.isFile()) return jsonError(`Файл олдсонгүй: ${file}`, 404);
  const at = Math.min(0.98, Math.max(0, Number(params.get("at")) || 0));

  const { duration } = await probeMedia(file).catch(() => ({ duration: null }));
  const { code, stdout } = await runCaptureBinary([
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-ss", ((duration ?? 0) * at).toFixed(3), "-i", file,
    "-map", "0:V:0", "-frames:v", "1",
    "-vf", "scale='trunc(ih*dar/2)*2':ih,setsar=1,scale=-2:540",
    "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "pipe:1",
  ]);
  if (code !== 0 || !stdout.length) return jsonError("Кадр гаргаж чадсангүй.", 500);
  return new Response(new Uint8Array(stdout), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } });
}

/** runCapture decodes stdout as text; a JPEG needs the raw bytes. */
function runCaptureBinary(args: string[]): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.resume();
    child.on("error", () => resolve({ code: -1, stdout: Buffer.alloc(0) }));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks) }));
  });
}
