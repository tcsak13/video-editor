import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { MediaInfo } from "@/lib/editor-options";
import { probeMedia } from "@/lib/server/ffmpeg";
import { MAX_MEDIA, num, sanitizeProject, str } from "@/lib/server/project";
import { TEMPLATES_DIR, isId, jsonError, rejectNonLocal, resolveSource, safeBaseName } from "@/lib/server/storage";
import type { Template, TemplateMedia } from "@/lib/template";

// Templates live in TEMPLATES_DIR/<id>/template.json, with the logos/music they use copied into
// TEMPLATES_DIR/<id>/assets so they keep working after uploads expire.

async function readTemplate(id: string): Promise<Template | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(TEMPLATES_DIR, id, "template.json"), "utf8")) as Template;
  } catch {
    return null;
  }
}

// GET /api/templates — every saved template, newest first.
export async function GET(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;
  let ids: string[] = [];
  try {
    ids = (await fs.readdir(TEMPLATES_DIR)).filter(isId);
  } catch {}
  const templates = (await Promise.all(ids.map(readTemplate))).filter((t): t is Template => t !== null);
  templates.sort((a, b) => b.createdAt - a.createdAt);
  return Response.json({ templates });
}

function placeholderInfo(raw: unknown): MediaInfo {
  const i = (raw ?? {}) as Partial<MediaInfo>;
  return {
    duration: num(i.duration, 0, 86400 * 2, 0) || null,
    width: num(i.width, 2, 16384, 1920),
    height: num(i.height, 2, 16384, 1080),
    videoCodec: null,
    audioCodec: null,
    hasVideo: true,
    hasAudio: i.hasAudio === true,
    container: null,
  };
}

// POST /api/templates { name, project, media: [{ id, name, size, kind, info, source, placeholder }] }
export async function POST(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { name?: unknown; project?: unknown; media?: unknown } | null;
  const name = str(body?.name, 80).trim();
  if (!name) return jsonError("Template-ийн нэр оруулна уу.");
  const project = sanitizeProject(body?.project);
  if (typeof project === "string") return jsonError(project);
  if (!Array.isArray(body?.media) || body.media.length > MAX_MEDIA) return jsonError("Медиа жагсаалт буруу.");

  const id = randomUUID();
  const dir = path.join(TEMPLATES_DIR, id);
  const assets = path.join(dir, "assets");
  await fs.mkdir(assets, { recursive: true });

  const used = new Set(project.clips.flatMap((c) => (c.type === "text" ? [] : [c.mediaId])));
  const media: TemplateMedia[] = [];
  try {
    for (const raw of body.media as Record<string, unknown>[]) {
      const mediaId = str(raw?.id);
      if (!used.has(mediaId) || media.some((m) => m.id === mediaId)) continue;
      const base = {
        id: mediaId,
        name: str(raw.name, 200) || "media",
        kind: raw.kind === "audio" ? ("audio" as const) : ("video" as const),
      };
      if (raw.placeholder === true) {
        media.push({ ...base, size: 0, info: placeholderInfo(raw.info), source: null, placeholder: true });
        continue;
      }
      const src = await resolveSource(raw.source);
      if (!src) throw new Error(`"${base.name}" файл олдсонгүй (устсан эсвэл хугацаа нь дууссан).`);
      const ext = path.extname(src).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
      const dest = path.join(assets, `${media.length + 1}-${safeBaseName(path.basename(src, path.extname(src)))}${ext}`);
      await fs.copyFile(src, dest, fsConstants.COPYFILE_FICLONE); // instant clone on APFS, plain copy elsewhere
      const [info, st] = await Promise.all([probeMedia(dest), fs.stat(dest)]);
      media.push({ ...base, size: st.size, info, source: { kind: "path", path: dest }, placeholder: false });
    }
    // Clips whose media wasn't sent can't be restored — drop them rather than save a broken template.
    project.clips = project.clips.filter((c) => c.type === "text" || media.some((m) => m.id === c.mediaId));

    const template: Template = { id, name, createdAt: Date.now(), project, media };
    const tmp = path.join(dir, "template.json.tmp");
    await fs.writeFile(tmp, JSON.stringify(template));
    await fs.rename(tmp, path.join(dir, "template.json"));
    return Response.json({ template });
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    return jsonError(err instanceof Error ? err.message : "Template хадгалж чадсангүй.", 422);
  }
}

// DELETE /api/templates?id=<id>
export async function DELETE(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!isId(id)) return jsonError("Буруу template.");
  await fs.rm(path.join(TEMPLATES_DIR, id), { recursive: true, force: true });
  return Response.json({ ok: true });
}
