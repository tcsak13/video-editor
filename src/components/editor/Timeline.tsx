"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Blend,
  ChevronDown,
  ChevronsLeft,
  ChevronUp,
  Eye,
  EyeOff,
  Film,
  Lock,
  Moon,
  Music,
  Sparkles,
  Sun,
  Trash2,
  Type,
  Unlink,
  Unlock,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { MIN_CLIP, clipDuration, clipEnd, type Clip, type Project, type Track } from "@/lib/timeline";
import { thumbsUrl, type MediaItem } from "./media";
import { createPortal } from "react-dom";
import {
  DEFAULT_TRANSITION,
  TRANSITION_DURATIONS,
  TRANSITION_LABELS,
  TRANSITION_TYPES,
  findCuts,
  type Cut,
  type Transition,
  type TransitionType,
} from "@/lib/transitions";
import { closeGap, editPoints, isFree, moveToNewTrack, moveTrack, normalize, setTransition, trackGaps, trackRank, type Gap, type TrackMove } from "./ops";
import { cx, rulerLabel, useClockTime, type Clock } from "./store";

export const HEADER_W = 184;
/** Zoom range in pixels per second: fully out shows ~8 hours across a screen, fully in shows frames. */
export const MIN_PPS = 0.05;
export const MAX_PPS = 400;
export const clampPps = (pps: number) => Math.min(MAX_PPS, Math.max(MIN_PPS, pps));
const RULER_H = 28;
const LANE_H: Record<Track["kind"], number> = { video: 66, audio: 48, text: 34 };
const SNAP_PX = 8;
export const MEDIA_DRAG_TYPE = "application/x-editor-media";

type Props = {
  project: Project;
  media: Map<string, MediaItem>;
  clock: Clock;
  selected: string[];
  setSelected: (ids: string[]) => void;
  commit: (update: Project | ((p: Project) => Project), key?: string) => void;
  pps: number;
  setPps: (pps: number) => void;
  snapping: boolean;
  onDropMedia: (mediaId: string, trackId: string | null, time: number) => void;
  onDropFiles: (files: File[], time: number) => void;
  onContextMenu: (req: TimelineMenuRequest) => void;
};

export type TimelineMenuRequest = { x: number; y: number; clipId: string | null; gap: Gap | null; time: number };

type Drag = {
  mode: "move" | "trim-l" | "trim-r";
  primary: string;
  ids: string[];
  orig: Map<string, Clip>;
  x0: number;
  y0: number;
  moved: boolean;
};

/** A single dragged clip can land on a new track above or below the tracks of its kind. */
type NewTrackDrop = { at: "top" | "bottom"; y: number };
type Ghost = { clips: Map<string, Clip>; invalid: boolean; snapAt: number | null; newTrack: NewTrackDrop | null };

const NEW_TRACK = "__new-track__";

export default function Timeline(props: Props) {
  const { project, media, clock, selected, setSelected, commit, pps, setPps, snapping } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 1000 });
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [dropHint, setDropHint] = useState<{ trackId: string | null; time: number } | null>(null);
  const [selectedGap, setSelectedGap] = useState<Gap | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const ppsRef = useRef(pps);

  useEffect(() => {
    ppsRef.current = pps;
  }, [pps]);

  const duration = useMemo(() => project.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0), [project.clips]);
  const contentW = Math.max(view.width - HEADER_W, (duration + 30) * pps);

  // Track the visible window so filmstrip tiles and ruler ticks are only rendered where seen.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setView({ left: el.scrollLeft, width: el.clientWidth }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // Wheel: Ctrl/⌘ (and trackpad pinch, which arrives as ctrl+wheel) zooms around the pointer,
  // Shift scrolls sideways, and so does a plain wheel when there are no extra tracks to scroll down to.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1; // lines/pages → px
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        // macOS already turns shift+wheel into deltaX; Windows/Linux send it as deltaY.
        el.scrollLeft += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
        return;
      }
      if (!e.ctrlKey && !e.metaKey) {
        if (el.scrollHeight <= el.clientHeight && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          el.scrollLeft += e.deltaY * unit;
        }
        return;
      }
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - HEADER_W;
      const t = (el.scrollLeft + px) / ppsRef.current;
      const next = clampPps(ppsRef.current * Math.exp(-e.deltaY * unit * 0.002));
      setPps(next);
      requestAnimationFrame(() => (el.scrollLeft = t * next - px));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setPps]);

  // Keep the playhead on screen while playing (but not while the user is dragging it).
  const scrubbing = useRef(false);
  useEffect(() => {
    return clock.subscribe(() => {
      const el = scrollRef.current;
      if (!el || !clock.playing || scrubbing.current) return;
      const x = clock.time * ppsRef.current;
      const visibleW = el.clientWidth - HEADER_W;
      if (x > el.scrollLeft + visibleW - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
    });
  }, [clock]);

  // Row layout (y offsets inside the lanes area) for vertical drag targets.
  const rows = useMemo(() => {
    const out: { track: Track; top: number; height: number }[] = [];
    let y = 0;
    for (const track of project.tracks) {
      out.push({ track, top: y, height: LANE_H[track.kind] });
      y += LANE_H[track.kind];
    }
    return out;
  }, [project.tracks]);

  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - HEADER_W + el.scrollLeft) / pps);
  };
  const rowAt = (clientY: number) => {
    const el = scrollRef.current!;
    const y = clientY - el.getBoundingClientRect().top - RULER_H + el.scrollTop;
    return rows.find((r) => y >= r.top && y < r.top + r.height) ?? null;
  };

  /** Past the first/last track of `kind` (in y), a drop makes a new track there. */
  const newTrackAt = (clientY: number, kind: Track["kind"]): NewTrackDrop | null => {
    const group = rows.filter((r) => r.track.kind === kind);
    if (!group.length) return null;
    const el = scrollRef.current!;
    const y = clientY - el.getBoundingClientRect().top - RULER_H + el.scrollTop;
    const top = group[0].top;
    const bottom = group[group.length - 1].top + group[group.length - 1].height;
    if (y < top) return { at: "top", y: top };
    if (y >= bottom) return { at: "bottom", y: bottom };
    return null;
  };

  // --- clip drag (move / trim) ----------------------------------------------------
  const onClipPointerDown = (e: ReactPointerEvent, clip: Clip, mode: Drag["mode"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedGap(null);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive) {
      setSelected(selected.includes(clip.id) ? selected.filter((id) => id !== clip.id) : [...selected, clip.id]);
      return;
    }
    const ids = mode === "move" && selected.includes(clip.id) ? selected : [clip.id];
    if (!selected.includes(clip.id) || mode !== "move") setSelected(ids);
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (track?.locked) return;
    const movable = ids.filter((id) => {
      const c = project.clips.find((x) => x.id === id);
      return c && !project.tracks.find((t) => t.id === c.trackId)?.locked;
    });
    dragRef.current = {
      mode,
      primary: clip.id,
      ids: movable,
      orig: new Map(project.clips.filter((c) => movable.includes(c.id)).map((c) => [c.id, c])),
      x0: e.clientX,
      y0: e.clientY,
      moved: false,
    };
    const move = (ev: PointerEvent) => handlers.current.move(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      handlers.current.end();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const projectRef = useRef(project);
  const ghostRef = useRef<Ghost | null>(null);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const snapTo = (value: number, points: number[]): { value: number; at: number | null } => {
    if (!snapping) return { value, at: null };
    let best: number | null = null;
    for (const p of points) if (Math.abs(p - value) * ppsRef.current < SNAP_PX && (best === null || Math.abs(p - value) < Math.abs(best - value))) best = p;
    return best === null ? { value, at: null } : { value: best, at: best };
  };

  function onDragMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 3) return;
    d.moved = true;
    const p = projectRef.current;
    const scale = ppsRef.current;
    const exclude = new Set(d.ids);
    const points = [...editPoints(p, exclude), clock.time];
    const primary = d.orig.get(d.primary)!;
    let dt = (e.clientX - d.x0) / scale;
    const clips = new Map<string, Clip>();
    let snapAt: number | null = null;
    let newTrack: NewTrackDrop | null = null;

    if (d.mode === "move") {
      const minStart = Math.min(...[...d.orig.values()].map((c) => c.start));
      dt = Math.max(dt, -minStart);
      const s1 = snapTo(primary.start + dt, points);
      const s2 = snapTo(clipEnd(primary) + dt, points);
      if (s1.at !== null && (s2.at === null || Math.abs(s1.value - primary.start - dt) <= Math.abs(s2.value - clipEnd(primary) - dt))) {
        dt = s1.value - primary.start;
        snapAt = s1.at;
      } else if (s2.at !== null) {
        dt = s2.value - clipEnd(primary);
        snapAt = s2.at;
      }
      dt = Math.max(dt, -minStart);
      // Single clips can hop to another track of the same kind.
      // Single clips can hop to another track of the same kind, or onto a new one past the edge.
      const row = d.ids.length === 1 ? rowAt(e.clientY) : null;
      newTrack = d.ids.length === 1 && !(row && row.track.kind === primary.type) ? newTrackAt(e.clientY, primary.type) : null;
      const targetTrack = newTrack ? NEW_TRACK : row && row.track.kind === primary.type && !row.track.locked ? row.track.id : null;
      for (const c of d.orig.values()) {
        clips.set(c.id, { ...c, start: c.start + dt, trackId: targetTrack && c.id === d.primary ? targetTrack : c.trackId });
      }
    } else {
      const c = primary;
      const neighbors = p.clips.filter((x) => x.trackId === c.trackId && x.id !== c.id);
      const m = c.type === "text" ? null : media.get(c.mediaId);
      // Pictures (and text) have no source length: they stretch freely both ways.
      const still = c.type === "text" || !!m?.info?.isImage;
      const srcDur = still ? Infinity : (m?.info?.duration ?? Infinity);
      if (d.mode === "trim-l") {
        const prevEnd = Math.max(0, ...neighbors.filter((x) => x.start < c.start).map(clipEnd));
        const lower = Math.max(prevEnd, still ? 0 : c.start - c.in / c.speed);
        const upper = clipEnd(c) - MIN_CLIP;
        const s = snapTo(Math.min(upper, Math.max(lower, c.start + dt)), points);
        const start = Math.min(upper, Math.max(lower, s.value));
        snapAt = s.at;
        const off = start - c.start;
        clips.set(
          c.id,
          c.type === "text"
            ? { ...c, start, duration: c.duration - off }
            : still
              ? { ...c, start, out: c.out - off * c.speed }
              : { ...c, start, in: c.in + off * c.speed },
        );
      } else {
        const nextStart = Math.min(Infinity, ...neighbors.filter((x) => x.start >= clipEnd(c) - 1e-3).map((x) => x.start));
        const upper = Math.min(nextStart, c.type === "text" ? Infinity : c.start + (srcDur - c.in) / c.speed);
        const lower = c.start + MIN_CLIP;
        const s = snapTo(Math.min(upper, Math.max(lower, clipEnd(c) + dt)), points);
        const end = Math.min(upper, Math.max(lower, s.value));
        snapAt = s.at;
        clips.set(c.id, c.type === "text" ? { ...c, duration: end - c.start } : { ...c, out: c.in + (end - c.start) * c.speed });
      }
    }

    const invalid = [...clips.values()].some((c) => !isFree(p, c.trackId, c.start, clipEnd(c), exclude));
    const g = { clips, invalid, snapAt, newTrack };
    ghostRef.current = g;
    setGhost(g);
  }

  function onDragEnd() {
    const g = ghostRef.current;
    const d = dragRef.current;
    dragRef.current = null;
    ghostRef.current = null;
    setGhost(null);
    if (!d?.moved || !g || g.invalid) return;
    const onNew = g.newTrack ? [...g.clips.values()].find((c) => c.trackId === NEW_TRACK) : undefined;
    if (onNew && g.newTrack) {
      const at = g.newTrack.at;
      commit((p) => moveToNewTrack(p, onNew, at));
      return;
    }
    commit((p) => normalize({ ...p, clips: p.clips.map((c) => g.clips.get(c.id) ?? c) }));
  }

  // Window listeners outlive a render; route them through a ref to the latest handlers.
  const handlers = useRef({ move: onDragMove, end: onDragEnd });
  useEffect(() => {
    handlers.current = { move: onDragMove, end: onDragEnd };
  });

  // --- ruler scrubbing / empty-lane clicks --------------------------------------
  // Dragging the playhead keeps playback running (it continues from wherever it's dropped).
  const startScrub = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    scrubbing.current = true;
    clock.seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => clock.seek(timeAt(ev.clientX));
    const up = () => {
      scrubbing.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // --- drop media / files ----------------------------------------------------------
  const onDragOver = (e: DragEvent) => {
    const isMedia = e.dataTransfer.types.includes(MEDIA_DRAG_TYPE);
    if (!isMedia && !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropHint({ trackId: rowAt(e.clientY)?.track.id ?? null, time: timeAt(e.clientX) });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropHint(null);
    const time = timeAt(e.clientX);
    const mediaId = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (mediaId) props.onDropMedia(mediaId, rowAt(e.clientY)?.track.id ?? null, time);
    else if (e.dataTransfer.files.length) props.onDropFiles([...e.dataTransfer.files], time);
  };

  // --- track header actions ----------------------------------------------------------
  const patchTrack = (id: string, patch: Partial<Track>) =>
    commit((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  // --- transitions: a marker on every cut between two video clips opens the picker ----
  const cuts = useMemo(() => findCuts(project.clips), [project.clips]);
  const [picker, setPicker] = useState<{ intoId: string; x: number; y: number } | null>(null);
  const pickerCut = picker ? cuts.find((c) => c.into.id === picker.intoId) : undefined;
  const applyTransition = (cut: Cut, transition: Transition | undefined, everywhere = false) => {
    commit((p) => {
      const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
      const ids = everywhere ? findCuts(p.clips).filter((c) => !locked.has(c.into.trackId)).map((c) => c.into.id) : [cut.into.id];
      return setTransition(p, ids, transition);
    });
    // Park the playhead just before it, so Space plays the transition straight away.
    if (transition) clock.seek(Math.max(0, cut.at - transition.duration / 2 - 0.6));
  };

  const reorderTrack = (id: string, to: TrackMove) => commit((p) => moveTrack(p, id, to));
  const deleteTrack = (id: string) =>
    commit((p) => normalize({ ...p, tracks: p.tracks.filter((t) => t.id !== id), clips: p.clips.filter((c) => c.trackId !== id) }));

  // --- empty gaps: hover/select shows a trash button that closes the gap -------------
  const gaps = useMemo(() => trackGaps(project), [project]);
  const sameGap = (a: Gap | null, b: Gap) => !!a && a.trackId === b.trackId && Math.abs(a.start - b.start) < 1e-3 && Math.abs(a.end - b.end) < 1e-3;
  const activeGap = selectedGap && gaps.find((g) => sameGap(selectedGap, g)) ? selectedGap : null;
  const removeGap = (gap: Gap) => {
    commit((p) => closeGap(p, gap));
    setSelectedGap(null);
  };

  useEffect(() => {
    if (!activeGap) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        e.stopImmediatePropagation();
        commit((p) => closeGap(p, activeGap));
        setSelectedGap(null);
      } else if (e.code === "Escape") {
        setSelectedGap(null);
      }
    };
    // Capture phase so the editor's own Delete handler doesn't also run.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeGap, commit]);

  const labels = useMemo(() => {
    const counts = { video: 0, audio: 0, text: 0 };
    const names = { video: "Видео", audio: "Аудио", text: "Текст" };
    const byKind = { video: [] as string[], audio: [] as string[], text: [] as string[] };
    project.tracks.forEach((t) => byKind[t.kind].push(t.id));
    const map = new Map<string, string>();
    // Number video tracks bottom-up (Видео 1 = main track), others top-down.
    [...byKind.video].reverse().forEach((id) => map.set(id, `${names.video} ${++counts.video}`));
    byKind.audio.forEach((id) => map.set(id, `${names.audio} ${++counts.audio}`));
    byKind.text.forEach((id) => map.set(id, `${names.text} ${++counts.text}`));
    return map;
  }, [project.tracks]);

  const visStart = Math.max(0, (view.left - 40) / pps);
  const visEnd = (view.left + view.width) / pps;

  return (
    <div
      ref={scrollRef}
      className="relative h-full overflow-auto overscroll-contain bg-zinc-950 select-none"
      onDragOver={onDragOver}
      onDragLeave={() => setDropHint(null)}
      onDrop={onDrop}
    >
      <div className="relative" style={{ width: HEADER_W + contentW, minHeight: "100%" }}>
        {/* Ruler */}
        <div className="sticky top-0 z-30 flex" style={{ height: RULER_H }}>
          <div className="sticky left-0 z-40 shrink-0 border-b border-r border-zinc-800 bg-zinc-950" style={{ width: HEADER_W }} />
          <div className="relative flex-1 cursor-pointer overflow-hidden border-b border-zinc-800 bg-zinc-950" onPointerDown={startScrub}>
            <Ruler pps={pps} from={visStart} to={visEnd} />
          </div>
        </div>

        {/* Tracks */}
        {rows.map(({ track, height }) => (
          <div key={track.id} className="flex" style={{ height }}>
            <TrackHeader
              track={track}
              label={labels.get(track.id) ?? ""}
              rank={trackRank(project, track.id)}
              onPatch={(patch) => patchTrack(track.id, patch)}
              onMove={(to) => reorderTrack(track.id, to)}
              onDelete={() => deleteTrack(track.id)}
            />
            <div
              className={cx(
                "group/lane relative flex-1 border-b border-zinc-800/70",
                dropHint?.trackId === track.id ? "bg-violet-500/10" : "bg-zinc-900/30",
                track.locked && "bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(255,255,255,0.02)_6px,rgba(255,255,255,0.02)_12px)]",
              )}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                setSelected([]);
                setSelectedGap(null);
                clock.seek(timeAt(e.clientX));
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                props.onContextMenu({ x: e.clientX, y: e.clientY, clipId: null, gap: null, time: timeAt(e.clientX) });
              }}
            
            >
              {!ghost &&
                !track.locked &&
                gaps
                  .filter((g) => g.trackId === track.id)
                  .map((g) => (
                    <GapView
                      key={`${g.start.toFixed(3)}`}
                      gap={g}
                      pps={pps}
                      visLeft={view.left}
                      visRight={view.left + view.width - HEADER_W}
                      selected={sameGap(activeGap, g)}
                      onSelect={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        setSelected([]);
                        setSelectedGap(g);
                        clock.seek(timeAt(e.clientX));
                      }}
                      onRemove={() => removeGap(g)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedGap(g);
                        props.onContextMenu({ x: e.clientX, y: e.clientY, clipId: null, gap: g, time: timeAt(e.clientX) });
                      }}
                    />
                  ))}
              {project.clips
                .filter((c) => (ghost?.clips.get(c.id)?.trackId ?? c.trackId) === track.id)
                .map((c) => {
                  const shown = ghost?.clips.get(c.id) ?? c;
                  const left = shown.start * pps;
                  const width = Math.max(2, clipDuration(shown) * pps);
                  if (left > view.left + view.width || left + width < view.left - HEADER_W) return null;
                  return (
                    <ClipView
                      key={c.id}
                      clip={shown}
                      track={track}
                      media={shown.type === "text" ? undefined : media.get(shown.mediaId)}
                      selected={selected.includes(c.id)}
                      invalid={!!ghost?.clips.has(c.id) && ghost.invalid}
                      dragging={!!ghost?.clips.has(c.id)}
                      left={left}
                      width={width}
                      pps={pps}
                      visLeft={view.left - HEADER_W}
                      visRight={view.left + view.width}
                      onPointerDown={onClipPointerDown}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedGap(null);
                        props.onContextMenu({ x: e.clientX, y: e.clientY, clipId: c.id, gap: null, time: timeAt(e.clientX) });
                      }}
                    />
                  );
                })}
              {!ghost &&
                !track.locked &&
                cuts
                  .filter((cut) => cut.into.trackId === track.id)
                  .map((cut) => (
                    <CutMarker
                      key={cut.into.id}
                      cut={cut}
                      left={cut.at * pps}
                      open={picker?.intoId === cut.into.id}
                      onOpen={(rect) => setPicker({ intoId: cut.into.id, x: rect.left + rect.width / 2, y: rect.top })}
                    />
                  ))}
            </div>
          </div>
        ))}

        {/* Empty area below tracks accepts drops into a new track */}
        <div
          className={cx("flex", dropHint && dropHint.trackId === null && "bg-violet-500/10")}
          style={{ height: 56 }}
          onPointerDown={() => setSelected([])}
        >
          <div className="sticky left-0 z-20 shrink-0 border-r border-zinc-800 bg-zinc-950" style={{ width: HEADER_W }} />
          <div className="flex flex-1 items-center pl-3 text-xs text-zinc-600">
            {project.clips.length === 0 ? "Медиаг энд чирж оруулна уу" : ""}
          </div>
        </div>

        {/* Dropping onto a new track: a line where it will appear, with the clip's outline on it */}
        {ghost?.newTrack &&
          [...ghost.clips.values()]
            .filter((c) => c.trackId === NEW_TRACK)
            .map((c) => (
              <div key={c.id} className="pointer-events-none absolute z-20" style={{ top: RULER_H + ghost.newTrack!.y, left: 0, right: 0 }}>
                <div className="absolute inset-x-0 -top-px h-0.5 bg-violet-400" style={{ left: HEADER_W }} />
                <div
                  className="absolute -translate-y-1/2 rounded-md border-2 border-dashed border-violet-400 bg-violet-500/20 px-2 py-1 text-[11px] font-medium text-violet-100"
                  style={{ left: HEADER_W + c.start * pps, width: Math.max(80, clipDuration(c) * pps), height: 40 }}
                >
                  {c.type === "video"
                    ? `Шинэ давхарга — ${ghost.newTrack!.at === "top" ? "урд харагдана" : "ард харагдана"}`
                    : `Шинэ track — ${ghost.newTrack!.at === "top" ? "дээр" : "доор"}`}
                </div>
              </div>
            ))}

        {/* Snap guide */}
        {ghost?.snapAt != null && (
          <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-sky-400" style={{ left: HEADER_W + ghost.snapAt * pps }} />
        )}
        {dropHint && (
          <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-violet-400" style={{ left: HEADER_W + dropHint.time * pps }} />
        )}

        <Playhead clock={clock} pps={pps} onGrab={startScrub} />
        {picker && pickerCut && (
          <TransitionPicker
            cut={pickerCut}
            x={picker.x}
            y={picker.y}
            cutCount={cuts.length}
            onApply={(t, everywhere) => applyTransition(pickerCut, t, everywhere)}
            onClose={() => setPicker(null)}
          />
        )}
      </div>
    </div>
  );
}

function GapView({
  gap,
  pps,
  visLeft,
  visRight,
  selected,
  onSelect,
  onRemove,
  onContextMenu,
}: {
  gap: Gap;
  pps: number;
  visLeft: number;
  visRight: number;
  selected: boolean;
  onSelect: (e: ReactPointerEvent) => void;
  onRemove: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const left = gap.start * pps;
  const width = (gap.end - gap.start) * pps;
  if (left > visRight || left + width < visLeft) return null;
  // Center the button in the part of the gap that is on screen.
  const center = (Math.max(left, visLeft) + Math.min(left + width, visRight)) / 2 - left;
  const seconds = gap.end - gap.start;
  return (
    <div
      onPointerDown={onSelect}
      onContextMenu={onContextMenu}
      className={cx(
        "group absolute top-1 bottom-1 rounded-md border border-dashed transition-colors",
        selected ? "border-amber-400/80 bg-amber-400/10" : "border-transparent hover:border-zinc-600 hover:bg-zinc-700/20",
      )}
      style={{ left, width }}
    >
      {width >= 22 && (
        <button
          type="button"
          title={`Хоосон зайг устгах (${seconds.toFixed(1)} сек) — дараагийн клипүүд урагшилна`}
          aria-label="Хоосон зайг устгах"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onRemove}
          className={cx(
            "absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-md bg-zinc-800 px-1.5 py-1 text-[11px] text-zinc-200 shadow-lg ring-1 ring-zinc-600 transition hover:bg-red-500 hover:text-white hover:ring-red-400",
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          style={{ left: center }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {width >= 110 && <span>{seconds.toFixed(1)}с</span>}
        </button>
      )}
    </div>
  );
}

function Ruler({ pps, from, to }: { pps: number; from: number; to: number }) {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
  const major = steps.find((s) => s * pps >= 64) ?? 14400;
  const minor = major / 5;
  const ticks: { t: number; major: boolean }[] = [];
  for (let t = Math.floor(from / minor) * minor; t <= to + major; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ticks.push({ t, major: isMajor });
  }
  return (
    <>
      {ticks.map(({ t, major: isMajor }) => (
        <div key={t.toFixed(3)} className="absolute bottom-0" style={{ left: t * pps }}>
          <div className={cx("w-px", isMajor ? "h-2.5 bg-zinc-500" : "h-1.5 bg-zinc-700")} />
          {isMajor && (
            <span className="absolute bottom-3 -translate-x-1/2 font-mono text-[10px] text-zinc-500">
              {major < 1 ? t.toFixed(1) : rulerLabel(t)}
            </span>
          )}
        </div>
      ))}
    </>
  );
}

function Playhead({ clock, pps, onGrab }: { clock: Clock; pps: number; onGrab: (e: ReactPointerEvent) => void }) {
  const t = useClockTime(clock);
  return (
    <div className="pointer-events-none absolute bottom-0 top-0 z-30" style={{ left: HEADER_W + t * pps }}>
      <div className="absolute bottom-0 top-0 w-0.5 -translate-x-1/2 bg-orange-500" />
      <div
        onPointerDown={onGrab}
        className="pointer-events-auto absolute -top-0 h-4 w-3 -translate-x-1/2 cursor-ew-resize rounded-b-sm bg-orange-500"
      />
    </div>
  );
}

const TRANSITION_ICONS: Record<TransitionType, ComponentType<{ className?: string }>> = {
  fade: Blend,
  black: Moon,
  white: Sun,
  slideleft: ArrowLeft,
  slideright: ArrowRight,
  slideup: ArrowUp,
  slidedown: ArrowDown,
  push: ChevronsLeft,
};

function CutMarker({ cut, left, open, onOpen }: { cut: Cut; left: number; open: boolean; onOpen: (rect: DOMRect) => void }) {
  const t = cut.into.transition;
  const Icon = t ? TRANSITION_ICONS[t.type] : Sparkles;
  return (
    <button
      type="button"
      title={t ? `Шилжилт: ${TRANSITION_LABELS[t.type]} · ${t.duration}с` : "Шилжилт нэмэх"}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}
      className={cx(
        "absolute top-1/2 z-[5] flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border shadow-md shadow-black/50 transition",
        t || open
          ? "border-violet-300 bg-violet-600 text-white hover:bg-violet-500"
          : "border-zinc-500 bg-zinc-900/95 text-zinc-300 opacity-0 hover:border-violet-400 hover:text-white group-hover/lane:opacity-100",
      )}
      style={{ left }}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function TransitionPicker({
  cut,
  x,
  y,
  cutCount,
  onApply,
  onClose,
}: {
  cut: Cut;
  x: number;
  y: number;
  cutCount: number;
  onApply: (t: Transition | undefined, everywhere?: boolean) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const current = cut.into.transition;
  const duration = current?.duration ?? DEFAULT_TRANSITION.duration;

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const W = 296;
  const left = Math.min(Math.max(8, x - W / 2), window.innerWidth - W - 8);
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[100] rounded-xl border border-zinc-700 bg-zinc-900 p-3 shadow-2xl shadow-black/70"
      style={{ left, bottom: window.innerHeight - y + 8, width: W }}
    >
      <div className="mb-2 text-xs font-semibold text-zinc-200">Шилжилт</div>
      <div className="grid grid-cols-2 gap-1.5">
        {TRANSITION_TYPES.map((type) => {
          const Icon = TRANSITION_ICONS[type];
          const on = current?.type === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => onApply({ type, duration })}
              className={cx(
                "flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition",
                on ? "border-violet-500 bg-violet-500/20 text-white" : "border-zinc-800 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800",
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {TRANSITION_LABELS[type]}
            </button>
          );
        })}
      </div>
      <div className="mt-3 mb-1.5 text-[11px] text-zinc-500">Урт</div>
      <div className="flex gap-1">
        {TRANSITION_DURATIONS.map((d) => (
          <button
            key={d}
            type="button"
            disabled={!current}
            onClick={() => current && onApply({ ...current, duration: d })}
            className={cx(
              "flex-1 rounded-md border py-1 font-mono text-[11px] transition disabled:opacity-40",
              Math.abs(duration - d) < 1e-6 ? "border-violet-500 bg-violet-500/20 text-white" : "border-zinc-800 text-zinc-400 hover:bg-zinc-800",
            )}
          >
            {d}с
          </button>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        {cutCount > 1 && (
          <button
            type="button"
            disabled={!current}
            onClick={() => current && onApply(current, true)}
            className="flex-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-xs text-zinc-200 transition hover:border-violet-500 disabled:opacity-40"
          >
            Бүх зүсэлтэд ({cutCount})
          </button>
        )}
        <button
          type="button"
          disabled={!current}
          onClick={() => {
            onApply(undefined);
            onClose();
          }}
          className="flex-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 transition hover:border-red-500 hover:text-white disabled:opacity-40"
        >
          Арилгах
        </button>
      </div>
      <p className="mt-2 text-[10px] leading-snug text-zinc-500">Playhead шилжилтийн өмнө зогсоно. Space дарж үзнэ.</p>
    </div>,
    document.body,
  );
}

function TrackHeader({
  track,
  label,
  rank,
  onPatch,
  onMove,
  onDelete,
}: {
  track: Track;
  label: string;
  rank: { index: number; count: number };
  onPatch: (p: Partial<Track>) => void;
  onMove: (to: TrackMove) => void;
  onDelete: () => void;
}) {
  const Icon = track.kind === "video" ? Film : track.kind === "audio" ? Music : Type;
  const btn = "rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200";
  return (
    <div
      className="group sticky left-0 z-20 flex shrink-0 items-center gap-1 border-b border-r border-zinc-800 bg-zinc-950 px-2"
      style={{ width: HEADER_W }}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-zinc-400">{label}</span>
      {track.kind !== "audio" && (
        <button type="button" title={track.hidden ? "Харуулах" : "Нуух"} className={btn} onClick={() => onPatch({ hidden: !track.hidden })}>
          {track.hidden ? <EyeOff className="h-3.5 w-3.5 text-amber-400" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      )}
      {track.kind !== "text" && (
        <button type="button" title={track.muted ? "Дуу нээх" : "Дуу хаах"} className={btn} onClick={() => onPatch({ muted: !track.muted })}>
          {track.muted ? <VolumeX className="h-3.5 w-3.5 text-red-400" /> : <Volume2 className="h-3.5 w-3.5" />}
        </button>
      )}
      <button type="button" title={track.locked ? "Түгжээ тайлах" : "Түгжих"} className={btn} onClick={() => onPatch({ locked: !track.locked })}>
        {track.locked ? <Lock className="h-3.5 w-3.5 text-amber-400" /> : <Unlock className="h-3.5 w-3.5" />}
      </button>
      {rank.count > 1 && (
        <span className="hidden flex-col group-hover:flex">
          <button
            type="button"
            title={track.kind === "video" ? "Урагшлуулах: бусад видеоны өмнө харагдана" : "Дээш зөөх"}
            disabled={rank.index === 0}
            className="rounded px-0.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-25"
            onClick={(e) => onMove(e.shiftKey ? "top" : "up")}
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            title={track.kind === "video" ? "Хойшлуулах: бусад видеоны ард харагдана" : "Доош зөөх"}
            disabled={rank.index === rank.count - 1}
            className="rounded px-0.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-25"
            onClick={(e) => onMove(e.shiftKey ? "bottom" : "down")}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </span>
      )}
      <button type="button" title="Track устгах" className={cx(btn, "hidden group-hover:block")} onClick={onDelete}>
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ClipView({
  clip,
  track,
  media,
  selected,
  invalid,
  dragging,
  left,
  width,
  pps,
  visLeft,
  visRight,
  onPointerDown,
  onContextMenu,
}: {
  clip: Clip;
  track: Track;
  media: MediaItem | undefined;
  selected: boolean;
  invalid: boolean;
  dragging: boolean;
  left: number;
  width: number;
  pps: number;
  visLeft: number;
  visRight: number;
  onPointerDown: (e: ReactPointerEvent, clip: Clip, mode: Drag["mode"]) => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}) {
  const isText = clip.type === "text";
  const showWave = !isText && !!media?.info?.hasAudio && !(clip.type === "video" && clip.audioDetached);
  const muted = !isText && (clip.muted || track.muted);
  // Only the visible slice of a (possibly hours-long) clip gets tiles/waveform.
  const sliceStart = Math.max(0, visLeft - left);
  const sliceEnd = Math.min(width, visRight - left);

  return (
    <div
      data-clip-id={clip.id}
      data-clip-type={clip.type}
      onPointerDown={(e) => onPointerDown(e, clip, "move")}
      onContextMenu={onContextMenu}
      className={cx(
        "absolute top-1 bottom-1 overflow-hidden rounded-md border text-left",
        isText ? "bg-violet-700/80" : clip.type === "audio" ? "bg-emerald-900/70" : "bg-zinc-800",
        media?.placeholder && "border-dashed bg-[repeating-linear-gradient(135deg,#27272a_0_10px,#1f1f23_10px_20px)]",
        selected ? "border-amber-400 ring-1 ring-amber-400" : "border-zinc-700/80",
        invalid && "border-red-500 ring-red-500",
        dragging && "opacity-80 shadow-lg shadow-black/50",
        clip.hidden && !dragging && "opacity-45",
        track.locked ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing",
      )}
      style={{ left, width, zIndex: dragging ? 10 : selected ? 2 : 1 }}
    >
      {!isText && media && sliceEnd > sliceStart && (
        <ClipContent clip={clip} media={media} pps={pps} sliceStart={sliceStart} sliceEnd={sliceEnd} showWave={showWave} muted={muted} />
      )}

      <div className="pointer-events-none absolute left-1.5 top-1 flex max-w-[calc(100%-12px)] items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-zinc-100">
        {isText ? <Type className="h-3 w-3 shrink-0" /> : null}
        {media?.placeholder && <span className="shrink-0 rounded bg-violet-600 px-1 text-[9px] text-white">СОЛИХ</span>}
        <span className="truncate">{isText ? clip.text.split("\n")[0] : (media?.name ?? "…")}</span>
        {!isText && clip.speed !== 1 && <span className="shrink-0 text-amber-300">{clip.speed}x</span>}
        {clip.hidden && <EyeOff className="h-3 w-3 shrink-0 text-amber-300" />}
        {muted && <VolumeX className="h-3 w-3 shrink-0 text-red-400" />}
        {clip.type === "video" && clip.audioDetached && <Unlink className="h-3 w-3 shrink-0 text-sky-300" />}
      </div>

      {!track.locked && (
        <>
          <div
            onPointerDown={(e) => onPointerDown(e, clip, "trim-l")}
            className={cx("absolute inset-y-0 left-0 w-2 cursor-ew-resize", selected ? "bg-amber-400" : "hover:bg-amber-400/70")}
          />
          <div
            onPointerDown={(e) => onPointerDown(e, clip, "trim-r")}
            className={cx("absolute inset-y-0 right-0 w-2 cursor-ew-resize", selected ? "bg-amber-400" : "hover:bg-amber-400/70")}
          />
        </>
      )}
    </div>
  );
}

function ClipContent({
  clip,
  media,
  pps,
  sliceStart,
  sliceEnd,
  showWave,
  muted,
}: {
  clip: Exclude<Clip, { type: "text" }>;
  media: MediaItem;
  pps: number;
  sliceStart: number;
  sliceEnd: number;
  showWave: boolean;
  muted: boolean;
}) {
  const info = media.info;
  const srcDur = info?.duration ?? 1;
  const picture = clip.type === "video" && info?.isImage ? media.url : null;
  const film = clip.type === "video" ? thumbsUrl(media, "film") : null;
  const wave = showWave ? thumbsUrl(media, "wave") : null;
  const waveH = clip.type === "audio" ? 100 : 16; // percent / px
  const filmH = 58 - 2 - (wave ? waveH : 0);
  const aspect = info?.width && info?.height ? info.width / info.height : 16 / 9;
  const tileW = Math.max(16, filmH * aspect);
  const frames = Math.min(60, Math.max(8, Math.round(srcDur / 3)));
  // Width of the whole source file on the timeline at this zoom (for waveform positioning).
  const fullW = (srcDur / clip.speed) * pps;
  const inOffset = (clip.in / clip.speed) * pps;

  const tiles: { x: number; frame: number }[] = [];
  if (film) {
    const first = Math.floor(sliceStart / tileW);
    const last = Math.ceil(sliceEnd / tileW);
    for (let j = first; j < last; j++) {
      const centerT = clip.in + ((j + 0.5) * tileW * clip.speed) / pps;
      tiles.push({ x: j * tileW, frame: Math.min(frames - 1, Math.max(0, Math.floor((centerT / srcDur) * frames))) });
    }
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      {picture && (
        <div
          className="absolute top-0 bg-zinc-900 bg-repeat-x"
          style={{
            left: sliceStart,
            width: sliceEnd - sliceStart,
            height: filmH,
            backgroundImage: `url(${picture})`,
            backgroundSize: `${tileW}px ${filmH}px`,
            backgroundPosition: `${-sliceStart}px 0`,
          }}
        />
      )}
      {film &&
        tiles.map(({ x, frame }) => (
          <div
            key={x}
            className="absolute top-0 bg-zinc-800 bg-no-repeat"
            style={{
              left: x,
              width: tileW,
              height: filmH,
              backgroundImage: `url(${film})`,
              backgroundSize: `${frames * tileW}px ${filmH}px`,
              backgroundPosition: `${-frame * tileW}px 0`,
            }}
          />
        ))}
      {wave && (
        <div
          className={cx("absolute bottom-0 bg-no-repeat", muted && "opacity-30")}
          style={{
            left: sliceStart,
            width: sliceEnd - sliceStart,
            height: clip.type === "audio" ? "100%" : waveH,
            backgroundImage: `url(${wave})`,
            backgroundSize: `${fullW}px 100%`,
            backgroundPosition: `${-(inOffset + sliceStart)}px 0`,
          }}
        />
      )}
    </div>
  );
}
