import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "@/lib/editor-options";
import {
  PROXIES_DIR,
  jsonError,
  normalizeLocalPath,
  rejectNonLocal,
  statFile,
  uploadedFilePath,
} from "@/lib/server/storage";

const PLAYABLE_EXTENSIONS: readonly string[] = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS];

const MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/mp4", // most .mov files are H.264/HEVC that Chromium plays when labelled mp4
  webm: "video/webm",
  mkv: "video/webm", // Chromium plays H.264/VP9 Matroska under the webm type
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  bmp: "image/bmp",
};

/** ?path=<local path> | ?upload=<upload id> | ?proxy=<cache key>.mp4|.m4a */
async function resolvePreviewFile(params: URLSearchParams): Promise<string | Response> {
  const upload = params.get("upload");
  if (upload) return (await uploadedFilePath(upload)) ?? jsonError("Файл олдсонгүй.", 404);

  const proxy = params.get("proxy");
  if (proxy) {
    if (!/^[0-9a-f]{40}\.(mp4|m4a)$/.test(proxy)) return jsonError("Буруу proxy.", 400);
    return path.join(PROXIES_DIR, proxy);
  }

  const raw = params.get("path");
  if (!raw) return jsonError("Зам алга.");
  const filePath = normalizeLocalPath(raw);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!PLAYABLE_EXTENSIONS.includes(ext)) return jsonError("Видео/аудио/зураг файл биш.", 415);
  return filePath;
}

// GET /api/preview — Range-enabled streaming so <video>/<audio> elements can seek inside
// multi-GB local files without the browser ever loading them.
export async function GET(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const filePath = await resolvePreviewFile(new URL(request.url).searchParams);
  if (filePath instanceof Response) return filePath;
  const ext = path.extname(filePath).slice(1).toLowerCase();

  const stat = await statFile(filePath);
  if (!stat) return jsonError("Файл олдсонгүй.", 404);

  const type = MIME[ext] ?? "application/octet-stream";
  const size = stat.size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");

  if (!range) {
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" },
    });
  }

  let start: number;
  let end: number;
  if (range[1] === "") {
    // suffix range: last N bytes
    start = Math.max(0, size - Number(range[2]));
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
  }
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }

  const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    },
  });
}
