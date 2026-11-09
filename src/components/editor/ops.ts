// Pure timeline operations. Every function returns a new Project; nothing is mutated.
import {
  MIN_CLIP,
  NO_CROP,
  aspectFromSize,
  clipDuration,
  clipEnd,
  type Clip,
  type MediaClip,
  type Project,
  type TextClip,
  type Track,
  type TrackKind,
  visualSize,
} from "@/lib/timeline";
import type { Transition } from "@/lib/transitions";
import { mediaDuration, type MediaItem } from "./media";

const EPS = 1e-3;

/** Canvas takes the shape of this clip's visible picture (after crop/rotation) and the clip fills it. */
export function fitCanvasToClip(p: Project, clipId: string, src: { width: number | null; height: number | null }): Project {
  const clip = p.clips.find((c): c is MediaClip => c.id === clipId && c.type === "video");
  if (!clip || !src.width || !src.height) return p;
  const v = visualSize(src.width, src.height, clip.crop, clip.rotate);
  return {
    ...p,
    aspect: aspectFromSize(v.w, v.h),
    clips: p.clips.map((c) => (c.id === clipId ? { ...c, scale: 1, x: 0.5, y: 0.5 } : c)),
  };
}

export function uid(prefix = "c"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyProject(): Project {
  return {
    version: 1,
    tracks: [newTrack("video")],
    clips: [],
    aspect: "16:9",
    background: "#000000",
  };
}

export function newTrack(kind: TrackKind): Track {
  return { id: uid("t"), kind, muted: false, hidden: false, locked: false };
}

export function trackOf(project: Project, trackId: string): Track | undefined {
  return project.tracks.find((t) => t.id === trackId);
}

/** True if [start, end) on the track doesn't overlap any clip except `ignore`. */
export function isFree(project: Project, trackId: string, start: number, end: number, ignore: Set<string> = new Set()) {
  return project.clips.every(
    (c) => c.trackId !== trackId || ignore.has(c.id) || clipEnd(c) <= start + EPS || c.start >= end - EPS,
  );
}

/**
 * Finds a track of `kind` with room for [start, end), or creates one. Video prefers the bottom
 * (main) track, audio/text prefer the top. New video tracks go above existing video tracks.
 */
export function placeOnTrack(
  project: Project,
  kind: TrackKind,
  start: number,
  end: number,
  prefer?: string,
  ignore?: Set<string>,
): { project: Project; trackId: string } {
  const candidates = project.tracks.filter((t) => t.kind === kind && !t.locked);
  if (kind === "video") candidates.reverse();
  if (prefer) candidates.sort((a, b) => (a.id === prefer ? -1 : b.id === prefer ? 1 : 0));
  const free = candidates.find((t) => isFree(project, t.id, start, end, ignore));
  if (free) return { project, trackId: free.id };

  const track = newTrack(kind);
  const tracks = [...project.tracks];
  tracks.splice(insertIndex(tracks, kind), 0, track);
  return { project: { ...project, tracks }, trackId: track.id };
}

/** Text tracks on top, then video (new ones above existing), then audio at the bottom. */
function insertIndex(tracks: Track[], kind: TrackKind): number {
  if (kind === "text") return 0;
  if (kind === "audio") return tracks.length;
  const firstVideo = tracks.findIndex((t) => t.kind === "video");
  if (firstVideo >= 0) return firstVideo;
  const firstAudio = tracks.findIndex((t) => t.kind === "audio");
  return firstAudio >= 0 ? firstAudio : tracks.length;
}

/**
 * Moves a clip onto a brand-new track of its kind, at the top of that kind's group (drawn in front,
 * for video) or at the bottom (drawn behind).
 */
export function moveToNewTrack(project: Project, clip: Clip, at: "top" | "bottom"): Project {
  const kind = clip.type;
  const track = newTrack(kind);
  const tracks = [...project.tracks];
  const same = tracks.flatMap((t, i) => (t.kind === kind ? [i] : []));
  const index = !same.length ? insertIndex(tracks, kind) : at === "top" ? same[0] : same[same.length - 1] + 1;
  tracks.splice(index, 0, track);
  const clips = project.clips.map((c) => (c.id === clip.id ? { ...clip, trackId: track.id } : c));
  return normalize({ ...project, tracks, clips });
}

export type TrackMove = "up" | "down" | "top" | "bottom";

/** Where a track sits among the tracks of its kind (0 = top), and how many there are. */
export function trackRank(project: Project, trackId: string): { index: number; count: number } {
  const kind = project.tracks.find((t) => t.id === trackId)?.kind;
  const same = project.tracks.filter((t) => t.kind === kind);
  return { index: same.findIndex((t) => t.id === trackId), count: same.length };
}

/**
 * Reorders a track among the tracks of its kind (video stays below text, audio at the bottom).
 * For video tracks "up" means drawn in front of the others.
 */
export function moveTrack(project: Project, trackId: string, to: TrackMove): Project {
  const { index, count } = trackRank(project, trackId);
  if (index < 0) return project;
  const target = to === "up" ? index - 1 : to === "down" ? index + 1 : to === "top" ? 0 : count - 1;
  if (target < 0 || target >= count || target === index) return project;
  const kind = project.tracks.find((t) => t.id === trackId)!.kind;
  const slots = project.tracks.flatMap((t, i) => (t.kind === kind ? [i] : []));
  const same = slots.map((i) => project.tracks[i]);
  const [moved] = same.splice(index, 1);
  same.splice(target, 0, moved);
  const tracks = [...project.tracks];
  slots.forEach((slot, k) => (tracks[slot] = same[k]));
  return { ...project, tracks };
}

/** Drops empty tracks (keeping at least one video track) so the timeline stays tidy. */
export function normalize(project: Project): Project {
  const used = new Set(project.clips.map((c) => c.trackId));
  const tracks = project.tracks.filter((t) => used.has(t.id));
  if (!tracks.some((t) => t.kind === "video")) {
    const keep = project.tracks.find((t) => t.kind === "video") ?? newTrack("video");
    tracks.splice(insertIndex(tracks, "video"), 0, keep);
  }
  return tracks.length === project.tracks.length ? project : { ...project, tracks };
}

export function newMediaClip(media: MediaItem, trackId: string, start: number): MediaClip {
  const duration = mediaDuration(media);
  return {
    id: uid(),
    trackId,
    type: media.kind,
    mediaId: media.id,
    start,
    in: 0,
    out: duration,
    speed: 1,
    volume: 1,
    muted: false,
    audioDetached: false,
    fadeIn: 0,
    fadeOut: 0,
    x: 0.5,
    y: 0.5,
    scale: 1,
    rotate: 0,
    flipH: false,
    flipV: false,
    opacity: 1,
    crop: NO_CROP,
  };
}

export function addMedia(project: Project, media: MediaItem, at: number): { project: Project; clipId: string } {
  const duration = mediaDuration(media);
  const placed = placeOnTrack(project, media.kind, at, at + duration);
  const clip = newMediaClip(media, placed.trackId, at);
  return { project: { ...placed.project, clips: [...placed.project.clips, clip] }, clipId: clip.id };
}

export const TEXT_PRESETS = {
  title: { text: "Гарчиг", y: 0.5, size: 0.1, style: "outline" },
  subtitle: { text: "Хадмал текст", y: 0.85, size: 0.055, style: "box" },
  plain: { text: "Текст", y: 0.5, size: 0.06, style: "plain" },
} as const;

export function addText(project: Project, at: number, preset: keyof typeof TEXT_PRESETS): { project: Project; clipId: string } {
  const p = TEXT_PRESETS[preset];
  const placed = placeOnTrack(project, "text", at, at + 3);
  const clip: TextClip = {
    id: uid(),
    trackId: placed.trackId,
    type: "text",
    start: at,
    duration: 3,
    text: p.text,
    x: 0.5,
    y: p.y,
    size: p.size,
    color: "#ffffff",
    style: p.style,
  };
  return { project: { ...placed.project, clips: [...placed.project.clips, clip] }, clipId: clip.id };
}

export function updateClip<T extends Clip>(project: Project, id: string, patch: Partial<T>): Project {
  return { ...project, clips: project.clips.map((c) => (c.id === id ? ({ ...c, ...patch } as Clip) : c)) };
}

/** Splits every clip in `ids` that spans `t` into two clips. */
export function splitClips(project: Project, ids: string[], t: number): { project: Project; created: string[] } {
  const idSet = new Set(ids);
  const created: string[] = [];
  const clips: Clip[] = [];
  for (const c of project.clips) {
    const end = clipEnd(c);
    if (!idSet.has(c.id) || t <= c.start + MIN_CLIP / 2 || t >= end - MIN_CLIP / 2) {
      clips.push(c);
      continue;
    }
    const offset = t - c.start;
    const rightId = uid();
    created.push(rightId);
    if (c.type === "text") {
      clips.push({ ...c, duration: offset }, { ...c, id: rightId, start: t, duration: c.duration - offset });
    } else {
      const cut = c.in + offset * c.speed;
      clips.push({ ...c, out: cut, fadeOut: 0 }, { ...c, id: rightId, start: t, in: cut, fadeIn: 0, transition: undefined });
    }
  }
  return { project: { ...project, clips }, created };
}

// Clips nudged by hand (no snapping) can sit a hair apart and still count as touching.
const JOIN_TOL = 0.02;

/**
 * `b` continues `a` seamlessly: same track, back to back, and the same recording picking up where
 * `a` stops (what a split leaves behind). Joining them can't change what plays.
 */
export function canJoin(a: Clip, b: Clip): boolean {
  if (a.id === b.id || a.trackId !== b.trackId || Math.abs(clipEnd(a) - b.start) > JOIN_TOL) return false;
  if (a.type === "text" || b.type === "text") return a.type === "text" && b.type === "text" && a.text === b.text;
  return (
    a.type === b.type &&
    a.mediaId === b.mediaId &&
    Math.abs(a.speed - b.speed) < EPS &&
    a.audioDetached === b.audioDetached &&
    Math.abs(b.in - a.out) < JOIN_TOL * a.speed
  );
}

/**
 * Undoes splits: every run of back-to-back pieces in `ids` that `canJoin` becomes one clip. The
 * left piece's settings win; the fade-out comes from the right piece.
 */
function joinPair(a: Clip, b: Clip): Clip {
  if (a.type === "text") return { ...a, duration: clipEnd(b) - a.start };
  const right = b as MediaClip;
  return { ...a, out: right.out, fadeOut: right.fadeOut };
}

export function joinClips(project: Project, ids: string[]): { project: Project; joined: string[] } {
  const idSet = new Set(ids);
  const removed = new Set<string>();
  const merged = new Map<string, Clip>();
  for (const track of project.tracks) {
    const pieces = project.clips.filter((c) => c.trackId === track.id && idSet.has(c.id)).sort((a, b) => a.start - b.start);
    let cur: Clip | null = null;
    for (const c of pieces) {
      if (cur && canJoin(cur, c)) {
        cur = joinPair(cur, c);
        removed.add(c.id);
        merged.set(cur.id, cur);
      } else {
        cur = c;
      }
    }
  }
  if (!merged.size) return { project, joined: [] };
  const clips = project.clips.filter((c) => !removed.has(c.id)).map((c) => merged.get(c.id) ?? c);
  return { project: { ...project, clips }, joined: [...merged.keys()] };
}

/** Sets (or with `undefined` removes) the transition into each of these video clips. */
export function setTransition(project: Project, intoIds: string[], transition: Transition | undefined): Project {
  const ids = new Set(intoIds);
  return { ...project, clips: project.clips.map((c) => (c.type === "video" && ids.has(c.id) ? { ...c, transition } : c)) };
}

export function deleteClips(project: Project, ids: string[], ripple = false): Project {
  const idSet = new Set(ids);
  let clips = project.clips.filter((c) => !idSet.has(c.id));
  if (ripple) {
    // Close the gap on each affected track by the deleted clips' length.
    for (const removed of project.clips.filter((c) => idSet.has(c.id)).sort((a, b) => b.start - a.start)) {
      const d = clipDuration(removed);
      clips = clips.map((c) => (c.trackId === removed.trackId && c.start >= removed.start - EPS ? { ...c, start: Math.max(0, c.start - d) } : c));
    }
  }
  return normalize({ ...project, clips });
}

export type Gap = { trackId: string; start: number; end: number };

/** Empty stretches on each track: before the first clip and between clips. */
export function trackGaps(project: Project, minLength = 0.05): Gap[] {
  const gaps: Gap[] = [];
  for (const track of project.tracks) {
    const clips = project.clips.filter((c) => c.trackId === track.id).sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const c of clips) {
      if (c.start - cursor >= minLength) gaps.push({ trackId: track.id, start: cursor, end: c.start });
      cursor = Math.max(cursor, clipEnd(c));
    }
  }
  return gaps;
}

/** Removes an empty gap: every clip after it on the same track slides left by its length. */
export function closeGap(project: Project, gap: Gap): Project {
  const shift = gap.end - gap.start;
  return {
    ...project,
    clips: project.clips.map((c) =>
      c.trackId === gap.trackId && c.start >= gap.end - EPS ? { ...c, start: Math.max(0, c.start - shift) } : c,
    ),
  };
}

/** Copies clips onto the timeline so the earliest one starts at `at`. */
export function pasteClips(project: Project, source: Clip[], at: number): { project: Project; created: string[] } {
  if (!source.length) return { project, created: [] };
  const minStart = Math.min(...source.map((c) => c.start));
  let next = project;
  const created: string[] = [];
  for (const c of [...source].sort((a, b) => a.start - b.start)) {
    const start = at + (c.start - minStart);
    const kind = c.type;
    const placed = placeOnTrack(next, kind, start, start + clipDuration(c), c.trackId);
    const copy = { ...c, id: uid(), trackId: placed.trackId, start } as Clip;
    created.push(copy.id);
    next = { ...placed.project, clips: [...placed.project.clips, copy] };
  }
  return { project: next, created };
}

/** Duplicates each clip right after itself (on another track if that spot is taken). */
export function duplicateClips(project: Project, ids: string[]): { project: Project; created: string[] } {
  let next = project;
  const created: string[] = [];
  for (const c of project.clips.filter((c) => ids.includes(c.id))) {
    const start = clipEnd(c);
    const placed = placeOnTrack(next, c.type, start, start + clipDuration(c), c.trackId);
    const copy = { ...c, id: uid(), trackId: placed.trackId, start } as Clip;
    created.push(copy.id);
    next = { ...placed.project, clips: [...placed.project.clips, copy] };
  }
  return { project: next, created };
}

/** Moves a video clip's sound into its own clip on an audio track; the video clip goes silent. */
export function detachAudio(project: Project, clipId: string): { project: Project; audioId: string | null } {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || clip.type !== "video" || clip.audioDetached) return { project, audioId: null };
  const placed = placeOnTrack(project, "audio", clip.start, clipEnd(clip));
  const audio: MediaClip = { ...clip, id: uid(), trackId: placed.trackId, type: "audio", muted: false };
  const clips = placed.project.clips.map((c) => (c.id === clipId ? { ...clip, audioDetached: true } : c));
  return { project: { ...placed.project, clips: [...clips, audio] }, audioId: audio.id };
}

/** "[" / "]": trims the selected clips' start or end to the playhead. */
export function trimToPlayhead(project: Project, ids: string[], t: number, side: "start" | "end"): Project {
  return {
    ...project,
    clips: project.clips.map((c) => {
      if (!ids.includes(c.id) || t <= c.start + MIN_CLIP || t >= clipEnd(c) - MIN_CLIP) return c;
      const offset = t - c.start;
      if (c.type === "text") {
        return side === "start" ? { ...c, start: t, duration: c.duration - offset } : { ...c, duration: offset };
      }
      return side === "start" ? { ...c, start: t, in: c.in + offset * c.speed } : { ...c, out: c.in + offset * c.speed };
    }),
  };
}

/** Edit points (clip starts/ends) for ↑/↓ navigation and snapping. */
export function editPoints(project: Project, exclude: Set<string> = new Set()): number[] {
  const pts = new Set<number>([0]);
  for (const c of project.clips) {
    if (exclude.has(c.id)) continue;
    pts.add(Number(c.start.toFixed(3)));
    pts.add(Number(clipEnd(c).toFixed(3)));
  }
  return [...pts].sort((a, b) => a - b);
}

/** A clip plus its detached-audio twin (same media, same timing), which belong together. */
export function linkedClips(project: Project, clipId: string): string[] {
  const c = project.clips.find((x) => x.id === clipId);
  if (!c || c.type === "text") return [];
  return project.clips
    .filter(
      (x) =>
        x.id === c.id ||
        (x.type !== "text" &&
          x.mediaId === c.mediaId &&
          x.type !== c.type &&
          Math.abs(x.start - c.start) < EPS &&
          Math.abs(x.in - c.in) < EPS &&
          Math.abs(x.out - c.out) < EPS),
    )
    .map((x) => x.id);
}

/**
 * Points clips at another file while keeping their place, size, crop and effects — "swap the video,
 * keep the template". When the clips are one logical clip (a video and its detached audio), it takes
 * the new file's full length; overlays that ended together with it (logo, watermark text, music)
 * follow the new end, and clips that came after it slide along.
 */
export function replaceClipMedia(
  project: Project,
  ids: string[],
  next: MediaItem,
  sourceLength: (mediaId: string) => number,
): Project {
  const targets = project.clips.filter((c): c is MediaClip => ids.includes(c.id) && c.type !== "text");
  if (!targets.length || !next.info) return project;
  const image = !!next.info.isImage;
  const newLen = image ? Infinity : (next.info.duration ?? 0);
  const one = targets.every(
    (c) => Math.abs(c.start - targets[0].start) < EPS && Math.abs(c.in - targets[0].in) < EPS && Math.abs(c.out - targets[0].out) < EPS,
  );
  const keepAudio = next.info.hasAudio && !image;

  const replaced = new Map<string, MediaClip | null>();
  for (const c of targets) {
    if (c.type === "audio" && !keepAudio) {
      replaced.set(c.id, null); // the new file has no sound for the detached-audio clip
      continue;
    }
    let { in: inPt, out } = c;
    if (image) {
      out = c.out - c.in;
      inPt = 0;
    } else if (one) {
      inPt = 0;
      out = newLen;
    } else {
      out = Math.min(c.out, newLen);
      inPt = Math.min(c.in, out - MIN_CLIP);
    }
    if (out - inPt < MIN_CLIP / 2) {
      replaced.set(c.id, null);
      continue;
    }
    replaced.set(c.id, {
      ...c,
      mediaId: next.id,
      in: inPt,
      out,
      audioDetached: c.type === "video" && c.audioDetached && keepAudio,
    });
  }

  let clips = project.clips.flatMap((c) => (replaced.has(c.id) ? (replaced.get(c.id) ? [replaced.get(c.id)!] : []) : [c]));
  if (!one) return normalize({ ...project, clips });

  const first = targets[0];
  const oldEnd = clipEnd(first);
  const kept = [...replaced.values()].find(Boolean);
  const newEnd = kept ? clipEnd(kept) : first.start;
  const delta = newEnd - oldEnd;
  if (Math.abs(delta) < EPS) return normalize({ ...project, clips });

  const targetTracks = new Set(targets.map((c) => c.trackId));
  clips = clips.map((c) => {
    if (replaced.has(c.id)) return c;
    const end = clipEnd(c);
    // Same track: everything after the clip slides with its end.
    if (targetTracks.has(c.trackId)) return c.start >= oldEnd - EPS ? { ...c, start: c.start + delta } : c;
    // Overlays that ended together with the clip stretch/shrink to the new end.
    if (Math.abs(end - oldEnd) < 0.05 && c.start < newEnd - MIN_CLIP) {
      const len = newEnd - c.start;
      if (c.type === "text") return { ...c, duration: len };
      const max = c.mediaId === next.id ? newLen : sourceLength(c.mediaId);
      return { ...c, out: Math.min(max, c.in + len * c.speed) };
    }
    return c;
  });
  // Other tracks: clips that started after the old end follow it when there is room.
  let out: Project = { ...project, clips };
  // Move the clip nearest the edge first so neighbours on the same track don't block each other.
  const order = [...clips].sort((a, b) => (delta > 0 ? b.start - a.start : a.start - b.start));
  for (const c of order) {
    if (targetTracks.has(c.trackId) || replaced.has(c.id) || c.start < oldEnd - EPS) continue;
    const moved = { ...c, start: Math.max(0, c.start + delta) };
    const rest = { ...out, clips: out.clips.filter((x) => x.id !== c.id) };
    if (isFree(rest, c.trackId, moved.start, clipEnd(moved))) out = { ...rest, clips: [...rest.clips, moved] };
  }
  return normalize(out);
}
