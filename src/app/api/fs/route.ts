import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VIDEO_RE } from "@/lib/convert";
import { JOINABLE_RE, cleanOutputName, type FsEntry, type FsListing } from "@/lib/merge";
import { jsonError, normalizeLocalPath, rejectNonLocal } from "@/lib/server/storage";

const HIDDEN = new Set(["$RECYCLE.BIN", "System Volume Information", "node_modules"]);

async function isDir(p: string) {
  return (await fs.stat(p).catch(() => null))?.isDirectory() ?? false;
}

/** Drives and the usual home folders, for the folder picker's sidebar. */
async function roots(): Promise<FsEntry[]> {
  const home = os.homedir();
  const out: FsEntry[] = [];
  if (process.platform === "win32") {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const p = `${letter}:\\`;
      if (await isDir(p)) out.push({ name: `${letter}:`, path: p });
    }
  } else {
    const mounts = process.platform === "darwin" ? ["/Volumes"] : ["/media", path.join("/media", os.userInfo().username), "/mnt"];
    for (const dir of mounts) {
      const names = await fs.readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        const p = path.join(dir, name);
        // "Macintosh HD" in /Volumes is a link back to "/".
        if (!name.startsWith(".") && (await isDir(p)) && (await fs.realpath(p).catch(() => p)) !== "/") out.push({ name, path: p });
      }
    }
  }
  for (const [name, p] of [
    ["Нүүр", home],
    ["Desktop", path.join(home, "Desktop")],
    ["Downloads", path.join(home, "Downloads")],
    ["Movies", path.join(home, process.platform === "win32" ? "Videos" : "Movies")],
  ]) {
    if (await isDir(p)) out.push({ name, path: p });
  }
  return out;
}

// GET /api/fs → { roots }   ·   GET /api/fs?path=DIR → FsListing (sub-folders + how many videos; &files=1 lists the videos)
export async function GET(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const raw = params.get("path");
  if (!raw) return Response.json({ roots: await roots() });

  const dir = normalizeLocalPath(raw);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return jsonError(`Хавтсыг нээж чадсангүй: ${dir}`, 404);
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !HIDDEN.has(e.name))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parent = path.dirname(dir);
  const listing: FsListing = {
    path: dir,
    parent: parent === dir ? null : parent,
    dirs,
    videos: entries.filter((e) => e.isFile() && !e.name.startsWith(".") && JOINABLE_RE.test(e.name)).length,
  };
  if (params.get("files") === "1") {
    const videos = entries.filter((e) => e.isFile() && !e.name.startsWith(".") && VIDEO_RE.test(e.name) && !e.name.includes(".partial."));
    listing.files = (
      await Promise.all(
        videos.map(async (e) => {
          const p = path.join(dir, e.name);
          const st = await fs.stat(p).catch(() => null);
          return st ? { name: e.name, path: p, size: st.size } : null;
        }),
      )
    )
      .filter((f) => f !== null)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  return Response.json(listing);
}

// POST /api/fs { path, name } — creates a sub-folder (e.g. "final") and returns its path.
export async function POST(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { path?: unknown; name?: unknown } | null;
  const name = typeof body?.name === "string" ? cleanOutputName(body.name) : "";
  if (typeof body?.path !== "string" || !name) return jsonError("Хавтасны нэр оруулна уу.");
  const parent = normalizeLocalPath(body.path);
  if (!(await isDir(parent))) return jsonError(`Хавтас олдсонгүй: ${parent}`, 404);
  const created = path.join(parent, name);
  try {
    await fs.mkdir(created);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return jsonError("Хавтас үүсгэж чадсангүй.", 500);
  }
  return Response.json({ path: created });
}
