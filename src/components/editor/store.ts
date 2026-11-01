import { useCallback, useState, useSyncExternalStore } from "react";
import type { Project } from "@/lib/timeline";

// ---------------------------------------------------------------------------
// Playback clock — lives outside React so the playhead can move at 60fps without
// re-rendering the whole editor. Components subscribe only where they need it.
// ---------------------------------------------------------------------------

export class Clock {
  time = 0;
  playing = false;
  private listeners = new Set<() => void>();
  private raf = 0;
  private startedAt = 0;
  private startTime = 0;
  /** Playback stops here (end of the timeline). */
  duration = 0;

  setDuration(d: number) {
    this.duration = d;
    if (this.time > d) this.seek(d);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  seek(t: number) {
    this.time = Math.max(0, t);
    if (this.playing) {
      this.startTime = this.time;
      this.startedAt = performance.now();
    }
    this.emit();
  }

  play() {
    if (this.playing) return;
    if (this.time >= this.duration - 0.01) this.time = 0;
    this.playing = true;
    this.startTime = this.time;
    this.startedAt = performance.now();
    const tick = () => {
      if (!this.playing) return;
      const t = this.startTime + (performance.now() - this.startedAt) / 1000;
      if (t >= this.duration) {
        this.time = this.duration;
        this.playing = false;
        this.emit();
        return;
      }
      this.time = t;
      this.emit();
      this.raf = requestAnimationFrame(tick);
    };
    this.emit();
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
}

export function useClockTime(clock: Clock): number {
  return useSyncExternalStore(clock.subscribe, () => clock.time, () => 0);
}

export function useClockPlaying(clock: Clock): boolean {
  return useSyncExternalStore(clock.subscribe, () => clock.playing, () => false);
}

// ---------------------------------------------------------------------------
// Undo/redo history. Consecutive commits with the same `key` (slider drags, preview
// drags) within a short window merge into one undo step.
// ---------------------------------------------------------------------------

type History = { past: Project[]; present: Project; future: Project[]; lastKey: string | null; lastAt: number };

const MERGE_MS = 1200;
const LIMIT = 200;

export function useProjectHistory(initial: () => Project) {
  const [h, setH] = useState<History>(() => ({ past: [], present: initial(), future: [], lastKey: null, lastAt: 0 }));

  const commit = useCallback((update: Project | ((p: Project) => Project), key?: string) => {
    setH((prev) => {
      const next = typeof update === "function" ? update(prev.present) : update;
      if (next === prev.present) return prev;
      const now = Date.now();
      const merge = key !== undefined && key === prev.lastKey && now - prev.lastAt < MERGE_MS;
      return {
        past: merge ? prev.past : [...prev.past, prev.present].slice(-LIMIT),
        present: next,
        future: [],
        lastKey: key ?? null,
        lastAt: now,
      };
    });
  }, []);

  const undo = useCallback(() => {
    setH((prev) =>
      prev.past.length
        ? { past: prev.past.slice(0, -1), present: prev.past[prev.past.length - 1], future: [prev.present, ...prev.future], lastKey: null, lastAt: 0 }
        : prev,
    );
  }, []);

  const redo = useCallback(() => {
    setH((prev) =>
      prev.future.length
        ? { past: [...prev.past, prev.present], present: prev.future[0], future: prev.future.slice(1), lastKey: null, lastAt: 0 }
        : prev,
    );
  }, []);

  const reset = useCallback((project: Project) => {
    setH({ past: [], present: project, future: [], lastKey: null, lastAt: 0 });
  }, []);

  return { project: h.present, commit, undo, redo, reset, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 01:39.14 (mm:ss.cc) or 1:02:03.45 past an hour — matches the toolbar timecode style. */
export function timecode(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const cs = Math.floor(sec * 100) % 100;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}.${pad(cs)}` : `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** Short ruler label: 0:05, 1:30, 1:02:00. */
export function rulerLabel(sec: number): string {
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
}

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
