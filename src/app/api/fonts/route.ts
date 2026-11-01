import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { FONT_FILE_RE } from "@/lib/fonts";
import { FONTS_DIR, fontCatalog } from "@/lib/server/fonts";
import { jsonError, rejectNonLocal, statFile } from "@/lib/server/storage";

// GET /api/fonts → { fonts: FontEntry[] }   ·   GET /api/fonts?f=<file>.ttf → the font file
export async function GET(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const file = new URL(request.url).searchParams.get("f");
  if (!file) return Response.json({ fonts: await fontCatalog() });
  if (!FONT_FILE_RE.test(file)) return jsonError("Буруу фонт.", 400);

  const full = path.join(FONTS_DIR, file);
  const stat = await statFile(full);
  if (!stat) return jsonError("Фонт олдсонгүй.", 404);
  return new Response(Readable.toWeb(createReadStream(full)) as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "font/ttf",
      "Content-Length": String(stat.size),
      // File names never change content (re-downloads overwrite with the same font).
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
