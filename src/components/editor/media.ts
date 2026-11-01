import type { MediaInfo, SourceInfo, SourceRef } from "@/lib/editor-options";

export type ProxyState = { state: "none" | "building" | "ready" | "failed"; progress: number; url?: string };

export type MediaItem = {
  id: string;
  name: string;
  size: number;
  kind: "video" | "audio";
  source: SourceRef | null; // null until the upload finishes
  info: MediaInfo | null;
  /** What <video>/<audio> elements play: blob while uploading, then server preview or proxy. */
  url: string | null;
  uploadProgress: number | null;
  proxy: ProxyState;
  /** Browser couldn't decode the original; build a proxy as soon as the source is on the server. */
  needsProxy: boolean;
  error: string | null;
  /** Template slot: the layout remembers this video's size, the file itself still has to be chosen. */
  placeholder?: boolean;
};

export function isImage(m: MediaItem | undefined): boolean {
  return !!m?.info?.isImage;
}

/** Default length of a new clip: the whole file, or 5 s for a picture. */
export function mediaDuration(m: MediaItem): number {
  return m.info?.isImage ? 5 : (m.info?.duration ?? 5);
}

export function sourceUrl(source: SourceRef): string {
  return source.kind === "upload"
    ? `/api/preview?upload=${encodeURIComponent(source.id)}`
    : `/api/preview?path=${encodeURIComponent(source.path)}`;
}

export function playableUrl(m: MediaItem): string | null {
  if (m.proxy.state === "ready" && m.proxy.url) return m.proxy.url;
  return m.url;
}

export function filmstripFrames(duration: number): number {
  return Math.min(60, Math.max(8, Math.round(duration / 3)));
}

export function thumbsUrl(m: MediaItem, type: "film" | "wave"): string | null {
  if (!m.source || !m.info || m.info.isImage) return null;
  const n = filmstripFrames(m.info.duration ?? 10);
  return `/api/thumbs?type=${type}&n=${n}&src=${encodeURIComponent(JSON.stringify(m.source))}`;
}

export function mediaFromInfo(id: string, source: SourceRef, info: SourceInfo): MediaItem {
  return {
    id,
    name: info.name,
    size: info.size,
    kind: info.media.hasVideo ? "video" : "audio",
    source,
    info: info.media,
    url: sourceUrl(source),
    uploadProgress: null,
    proxy: { state: "none", progress: 0 },
    needsProxy: false,
    error: null,
  };
}

/** Streams the file to the server (no browser buffering) and reports progress. */
export function uploadFile(
  file: File,
  onProgress: (fraction: number) => void,
): { promise: Promise<{ id: string; info: SourceInfo }>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ id: string; info: SourceInfo }>((resolve, reject) => {
    xhr.open("PUT", `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 400) reject(new Error(data.error ?? "Байршуулалт амжилтгүй."));
        else resolve(data);
      } catch {
        reject(new Error("Байршуулалт амжилтгүй."));
      }
    };
    xhr.onerror = () => reject(new Error("Сервертэй холбогдож чадсангүй."));
    xhr.onabort = () => reject(new Error("Цуцлагдлаа."));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

export async function probePath(rawPath: string): Promise<{ path: string; info: SourceInfo }> {
  const res = await fetch("/api/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: rawPath }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Файлыг нээж чадсангүй.");
  return data;
}

/** Reads a newline-delimited JSON response body, calling onEvent for every line. */
export async function readNdjson<T>(res: Response, onEvent: (e: T) => void) {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as T);
    }
  }
}

export async function buildProxy(source: SourceRef, onProgress: (percent: number) => void): Promise<string> {
  const res = await fetch("/api/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Proxy үүсгэж чадсангүй.");
  let url: string | null = null;
  let error: string | null = null;
  await readNdjson<{ type: string; percent?: number; url?: string; message?: string }>(res, (e) => {
    if (e.type === "progress" && e.percent !== undefined) onProgress(e.percent);
    if (e.type === "done" && e.url) url = e.url;
    if (e.type === "error") error = e.message ?? "Proxy үүсгэж чадсангүй.";
  });
  if (!url) throw new Error(error ?? "Proxy үүсгэж чадсангүй.");
  return url;
}
