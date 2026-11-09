"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  TEXT_LINE_HEIGHT,
  aspectRatio,
  clipBoxSize,
  clipEnd,
  frameGeometry,
  type Crop,
  type MediaClip,
  type Project,
  type TextClip,
} from "@/lib/timeline";
import { cssFontFamily } from "@/lib/fonts";
import { handles, transitionLook, transitionPlan, type ClipTransitions } from "@/lib/transitions";
import CropEditor from "./CropEditor";
import { playableUrl, type MediaItem } from "./media";
import { cx, useClockTime, type Clock } from "./store";

type Props = {
  project: Project;
  media: Map<string, MediaItem>;
  clock: Clock;
  selected: string[];
  onSelect: (id: string | null) => void;
  onChangeClip: (id: string, patch: Partial<MediaClip> | Partial<TextClip>, mergeKey: string) => void;
  onMediaError: (mediaId: string) => void;
  onContextMenu: (x: number, y: number, clipId: string) => void;
  /** Clip being cropped (and the playhead when cropping started), or null. */
  crop: { clipId: string; time: number } | null;
  onCropApply: (clipId: string, crop: Crop, fitCanvas: boolean) => void;
  onCropCancel: () => void;
  /** A template slot was clicked: pick the video that goes there. */
  onFillPlaceholder: (clipId: string) => void;
};

const SNAP = 0.015; // fraction of the canvas

export default function Preview({
  project,
  media,
  clock,
  selected,
  onSelect,
  onChangeClip,
  onMediaError,
  onContextMenu,
  crop,
  onCropApply,
  onCropCancel,
  onFillPlaceholder,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 800, h: 450 });
  const elements = useRef(new Map<string, HTMLMediaElement>());
  const boxes = useRef(new Map<string, HTMLElement>());
  const projectRef = useRef(project);
  const planCache = useRef<{ clips: Project["clips"] | null; plan: Map<string, ClipTransitions> }>({ clips: null, plan: new Map() });
  const sizeRef = useRef({ cw: 1, ch: 1 });
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStage({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ar = aspectRatio(project.aspect);
  const cw = Math.max(1, Math.min(stage.w, stage.h * ar));
  const ch = cw / ar;
  const trackIndex = new Map(project.tracks.map((t, i) => [t.id, i]));
  const tracks = new Map(project.tracks.map((t) => [t.id, t]));
  const z = (trackId: string) => (project.tracks.length - (trackIndex.get(trackId) ?? 0)) * 10;

  useEffect(() => {
    sizeRef.current = { cw, ch };
  }, [cw, ch]);

  // Keep every media element in step with the clock (runs on each tick, outside React).
  const sync = useCallback(() => {
    const p = projectRef.current;
    const t = clock.time;
    const playing = clock.playing;
    const trackById = new Map(p.tracks.map((tr) => [tr.id, tr]));
    if (planCache.current.clips !== p.clips) planCache.current = { clips: p.clips, plan: transitionPlan(p.clips) };
    const { cw: w, ch: h } = sizeRef.current;

    for (const clip of p.clips) {
      const track = trackById.get(clip.trackId);
      const start = clip.start;
      const end = clipEnd(clip);
      const tr = clip.type === "video" ? planCache.current.plan.get(clip.id) : undefined;
      // A cross transition keeps the clip on screen a little before its start and after its end.
      const { pre, post } = handles(tr);
      const active = t >= start - pre && t < end + post;
      const box = boxes.current.get(clip.id);
      if (box) box.style.visibility = active && !track?.hidden && !clip.hidden ? "visible" : "hidden";
      if (clip.type === "text") continue;
      if (box && clip.type === "video") {
        const look = transitionLook(tr, t);
        box.style.opacity = String(clip.opacity * look.alpha);
        box.style.transform = look.dx || look.dy ? `translate(${look.dx * w}px, ${look.dy * h}px)` : "";
        const tint = box.querySelector<HTMLElement>("[data-tint]");
        if (tint) {
          tint.style.background = look.tint?.color ?? "black";
          tint.style.opacity = String(look.tint?.amount ?? 0);
        }
      }

      const el = elements.current.get(clip.id);
      if (!el) continue;
      const local = t - start;
      const desired = Math.max(0, clip.in + local * clip.speed);
      // Sound still cuts at the clip's own edges, even while a transition shows the picture.
      const audible = !clip.muted && !track?.muted && !(clip.type === "video" && clip.audioDetached) && t >= start && t < end;
      const dur = end - start;
      let gain = Math.min(1, clip.volume);
      if (clip.fadeIn > 0) gain *= Math.min(1, local / clip.fadeIn);
      if (clip.fadeOut > 0) gain *= Math.min(1, Math.max(0, (dur - local) / clip.fadeOut));
      el.muted = !audible;
      el.volume = Math.max(0, Math.min(1, gain));
      if (el.playbackRate !== clip.speed) el.playbackRate = clip.speed;

      if (active) {
        if (playing) {
          if (el.paused) {
            el.currentTime = desired;
            void el.play().catch(() => {});
          } else if (Math.abs(el.currentTime - desired) > 0.3) {
            el.currentTime = desired;
          }
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - desired) > 0.04 && !el.seeking) el.currentTime = desired;
        }
      } else {
        if (!el.paused) el.pause();
        // Pre-roll the next clip so the cut is seamless.
        const first = Math.max(0, clip.in - pre * clip.speed);
        if (t < start - pre && start - pre - t < 2 && Math.abs(el.currentTime - first) > 0.1 && !el.seeking) el.currentTime = first;
      }
    }
  }, [clock]);

  useEffect(() => {
    sync();
    return clock.subscribe(sync);
  }, [clock, sync, project, media]);

  const setElement = (id: string) => (el: HTMLMediaElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  };
  const setBox = (id: string) => (el: HTMLElement | null) => {
    if (el) boxes.current.set(id, el);
    else boxes.current.delete(id);
  };

  // --- drag to move / corner-drag to scale -------------------------------------------
  const startMove = (e: ReactPointerEvent, clip: MediaClip | TextClip) => {
    if (e.button !== 0) {
      // Right/middle button: just select (the context menu opens on `contextmenu`).
      e.stopPropagation();
      if (!selected.includes(clip.id)) onSelect(clip.id);
      return;
    }
    if (tracks.get(clip.trackId)?.locked) return;
    e.stopPropagation();
    onSelect(clip.id);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const ox = clip.x;
    const oy = clip.y;
    const move = (ev: PointerEvent) => {
      let x = ox + (ev.clientX - x0) / cw;
      let y = oy + (ev.clientY - y0) / ch;
      const v = Math.abs(x - 0.5) < SNAP;
      const h = Math.abs(y - 0.5) < SNAP;
      if (v) x = 0.5;
      if (h) y = 0.5;
      setGuides({ v, h });
      onChangeClip(clip.id, { x, y }, `move:${clip.id}`);
    };
    const up = () => {
      setGuides({ v: false, h: false });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startScale = (e: ReactPointerEvent, clip: MediaClip) => {
    e.stopPropagation();
    const rect = stageRef.current!.querySelector("[data-canvas]")!.getBoundingClientRect();
    const cx0 = rect.left + clip.x * cw;
    const cy0 = rect.top + clip.y * ch;
    const d0 = Math.hypot(e.clientX - cx0, e.clientY - cy0) || 1;
    const s0 = clip.scale;
    const move = (ev: PointerEvent) => {
      const d = Math.hypot(ev.clientX - cx0, ev.clientY - cy0);
      let scale = Math.max(0.05, (s0 * d) / d0);
      if (Math.abs(scale - 1) < 0.03) scale = 1; // snap back to "fit"
      onChangeClip(clip.id, { scale }, `scale:${clip.id}`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const selectedClip = selected.length === 1 ? project.clips.find((c) => c.id === selected[0]) : undefined;
  const openMenu = (e: ReactMouseEvent, clipId: string) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e.clientX, e.clientY, clipId);
  };
  const cropClip = crop ? project.clips.find((c): c is MediaClip => c.id === crop.clipId && c.type === "video") : undefined;
  const cropMedia = cropClip ? media.get(cropClip.mediaId) : undefined;

  return (
    <div ref={stageRef} className="relative flex h-full w-full items-center justify-center overflow-hidden" onPointerDown={() => onSelect(null)}>
      <div
        data-canvas
        className="relative isolate overflow-hidden shadow-2xl shadow-black/60"
        style={{ width: cw, height: ch, background: project.background }}
      >
        {project.clips.map((clip) => {
          if (clip.type === "text") return null;
          const m = media.get(clip.mediaId);
          const url = m ? playableUrl(m) : null;
          if (m?.placeholder && m.info && clip.type === "video") {
            const box = clipBoxSize(m.info.width ?? 16, m.info.height ?? 9, clip, cw, ch);
            return (
              <div
                key={clip.id}
                ref={setBox(clip.id)}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelect(clip.id);
                }}
                onContextMenu={(e) => openMenu(e, clip.id)}
                className="absolute flex flex-col items-center justify-center gap-2 border-2 border-dashed border-violet-400/70 bg-violet-950/40 text-center"
                style={{
                  left: clip.x * cw - box.w / 2,
                  top: clip.y * ch - box.h / 2,
                  width: box.w,
                  height: box.h,
                  zIndex: z(clip.trackId),
                  visibility: "hidden",
                }}
              >
                <span className="px-2 text-xs text-violet-200">Template-ийн бичлэг</span>
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onFillPlaceholder(clip.id)}
                  className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
                >
                  Бичлэг сонгох
                </button>
              </div>
            );
          }
          if (!m || !url) return null;

          if (clip.type === "audio" || !m.info?.hasVideo) {
            return (
              <audio key={clip.id} ref={setElement(clip.id)} src={url} preload="auto" onError={() => onMediaError(m.id)} />
            );
          }

          const srcW = m.info.width ?? 16;
          const srcH = m.info.height ?? 9;
          const box = clipBoxSize(srcW, srcH, clip, cw, ch);
          const quarter = clip.rotate === 90 || clip.rotate === 270;
          const innerW = quarter ? box.h : box.w;
          const innerH = quarter ? box.w : box.h;
          const { l, r, t, b } = clip.crop;
          const fullW = innerW / (1 - l - r);
          const fullH = innerH / (1 - t - b);
          const fg = frameGeometry(box.w, box.h, clip.frame);
          const cardColor = clip.frame ? clip.frame.color + Math.round(clip.frame.opacity * 255).toString(16).padStart(2, "0") : "";
          return (
            <div
              key={clip.id}
              ref={setBox(clip.id)}
              onPointerDown={(e) => startMove(e, clip)}
              onContextMenu={(e) => openMenu(e, clip.id)}
              className="absolute cursor-move"
              style={{
                left: clip.x * cw - box.w / 2,
                top: clip.y * ch - box.h / 2,
                width: box.w,
                height: box.h,
                // A clip with an incoming transition draws over the one it replaces on the same track.
                zIndex: z(clip.trackId) + (clip.transition ? 1 : 0),
                opacity: clip.opacity,
                visibility: "hidden",
              }}
            >
              {fg.hasBg && (
                <div className="pointer-events-none absolute" style={{ inset: -fg.pad, borderRadius: fg.outerR, background: cardColor }} />
              )}
              <div
                data-tint
                className="pointer-events-none absolute z-10"
                style={{ inset: -fg.pad, borderRadius: fg.hasBg ? fg.outerR : fg.innerR, opacity: 0 }}
              />
              <div className="absolute inset-0 overflow-hidden" style={{ borderRadius: fg.innerR }}>
                <div
                  className="absolute left-1/2 top-1/2 overflow-hidden"
                  style={{
                    width: innerW,
                    height: innerH,
                    transform: `translate(-50%, -50%) scale(${clip.flipH ? -1 : 1}, ${clip.flipV ? -1 : 1}) rotate(${clip.rotate}deg)`,
                  }}
                >
                  {m.info.isImage ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local blob/preview URL, drawn with crop offsets
                    <img
                      src={url}
                      alt=""
                      draggable={false}
                      className="pointer-events-none absolute max-w-none object-fill"
                      style={{ width: fullW, height: fullH, left: -l * fullW, top: -t * fullH }}
                    />
                  ) : (
                    <video
                      ref={setElement(clip.id)}
                      src={url}
                      preload="auto"
                      playsInline
                      onError={() => onMediaError(m.id)}
                      className="pointer-events-none absolute max-w-none object-fill"
                      style={{ width: fullW, height: fullH, left: -l * fullW, top: -t * fullH }}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {project.clips.map((clip) =>
          clip.type === "text" ? (
            <div
              key={clip.id}
              ref={setBox(clip.id)}
              onPointerDown={(e) => startMove(e, clip)}
              onContextMenu={(e) => openMenu(e, clip.id)}
              className={cx(
                "absolute cursor-move whitespace-pre text-center",
                selected.includes(clip.id) && "outline-2 outline-offset-4 outline-amber-400",
              )}
              style={{
                left: clip.x * cw,
                top: clip.y * ch,
                transform: "translate(-50%, -50%)",
                zIndex: 1000,
                visibility: "hidden",
                ...textStyle(clip, ch),
              }}
            >
              {clip.text.split("\n").map((line, i) => (
                <div key={i}>
                  <span style={lineStyle(clip, ch)}>{line || " "}</span>
                </div>
              ))}
            </div>
          ) : null,
        )}

        {guides.v && <div className="pointer-events-none absolute inset-y-0 left-1/2 z-[1100] w-px bg-fuchsia-400" />}
        {guides.h && <div className="pointer-events-none absolute inset-x-0 top-1/2 z-[1100] h-px bg-fuchsia-400" />}

        {selectedClip && selectedClip.type === "video" && !cropClip && (
          <SelectionBox clip={selectedClip} media={media.get(selectedClip.mediaId)} clock={clock} cw={cw} ch={ch} onScaleStart={startScale} />
        )}
      </div>

      {cropClip && cropMedia?.info && crop && (
        <CropEditor
          key={cropClip.id}
          clip={cropClip}
          media={cropMedia}
          time={crop.time}
          stageW={stage.w}
          stageH={stage.h}
          canvasAspect={project.aspect}
          onApply={(c, fit) => onCropApply(cropClip.id, c, fit)}
          onCancel={onCropCancel}
        />
      )}

      {project.clips.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
          Медиа нэмээд timeline руу чирнэ үү
        </div>
      )}
    </div>
  );
}

function textStyle(clip: TextClip, ch: number): CSSProperties {
  const size = clip.size * ch;
  return {
    fontFamily: cssFontFamily(clip.font),
    fontWeight: clip.bold ? 700 : 400,
    fontSize: size,
    lineHeight: TEXT_LINE_HEIGHT,
    color: clip.color,
    ...(clip.style === "outline"
      ? { WebkitTextStroke: `${Math.max(1, size / 14) * 2}px black`, paintOrder: "stroke fill" }
      : clip.style === "plain"
        ? { textShadow: "2px 2px 2px rgba(0,0,0,.6)" }
        : {}),
  };
}

function lineStyle(clip: TextClip, ch: number): CSSProperties {
  if (clip.style !== "box") return {};
  const pad = clip.size * ch * 0.25;
  return { background: "rgba(0,0,0,.55)", padding: `0 ${pad}px`, boxDecorationBreak: "clone" };
}

/** Yellow bounding box with corner handles, shown while the selected clip is on screen. */
function SelectionBox({
  clip,
  media,
  clock,
  cw,
  ch,
  onScaleStart,
}: {
  clip: MediaClip;
  media: MediaItem | undefined;
  clock: Clock;
  cw: number;
  ch: number;
  onScaleStart: (e: ReactPointerEvent, clip: MediaClip) => void;
}) {
  const t = useClockTime(clock);
  if (!media?.info || t < clip.start || t >= clipEnd(clip)) return null;
  const box = clipBoxSize(media.info.width ?? 16, media.info.height ?? 9, clip, cw, ch);
  const corners = [
    ["-left-1.5 -top-1.5", "cursor-nwse-resize"],
    ["-right-1.5 -top-1.5", "cursor-nesw-resize"],
    ["-left-1.5 -bottom-1.5", "cursor-nesw-resize"],
    ["-right-1.5 -bottom-1.5", "cursor-nwse-resize"],
  ];
  return (
    <div
      className="pointer-events-none absolute border-2 border-amber-400"
      style={{ left: clip.x * cw - box.w / 2, top: clip.y * ch - box.h / 2, width: box.w, height: box.h, zIndex: 1050 }}
    >
      {corners.map(([pos, cursor]) => (
        <div
          key={pos}
          onPointerDown={(e) => onScaleStart(e, clip)}
          className={cx("pointer-events-auto absolute h-3 w-3 rounded-full border-2 border-amber-400 bg-zinc-950", pos, cursor)}
        />
      ))}
    </div>
  );
}
