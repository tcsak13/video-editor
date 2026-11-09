// Transitions between two video clips that meet on a track. Shared by the preview (which applies
// `transitionLook` every tick) and the export (which builds the same motion as ffmpeg expressions).
import { clipDuration, clipEnd, type Clip, type MediaClip } from "./timeline";

export const TRANSITION_TYPES = ["fade", "black", "white", "slideleft", "slideright", "slideup", "slidedown", "push"] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

/** Stored on the clip the transition leads into. */
export type Transition = { type: TransitionType; duration: number };

export const TRANSITION_DURATIONS = [0.3, 0.5, 1, 1.5, 2] as const;
export const DEFAULT_TRANSITION: Transition = { type: "fade", duration: 0.5 };

export const TRANSITION_LABELS: Record<TransitionType, string> = {
  fade: "Бүдгэрэх",
  black: "Хар руу",
  white: "Цагаан гялбаа",
  slideleft: "Баруунаас гулсах",
  slideright: "Зүүнээс гулсах",
  slideup: "Доороос гулсах",
  slidedown: "Дээрээс гулсах",
  push: "Түлхэх",
};

// Clips nudged by hand can sit a hair apart and still count as meeting.
const TOUCH = 0.02;

/** A place where one video clip ends and the next one on the same track starts. */
export type Cut = { from: MediaClip; into: MediaClip; at: number };

export function findCuts(clips: Clip[]): Cut[] {
  const byTrack = new Map<string, MediaClip[]>();
  for (const c of clips) if (c.type === "video") byTrack.set(c.trackId, [...(byTrack.get(c.trackId) ?? []), c]);
  const cuts: Cut[] = [];
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      const from = list[i - 1];
      const into = list[i];
      if (Math.abs(clipEnd(from) - into.start) <= TOUCH) cuts.push({ from, into, at: into.start });
    }
  }
  return cuts;
}

/**
 * Cross transitions are centred on the cut, so both pictures are on screen for its whole length:
 * the outgoing clip runs on past its end and the incoming one starts early (frozen on the first or
 * last frame where the file has nothing more). Colour dips need no overlap.
 */
export const overlaps = (type: TransitionType) => type !== "black" && type !== "white";

/** A transition as it will actually play: length capped so neighbouring ones never collide. */
export type Active = { type: TransitionType; d: number; at: number };
export type ClipTransitions = { incoming?: Active; outgoing?: Active };

export function transitionPlan(clips: Clip[]): Map<string, ClipTransitions> {
  const plan = new Map<string, ClipTransitions>();
  for (const { from, into, at } of findCuts(clips)) {
    if (!into.transition) continue;
    const d = Math.min(into.transition.duration, clipDuration(from), clipDuration(into));
    if (d < 0.05) continue;
    const active: Active = { type: into.transition.type, d, at };
    plan.set(into.id, { ...plan.get(into.id), incoming: active });
    plan.set(from.id, { ...plan.get(from.id), outgoing: active });
  }
  return plan;
}

/** Extra timeline seconds a clip is on screen before its start and after its end. */
export function handles(tr: ClipTransitions | undefined): { pre: number; post: number } {
  return {
    pre: tr?.incoming && overlaps(tr.incoming.type) ? tr.incoming.d / 2 : 0,
    post: tr?.outgoing && overlaps(tr.outgoing.type) ? tr.outgoing.d / 2 : 0,
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Smoothstep: slides start and land gently. */
export const ease = (p: number) => p * p * (3 - 2 * p);

/** Canvas-relative movement of the incoming clip (from 1 = a full canvas away, to 0). */
export const INCOMING_FROM: Partial<Record<TransitionType, { x: number; y: number }>> = {
  slideleft: { x: 1, y: 0 },
  slideright: { x: -1, y: 0 },
  slideup: { x: 0, y: 1 },
  slidedown: { x: 0, y: -1 },
  push: { x: 1, y: 0 },
};
/** Where the outgoing clip goes (only "push" moves it). */
export const OUTGOING_TO: Partial<Record<TransitionType, { x: number; y: number }>> = { push: { x: -1, y: 0 } };

export type Look = {
  alpha: number;
  /** Offset as fractions of the canvas width / height. */
  dx: number;
  dy: number;
  tint: { color: "black" | "white"; amount: number } | null;
};

/** How transitions change a clip at timeline time `t`. */
export function transitionLook(tr: ClipTransitions | undefined, t: number): Look {
  const look: Look = { alpha: 1, dx: 0, dy: 0, tint: null };
  const tintWith = (color: "black" | "white", amount: number) => {
    if (amount > (look.tint?.amount ?? 0)) look.tint = { color, amount };
  };
  if (tr?.incoming) {
    const { type, d, at } = tr.incoming;
    const p = clamp01((t - (at - d / 2)) / d);
    if (type === "fade") look.alpha *= p;
    else if (type === "black" || type === "white") tintWith(type, 1 - clamp01((t - at) / (d / 2)));
    const from = INCOMING_FROM[type];
    if (from) {
      look.dx += from.x * (1 - ease(p));
      look.dy += from.y * (1 - ease(p));
    }
  }
  if (tr?.outgoing) {
    const { type, d, at } = tr.outgoing;
    const p = clamp01((t - (at - d / 2)) / d);
    if (type === "black" || type === "white") tintWith(type, clamp01((t - (at - d / 2)) / (d / 2)));
    const to = OUTGOING_TO[type];
    if (to) {
      look.dx += to.x * ease(p);
      look.dy += to.y * ease(p);
    }
  }
  return look;
}
