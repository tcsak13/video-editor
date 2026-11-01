import fs from "node:fs/promises";
import path from "node:path";
import type { FontEntry } from "@/lib/fonts";

export const FONTS_DIR = process.env.LVE_FONTS_DIR || path.join(process.cwd(), "fonts", "google");

let cache: { mtime: number; fonts: FontEntry[] } | null = null;

/** fonts.json written by scripts/fetch-fonts.mjs, or [] when fonts haven't been downloaded. */
export async function fontCatalog(): Promise<FontEntry[]> {
  const file = path.join(FONTS_DIR, "fonts.json");
  try {
    const { mtimeMs } = await fs.stat(file);
    if (cache?.mtime !== mtimeMs) cache = { mtime: mtimeMs, fonts: JSON.parse(await fs.readFile(file, "utf8")) };
    return cache.fonts;
  } catch {
    return [];
  }
}

/** Absolute TTF path for a family (bold when the family has a bold file), or null if unknown. */
export async function fontFile(family: string, bold: boolean): Promise<string | null> {
  const entry = (await fontCatalog()).find((f) => f.family === family);
  if (!entry) return null;
  return path.join(FONTS_DIR, (bold && entry.files["700"]) || entry.files["400"]);
}
