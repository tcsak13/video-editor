#!/usr/bin/env node
// Downloads every free Google Font that can write Mongolian Cyrillic (needs Ө ө Ү ү) into
// fonts/google/ as TTF (regular + bold when the family has it) and writes fonts.json.
// Run once while online: `npm run fonts`. Afterwards the editor uses them fully offline,
// both in the preview and in ffmpeg exports. Re-running only fetches what's missing.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.LVE_FONTS_DIR || path.join(ROOT, "fonts", "google");
const MONGOLIAN = [0x0410, 0x0430, 0x04e8, 0x04e9, 0x04ae, 0x04af]; // А а Ө ө Ү ү
const CJK = new Set(["Hans", "Hant", "Jpan", "Kore"]); // multi-MB CJK families that merely include Cyrillic
const CONCURRENCY = 6;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function get(url, as = "text") {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === "text" ? await res.text() : Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
}

/** Does the font's cmap map every code point? (format 4 and 12 subtables) */
function hasGlyphs(buf, codePoints) {
  const u16 = (o) => buf.readUInt16BE(o);
  const u32 = (o) => buf.readUInt32BE(o);
  const numTables = u16(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString("latin1", rec, rec + 4) === "cmap") cmap = u32(rec + 8);
  }
  if (cmap < 0) return false;
  const found = new Set();
  const n = u16(cmap + 2);
  for (let i = 0; i < n; i++) {
    const platform = u16(cmap + 4 + i * 8);
    const sub = cmap + u32(cmap + 4 + i * 8 + 4);
    if (platform !== 0 && platform !== 3) continue;
    const format = u16(sub);
    if (format === 4) {
      const segX2 = u16(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const offsets = deltas + segX2;
      for (const cp of codePoints) {
        for (let s = 0; s < segX2 / 2; s++) {
          const end = u16(ends + s * 2);
          if (cp > end) continue;
          const start = u16(starts + s * 2);
          if (cp < start) break;
          const ro = u16(offsets + s * 2);
          let glyph;
          if (ro === 0) glyph = (cp + u16(deltas + s * 2)) & 0xffff;
          else {
            glyph = u16(offsets + s * 2 + ro + (cp - start) * 2);
            if (glyph) glyph = (glyph + u16(deltas + s * 2)) & 0xffff;
          }
          if (glyph) found.add(cp);
          break;
        }
      }
    } else if (format === 12) {
      const groups = u32(sub + 12);
      for (let g = 0; g < groups; g++) {
        const o = sub + 16 + g * 12;
        const a = u32(o);
        const b = u32(o + 4);
        for (const cp of codePoints) if (cp >= a && cp <= b && u32(o + 8) + (cp - a)) found.add(cp);
      }
    }
  }
  return codePoints.every((cp) => found.has(cp));
}

async function exists(p) {
  try {
    return (await fs.stat(p)).size > 0;
  } catch {
    return false;
  }
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  console.log("Google Fonts каталог татаж байна…");
  const raw = await get("https://fonts.google.com/metadata/fonts");
  const catalog = JSON.parse(raw.slice(raw.indexOf("{")));
  const families = catalog.familyMetadataList
    .filter((f) => f.subsets?.includes("cyrillic") && !CJK.has(f.primaryScript))
    .sort((a, b) => (a.popularity ?? 9999) - (b.popularity ?? 9999));
  console.log(`${families.length} кирилл фонт. Монгол үсэг (Ө, Ү)-тэйг нь шалгаж татна → ${OUT}`);

  const entries = [];
  let done = 0;
  let skipped = 0;
  const queue = [...families];
  const worker = async () => {
    for (let fam; (fam = queue.shift()); ) {
      try {
        const upright = Object.keys(fam.fonts).filter((k) => /^\d+$/.test(k)).map(Number);
        if (!upright.length) throw new Error("no upright style");
        const regular = upright.includes(400) ? 400 : upright.sort((a, b) => Math.abs(a - 400) - Math.abs(b - 400))[0];
        const weights = [regular, ...(upright.includes(700) && regular !== 700 ? [700] : [])];
        // Without `subset` the API serves a Latin-only cut; ask for the Cyrillic glyphs explicitly.
        const css = await get(
          `https://fonts.googleapis.com/css?family=${encodeURIComponent(`${fam.family}:${weights.join(",")}`)}` +
            "&subset=cyrillic,cyrillic-ext,latin,latin-ext",
        );
        const files = {};
        for (const block of css.split("@font-face").slice(1)) {
          const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1]);
          const url = /url\((https:[^)]+\.ttf)\)/.exec(block)?.[1];
          if (!url || !weights.includes(weight) || files[weight === regular ? "400" : "700"]) continue;
          const role = weight === regular ? "400" : "700";
          const name = `${slug(fam.family)}-${role}.ttf`;
          const dest = path.join(OUT, name);
          const buf = (await exists(dest)) ? await fs.readFile(dest) : await get(url, "buffer");
          if (!hasGlyphs(buf, MONGOLIAN)) {
            await fs.rm(dest, { force: true });
            if (role === "400") throw new Error("Ө/Ү үсэг алга");
            continue;
          }
          await fs.writeFile(dest, buf);
          files[role] = name;
        }
        if (!files["400"]) throw new Error("TTF олдсонгүй");
        entries.push({ family: fam.family, category: fam.category, popularity: fam.popularity ?? 9999, files });
      } catch (err) {
        skipped++;
        if (!/Ө\/Ү/.test(err.message)) console.warn(`  ! ${fam.family}: ${err.message}`);
      }
      done++;
      if (done % 20 === 0 || done === families.length) process.stdout.write(`  ${done}/${families.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  entries.sort((a, b) => a.popularity - b.popularity);
  const manifest = entries.map(({ family, category, files }) => ({ family, category, files }));
  await fs.writeFile(path.join(OUT, "fonts.json"), JSON.stringify(manifest, null, 0));
  const keep = new Set(["fonts.json", ...manifest.flatMap((e) => Object.values(e.files))]);
  for (const f of await fs.readdir(OUT)) if (!keep.has(f)) await fs.rm(path.join(OUT, f), { force: true });
  let bytes = 0;
  for (const f of keep) bytes += (await fs.stat(path.join(OUT, f))).size;
  console.log(`Бэлэн: ${manifest.length} фонт (${(bytes / 1e6).toFixed(0)} MB), ${skipped} нь Монгол үсэггүй тул алгассан.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
