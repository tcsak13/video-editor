import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { JOBS_DIR, contentDisposition, isId, jsonError, rejectNonLocal, statFile } from "@/lib/server/storage";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
};

// GET /api/download?job=<id> — streams a finished job's output file.
export async function GET(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const jobId = new URL(request.url).searchParams.get("job");
  if (!isId(jobId)) return jsonError("Буруу ажлын дугаар.");

  let job: { outputPath: string; outputName: string };
  try {
    job = JSON.parse(await fs.readFile(path.join(JOBS_DIR, jobId, "job.json"), "utf8"));
  } catch {
    return jsonError("Ажил олдсонгүй (хугацаа нь дууссан байж магадгүй).", 404);
  }

  const stat = await statFile(job.outputPath);
  if (!stat) return jsonError("Гаралтын файл олдсонгүй.", 404);

  const body = Readable.toWeb(createReadStream(job.outputPath)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "Content-Type": MIME[path.extname(job.outputPath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(stat.size),
      "Content-Disposition": contentDisposition(job.outputName),
      "Cache-Control": "no-store",
    },
  });
}
