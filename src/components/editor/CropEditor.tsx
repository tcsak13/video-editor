"use client";

import { Check, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  aspectRatio,
  clampCrop,
  clipEnd,
  cropFromDisplay,
  cropToDisplay,
  sourceSize,
  type CanvasAspect,
  type Crop,
  type MediaClip,
} from "@/lib/timeline";
import { playableUrl, type MediaItem } from "./media";
import { cx } from "./store";

/** Crop rectangle in pixels of the on-screen (rotated + flipped) frame. */
type Rect = { x: number; y: number; w: number; h: number };
type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MIN_PX = 24;
const PAD = 28;
const TOOLBAR_H = 64;

type Ratio = { id: string; label: string; value: number | null };

/**
 * Full-frame crop editor: the whole source frame with a draggable crop box, rule-of-thirds
 * grid, corner/edge handles and aspect presets. Enter applies, Esc cancels.
 */
export default function CropEditor({
  clip,
  media,
  time,
  stageW,
  stageH,
  canvasAspect,
  onApply,
  onCancel,
}: {
  clip: MediaClip;
  media: MediaItem;
  time: number;
  stageW: number;
  stageH: number;
  canvasAspect: CanvasAspect;
  onApply: (crop: Crop, fitCanvas: boolean) => void;
  onCancel: () => void;
}) {
  const { w: srcW, h: srcH } = sourceSize(media.info, clip);
  const quarter = clip.rotate === 90 || clip.rotate === 270;
  const dispW = quarter ? srcH : srcW;
  const dispH = quarter ? srcW : srcH;
  const fit = Math.max(0.01, Math.min((stageW - PAD * 2) / dispW, (stageH - PAD * 2 - TOOLBAR_H) / dispH));
  const fw = dispW * fit;
  const fh = dispH * fit;

  // Rect is kept as fractions of the frame so it survives stage resizes.
  const [frac, setFrac] = useState(() => {
    const d = cropToDisplay(clip.crop, clip.rotate, clip.flipH, clip.flipV);
    return { x: d.l, y: d.t, w: 1 - d.l - d.r, h: 1 - d.t - d.b };
  });
  const [ratio, setRatio] = useState<string>("free");
  const [dragging, setDragging] = useState(false);
  const [fitCanvas, setFitCanvas] = useState(false);
  const rect: Rect = { x: frac.x * fw, y: frac.y * fh, w: frac.w * fw, h: frac.h * fh };

  const ratios: Ratio[] = [
    { id: "free", label: "Чөлөөт", value: null },
    { id: "canvas", label: `Канвас ${canvasAspect}`, value: aspectRatio(canvasAspect) },
    { id: "9:16", label: "9:16", value: 9 / 16 },
    { id: "16:9", label: "16:9", value: 16 / 9 },
    { id: "1:1", label: "1:1", value: 1 },
    { id: "4:5", label: "4:5", value: 4 / 5 },
    { id: "4:3", label: "4:3", value: 4 / 3 },
  ];
  const lock = ratios.find((r) => r.id === ratio)?.value ?? null;

  const commitRect = (r: Rect) => setFrac({ x: r.x / fw, y: r.y / fh, w: r.w / fw, h: r.h / fh });

  const apply = () => {
    const d: Crop = { l: frac.x, t: frac.y, r: 1 - frac.x - frac.w, b: 1 - frac.y - frac.h };
    const round = (v: number) => Math.round(Math.max(0, v) * 10000) / 10000;
    const c = cropFromDisplay(d, clip.rotate, clip.flipH, clip.flipV);
    onApply(clampCrop({ l: round(c.l), r: round(c.r), t: round(c.t), b: round(c.b) }), fitCanvas);
  };

  // Keyboard: Enter applies, Esc cancels (the editor's own shortcuts are suspended meanwhile).
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        applyRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const pickRatio = (r: Ratio) => {
    setRatio(r.id);
    if (r.value === null) return;
    // Largest box of that ratio that fits the frame, centred on the current box.
    let w = Math.min(fw, fh * r.value);
    let h = w / r.value;
    if (h > fh) {
      h = fh;
      w = h * r.value;
    }
    const cx0 = rect.x + rect.w / 2;
    const cy0 = rect.y + rect.h / 2;
    commitRect({
      x: Math.min(fw - w, Math.max(0, cx0 - w / 2)),
      y: Math.min(fh - h, Math.max(0, cy0 - h / 2)),
      w,
      h,
    });
  };

  const startDrag = (e: ReactPointerEvent, handle: Handle) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = rect;
    const x0 = e.clientX;
    const y0 = e.clientY;
    setDragging(true);
    const move = (ev: PointerEvent) => commitRect(dragRect(start, handle, ev.clientX - x0, ev.clientY - y0, fw, fh, lock));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Paused <video> showing the frame under the playhead (or the clip's first frame).
  const local = Math.min(Math.max(time, clip.start), clipEnd(clip) - 0.05) - clip.start;
  const frameTime = clip.in + local * clip.speed;
  const url = playableUrl(media);
  const innerW = quarter ? fh : fw;
  const innerH = quarter ? fw : fh;

  const pxW = Math.round(frac.w * dispW);
  const pxH = Math.round(frac.h * dispH);

  const edges: { h: Handle; cls: string; bar: string }[] = [
    { h: "n", cls: "left-1/2 top-0 h-5 w-10 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize", bar: "h-1 w-6" },
    { h: "s", cls: "left-1/2 bottom-0 h-5 w-10 -translate-x-1/2 translate-y-1/2 cursor-ns-resize", bar: "h-1 w-6" },
    { h: "w", cls: "top-1/2 left-0 h-10 w-5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize", bar: "h-6 w-1" },
    { h: "e", cls: "top-1/2 right-0 h-10 w-5 translate-x-1/2 -translate-y-1/2 cursor-ew-resize", bar: "h-6 w-1" },
  ];
  const corners: { h: Handle; cls: string; mark: string }[] = [
    { h: "nw", cls: "left-0 top-0 -translate-x-1 -translate-y-1 cursor-nwse-resize", mark: "border-l-4 border-t-4" },
    { h: "ne", cls: "right-0 top-0 translate-x-1 -translate-y-1 cursor-nesw-resize", mark: "border-r-4 border-t-4" },
    { h: "sw", cls: "left-0 bottom-0 -translate-x-1 translate-y-1 cursor-nesw-resize", mark: "border-l-4 border-b-4" },
    { h: "se", cls: "right-0 bottom-0 translate-x-1 translate-y-1 cursor-nwse-resize", mark: "border-r-4 border-b-4" },
  ];

  return (
    <div
      className="absolute inset-0 z-[2000] flex flex-col items-center justify-center bg-[#101015]"
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="relative select-none" style={{ width: fw, height: fh, marginBottom: TOOLBAR_H }}>
        {/* Whole frame, oriented exactly like the clip */}
        <div className="absolute inset-0 overflow-hidden bg-black">
          {url && (
            <div
              className="absolute left-1/2 top-1/2"
              style={{
                width: innerW,
                height: innerH,
                transform: `translate(-50%, -50%) scale(${clip.flipH ? -1 : 1}, ${clip.flipV ? -1 : 1}) rotate(${clip.rotate}deg)`,
              }}
            >
              {media.info?.isImage ? (
                // eslint-disable-next-line @next/next/no-img-element -- local preview URL
                <img src={url} alt="" draggable={false} className="pointer-events-none h-full w-full max-w-none object-fill" />
              ) : (
                <video
                  src={url}
                  muted
                  playsInline
                  preload="auto"
                  onLoadedMetadata={(e) => {
                    e.currentTarget.currentTime = frameTime;
                  }}
                  className="pointer-events-none h-full w-full max-w-none object-fill"
                />
              )}
            </div>
          )}
        </div>

        {/* Crop box: the huge shadow dims everything outside it */}
        <div
          data-crop-box
          onPointerDown={(e) => startDrag(e, "move")}
          className="absolute cursor-move border border-white/90"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, boxShadow: "0 0 0 100vmax rgba(8,8,12,0.68)" }}
        >
          <div className={cx("pointer-events-none absolute inset-0 transition-opacity", dragging ? "opacity-100" : "opacity-70")}>
            <div className="absolute inset-y-0 left-1/3 w-px bg-white/60" />
            <div className="absolute inset-y-0 left-2/3 w-px bg-white/60" />
            <div className="absolute inset-x-0 top-1/3 h-px bg-white/60" />
            <div className="absolute inset-x-0 top-2/3 h-px bg-white/60" />
          </div>
          {corners.map((c) => (
            <div key={c.h} data-handle={c.h} onPointerDown={(e) => startDrag(e, c.h)} className={cx("absolute h-6 w-6", c.cls)}>
              <div
                className={cx(
                  "absolute h-5 w-5 border-white",
                  c.mark,
                  c.h.includes("n") ? "top-0" : "bottom-0",
                  c.h.includes("w") ? "left-0" : "right-0",
                )}
              />
            </div>
          ))}
          {edges.map((ed) => (
            <div
              key={ed.h}
              data-handle={ed.h}
              onPointerDown={(e) => startDrag(e, ed.h)}
              className={cx("absolute flex items-center justify-center", ed.cls)}
            >
              <div className={cx("rounded-full bg-white shadow", ed.bar)} />
            </div>
          ))}
          <div className="pointer-events-none absolute -top-7 left-0 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200">
            {pxW} × {pxH}
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-center gap-2 px-3 pb-3">
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-950/95 p-1">
          {ratios.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => pickRatio(r)}
              className={cx(
                "rounded-lg px-2.5 py-1.5 text-xs transition",
                ratio === r.id ? "bg-violet-600 text-white" : "text-zinc-300 hover:bg-zinc-800",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-950/95 p-1">
          <button
            type="button"
            title="Бүтэн кадр руу буцаах"
            onClick={() => {
              setRatio("free");
              setFrac({ x: 0, y: 0, w: 1, h: 1 });
            }}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Сэргээх
          </button>
          <button
            type="button"
            title="Болих (Esc)"
            onClick={onCancel}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            <X className="h-3.5 w-3.5" /> Болих
          </button>
          <button
            type="button"
            title="Хэрэглэхэд канвас тайрсан хэсгийн яг өргөн/өндөртэй болно"
            aria-pressed={fitCanvas}
            onClick={() => setFitCanvas((f) => !f)}
            className={cx(
              "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition",
              fitCanvas ? "bg-violet-600 text-white" : "text-zinc-300 hover:bg-zinc-800",
            )}
          >
            <span className={cx("flex h-3.5 w-3.5 items-center justify-center rounded border", fitCanvas ? "border-white" : "border-zinc-500")}>
              {fitCanvas && <Check className="h-3 w-3" />}
            </span>
            Канвасыг тааруулах
          </button>
          <button
            type="button"
            title="Хэрэглэх (Enter)"
            onClick={apply}
            className="flex items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-bold text-zinc-950 hover:bg-amber-300"
          >
            <Check className="h-3.5 w-3.5" /> Хэрэглэх
          </button>
        </div>
      </div>
    </div>
  );
}

/** New crop box after dragging `handle` by (dx, dy); `lock` keeps a width/height ratio. */
function dragRect(s: Rect, handle: Handle, dx: number, dy: number, W: number, H: number, lock: number | null): Rect {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  if (handle === "move") {
    return { ...s, x: clamp(s.x + dx, 0, W - s.w), y: clamp(s.y + dy, 0, H - s.h) };
  }
  const n = handle.includes("n");
  const sth = handle.includes("s");
  const w = handle.includes("w");
  const e = handle.includes("e");

  if (lock === null) {
    let left = s.x;
    let top = s.y;
    let right = s.x + s.w;
    let bottom = s.y + s.h;
    if (w) left = clamp(left + dx, 0, right - MIN_PX);
    if (e) right = clamp(right + dx, left + MIN_PX, W);
    if (n) top = clamp(top + dy, 0, bottom - MIN_PX);
    if (sth) bottom = clamp(bottom + dy, top + MIN_PX, H);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  const a = lock;
  const minW = Math.max(MIN_PX, MIN_PX * a);
  if ((n || sth) && (w || e)) {
    // Corner: the opposite corner stays put.
    const ax = e ? s.x : s.x + s.w;
    const ay = sth ? s.y : s.y + s.h;
    const px = (e ? s.x + s.w : s.x) + dx;
    const py = (sth ? s.y + s.h : s.y) + dy;
    const maxW = Math.min(e ? W - ax : ax, (sth ? H - ay : ay) * a);
    const nw = clamp(Math.max((e ? px - ax : ax - px), (sth ? py - ay : ay - py) * a), minW, maxW);
    const nh = nw / a;
    return { x: e ? ax : ax - nw, y: sth ? ay : ay - nh, w: nw, h: nh };
  }
  if (w || e) {
    // Side edge: the opposite edge stays put, height grows around the centre line.
    const ax = e ? s.x : s.x + s.w;
    const cy = s.y + s.h / 2;
    const maxW = Math.min(e ? W - ax : ax, 2 * Math.min(cy, H - cy) * a);
    const nw = clamp(e ? s.x + s.w + dx - ax : ax - (s.x + dx), minW, maxW);
    const nh = nw / a;
    return { x: e ? ax : ax - nw, y: cy - nh / 2, w: nw, h: nh };
  }
  // Top/bottom edge.
  const ay = sth ? s.y : s.y + s.h;
  const cx0 = s.x + s.w / 2;
  const maxH = Math.min(sth ? H - ay : ay, (2 * Math.min(cx0, W - cx0)) / a);
  const nh = clamp(sth ? s.y + s.h + dy - ay : ay - (s.y + dy), minW / a, maxH);
  const nw = nh * a;
  return { x: cx0 - nw / 2, y: sth ? ay : ay - nh, w: nw, h: nh };
}
