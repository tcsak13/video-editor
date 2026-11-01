import path from "node:path";
import type { SourceInfo } from "@/lib/editor-options";
import { probeMedia } from "@/lib/server/ffmpeg";
import { jsonError, normalizeLocalPath, rejectNonLocal, statFile } from "@/lib/server/storage";

// POST /api/probe { path } — validates a local file path and reads its stream info.
export async function POST(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
  if (typeof body?.path !== "string" || !body.path.trim()) return jsonError("Файлын зам оруулна уу.");

  const filePath = normalizeLocalPath(body.path);
  const stat = await statFile(filePath);
  if (!stat) return jsonError(`Файл олдсонгүй: ${filePath}`, 404);

  try {
    const media = await probeMedia(filePath);
    const info: SourceInfo = { name: path.basename(filePath), size: stat.size, media };
    return Response.json({ path: filePath, info });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Файлыг уншиж чадсангүй.", 422);
  }
}
