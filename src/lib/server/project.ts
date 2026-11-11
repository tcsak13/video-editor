// Re-checks a timeline project that came from the browser (render + templates). No UI imports.
import {
  CLIP_ASPECT_MAX,
  CLIP_ASPECT_MIN,
  MIN_CLIP,
  ROTATIONS,
  TEXT_STYLES,
  clampCrop,
  isCanvasAspect,
  type Clip,
  type ClipFrame,
  type MediaClip,
  type Project,
  type TextClip,
  type Track,
} from "@/lib/timeline";
import { TRANSITION_TYPES, type Transition } from "@/lib/transitions";

// ---------------------------------------------------------------------------
// Validation — the project comes from the browser, so every value is re-checked.
// ---------------------------------------------------------------------------

export const MAX_TRACKS = 30;
export const MAX_CLIPS = 400;
export const MAX_MEDIA = 60;

export function pick<T>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
export function num(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
export function str(value: unknown, max = 64): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}
export function color(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function sanitizeProject(raw: unknown): Project | string {
  const p = raw as Partial<Project> | null;
  if (!p || !Array.isArray(p.tracks) || !Array.isArray(p.clips)) return "Төсөл буруу байна.";
  if (p.tracks.length > MAX_TRACKS || p.clips.length > MAX_CLIPS) return "Төсөл хэт том байна.";

  const tracks: Track[] = p.tracks.map((t) => ({
    id: str(t?.id),
    kind: pick(["video", "audio", "text"] as const, t?.kind, "video"),
    muted: t?.muted === true,
    hidden: t?.hidden === true,
    locked: t?.locked === true,
  }));
  const trackKinds = new Map(tracks.map((t) => [t.id, t.kind]));

  const clips: Clip[] = [];
  for (const c of p.clips as Partial<Clip>[]) {
    const kind = trackKinds.get(str(c?.trackId));
    if (!kind) continue;
    if (c.type === "text" && kind === "text") {
      const t = c as Partial<TextClip>;
      const text = str(t.text, 500).replace(/\r/g, "").trim();
      if (!text) continue;
      clips.push({
        id: str(t.id),
        trackId: str(t.trackId),
        type: "text",
        start: num(t.start, 0, 86400, 0),
        duration: num(t.duration, MIN_CLIP, 86400, 3),
        text,
        x: num(t.x, -1, 2, 0.5),
        y: num(t.y, -1, 2, 0.5),
        size: num(t.size, 0.01, 0.5, 0.06),
        color: color(t.color, "#ffffff"),
        style: pick(TEXT_STYLES, t.style, "box"),
        hidden: t.hidden === true,
        font: str(t.font, 80) || undefined,
        bold: t.bold === true,
      });
    } else if ((c.type === "video" && kind === "video") || (c.type === "audio" && kind === "audio")) {
      const m = c as Partial<MediaClip>;
      const inPoint = num(m.in, 0, 86400, 0);
      const crop = m.crop ?? { l: 0, r: 0, t: 0, b: 0 };
      const clip: MediaClip = {
        id: str(m.id),
        trackId: str(m.trackId),
        type: c.type,
        mediaId: str(m.mediaId),
        start: num(m.start, 0, 86400, 0),
        in: inPoint,
        out: num(m.out, inPoint + MIN_CLIP / 4, 86400, inPoint + 1),
        speed: num(m.speed, 0.25, 4, 1),
        volume: num(m.volume, 0, 2, 1),
        muted: m.muted === true,
        audioDetached: m.audioDetached === true,
        hidden: m.hidden === true,
        fadeIn: num(m.fadeIn, 0, 30, 0),
        fadeOut: num(m.fadeOut, 0, 30, 0),
        x: num(m.x, -2, 3, 0.5),
        y: num(m.y, -2, 3, 0.5),
        scale: num(m.scale, 0.05, 10, 1),
        rotate: pick(ROTATIONS, m.rotate, 0),
        flipH: m.flipH === true,
        flipV: m.flipV === true,
        opacity: num(m.opacity, 0, 1, 1),
        crop: clampCrop({ l: num(crop.l, 0, 1, 0), r: num(crop.r, 0, 1, 0), t: num(crop.t, 0, 1, 0), b: num(crop.b, 0, 1, 0) }),
      };
      const fr = m.frame as Partial<ClipFrame> | undefined;
      if (c.type === "video" && fr && typeof fr === "object") {
        clip.frame = {
          color: color(fr.color, "#000000"),
          opacity: num(fr.opacity, 0, 1, 0.6),
          padding: num(fr.padding, 0, 1, 0.15),
          radius: num(fr.radius, 0, 0.5, 0.2),
        };
      }
      if (c.type === "video" && typeof m.aspect === "number" && m.aspect >= CLIP_ASPECT_MIN && m.aspect <= CLIP_ASPECT_MAX) clip.aspect = m.aspect;
      const tr = m.transition as Partial<Transition> | undefined;
      if (c.type === "video" && tr && TRANSITION_TYPES.includes(tr.type as Transition["type"])) {
        clip.transition = { type: tr.type as Transition["type"], duration: num(tr.duration, 0.1, 4, 0.5) };
      }
      clips.push(clip);
    }
  }

  return {
    version: 1,
    tracks,
    clips,
    aspect: isCanvasAspect(p.aspect) ? p.aspect : "16:9",
    background: color(p.background, "#000000"),
  };
}
