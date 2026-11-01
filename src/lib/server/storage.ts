import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_ROOT = path.join(os.tmpdir(), "local-video-editor");
export const UPLOADS_DIR = path.join(DATA_ROOT, "uploads");
export const JOBS_DIR = path.join(DATA_ROOT, "jobs");
export const THUMBS_DIR = path.join(DATA_ROOT, "thumbs");
export const PROXIES_DIR = path.join(DATA_ROOT, "proxies");
/** Templates are kept for good (not in the swept temp dir): their logos/music are copied here. */
export const TEMPLATES_DIR = process.env.LVE_TEMPLATES_DIR || path.join(os.homedir(), ".local-video-editor", "templates");

const HOUR = 60 * 60 * 1000;
// Uploads outlive a browser session because timeline projects are restored from localStorage.
const MAX_AGE_MS: [string, number][] = [
  [UPLOADS_DIR, 48 * HOUR],
  [JOBS_DIR, 12 * HOUR],
  [THUMBS_DIR, 7 * 24 * HOUR],
  [PROXIES_DIR, 7 * 24 * HOUR],
];
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function isLocalHostname(urlLike: string) {
  try {
    return LOCAL_HOSTS.has(new URL(urlLike).hostname);
  } catch {
    return false;
  }
}

/**
 * These routes read and write arbitrary local paths, so only serve requests that come from
 * this machine: Host must be loopback (blocks DNS rebinding) and any Origin must be loopback
 * (blocks cross-site form/fetch posts). Set ALLOW_LAN=1 to opt out.
 */
export function rejectNonLocal(request: Request): Response | null {
  if (process.env.ALLOW_LAN === "1") return null;
  const host = request.headers.get("host") ?? "";
  if (!isLocalHostname(`http://${host}`)) {
    return jsonError("Зөвхөн localhost-оос хандах боломжтой.", 403);
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== "null" && !isLocalHostname(origin)) {
    return jsonError("Гадны сайтаас ирсэн хүсэлтийг хүлээн авахгүй.", 403);
  }
  return null;
}

/** Accepts what users paste: quoted Windows "Copy as path", file:// URLs, ~/ paths. */
export function normalizeLocalPath(raw: string): string {
  let p = raw.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  if (p.startsWith("file://")) p = fileURLToPath(p);
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

export async function statFile(p: string) {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** Strips characters that are invalid in file names on Windows/macOS/Linux. */
export function safeBaseName(name: string): string {
  const base = path.parse(name).name;
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  return cleaned.slice(0, 120) || "video";
}

/** Returns dir/base.ext, or dir/base (2).ext etc. if that already exists. */
export async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, i === 1 ? `${base}.${ext}` : `${base} (${i}).${ext}`);
    if (!(await statFile(candidate))) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}.${ext}`);
}

export function contentDisposition(fileName: string) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function uploadedFilePath(id: string): Promise<string | null> {
  if (!isId(id)) return null;
  const dir = path.join(UPLOADS_DIR, id);
  try {
    const entries = await fs.readdir(dir);
    const file = entries.find((e) => !e.startsWith("."));
    return file ? path.join(dir, file) : null;
  } catch {
    return null;
  }
}

/** Resolves a client SourceRef (uploaded id or local path) to an existing file on disk. */
export async function resolveSource(source: unknown): Promise<string | null> {
  const ref = source as { kind?: unknown; id?: unknown; path?: unknown } | null;
  let filePath: string | null = null;
  if (ref?.kind === "upload" && typeof ref.id === "string") filePath = await uploadedFilePath(ref.id);
  else if (ref?.kind === "path" && typeof ref.path === "string" && ref.path.trim()) filePath = normalizeLocalPath(ref.path);
  return filePath && (await statFile(filePath)) ? filePath : null;
}

/** Deletes old uploads/jobs/caches so the temp dir doesn't fill up with 10GB sources. */
export async function sweepOldData() {
  const now = Date.now();
  for (const [dir, maxAge] of MAX_AGE_MS) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry);
        try {
          const st = await fs.stat(full);
          if (now - st.mtimeMs > maxAge) await fs.rm(full, { recursive: true, force: true });
        } catch {
          // already gone
        }
      }),
    );
  }
}
