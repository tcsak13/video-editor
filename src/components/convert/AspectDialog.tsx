"use client";

import { Clapperboard, FileVideo, Loader2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cx } from "@/components/editor/store";
import FolderPicker from "@/components/merge/FolderPicker";
import { ASPECT_PRESETS, aspectLabel, type ConvertQuality } from "@/lib/convert";
import type { FsFile } from "@/lib/merge";

const HEIGHT_MIN = 50;
const HEIGHT_MAX = 170;

/** Output size the server will pick for this shape: short side at the chosen quality (ignores "never upscale"). */
function outSize(aspect: number, quality: ConvertQuality): string {
  const short = Number(quality);
  const even = (n: number) => Math.round(n / 2) * 2;
  return aspect >= 1 ? `${even(short * aspect)}×${short}` : `${short}×${even(short / aspect)}`;
}

/**
 * Shows a frame of a film as it is and as it will come out, so a stretched picture can be fixed
 * by eye: pick the shape it should have, or drag its height until faces look right.
 */
export default function AspectDialog({
  initialFile,
  initialDir,
  initialAspect,
  quality,
  convertLabel,
  onConvert,
  onApplyAll,
  onClose,
}: {
  initialFile: FsFile | null;
  initialDir: string;
  initialAspect: number | null;
  quality: ConvertQuality;
  /** Text of the main button; with `onConvert` it converts just this film. */
  convertLabel?: string;
  onConvert?: (file: FsFile, aspect: number | null) => void;
  onApplyAll: (aspect: number | null) => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<FsFile | null>(initialFile);
  const [picking, setPicking] = useState(!initialFile);
  const [at, setAt] = useState(0.3);
  const [frameAt, setFrameAt] = useState(0.3);
  const [source, setSource] = useState<number | null>(null);
  const [aspect, setAspect] = useState<number | null>(initialAspect);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const src = file ? `/api/convert/frame?path=${encodeURIComponent(file.path)}&at=${frameAt}` : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !picking) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, picking]);

  const showFrame = (next: number) => {
    if (next === frameAt) return;
    setLoading(true);
    setFrameAt(next);
  };

  const shape = aspect ?? source ?? 16 / 9;
  const height = source ? Math.round((source / shape) * 100) : 100;
  const setHeight = (pct: number) => source && setAspect(Math.abs(pct - 100) < 0.5 ? null : source / (pct / 100));
  const changed = aspect !== null && (!source || Math.abs(aspect - source) > 0.005);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-5 py-3.5">
          <h2 className="text-base font-semibold text-white">Харьцаа засах — сунасан бичлэг</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mb-4 flex items-center gap-3">
            <FileVideo className="h-4 w-4 shrink-0 text-sky-400" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-zinc-200" title={file?.path}>
              {file?.name ?? "Кино сонгоогүй"}
            </span>
            <button type="button" onClick={() => setPicking(true)} className="shrink-0 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 transition hover:bg-zinc-700">
              {file ? "Өөр кино" : "Кино сонгох"}
            </button>
          </div>

          {error && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

          {src && (
            <div className="grid gap-4 md:grid-cols-[1fr_1.6fr]">
              <figure>
                <figcaption className="mb-1.5 text-xs text-zinc-500">Одоо{source ? ` · ${aspectLabel(source)}` : ""}</figcaption>
                <div className="flex aspect-video items-center justify-center rounded-lg bg-black">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local ffmpeg frame, not a static asset */}
                  <img
                    src={src}
                    alt=""
                    className="max-h-full max-w-full"
                    onLoad={(e) => {
                      setLoading(false);
                      setError(null);
                      setSource(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight);
                    }}
                    onError={() => {
                      setLoading(false);
                      setError("Энэ файлаас кадр гаргаж чадсангүй.");
                    }}
                  />
                </div>
              </figure>
              <figure>
                <figcaption className="mb-1.5 flex justify-between text-xs">
                  <span className={changed ? "text-violet-300" : "text-zinc-500"}>
                    Зассан · {aspectLabel(shape)} · өндөр {height}%
                  </span>
                  <span className="font-mono text-zinc-500">{outSize(shape, quality)}</span>
                </figcaption>
                <div className="relative flex aspect-video items-center justify-center rounded-lg bg-black">
                  {/* The frame forced into the new shape: what the film will look like. */}
                  <div className="relative max-h-full max-w-full" style={{ aspectRatio: String(shape), height: shape >= 16 / 9 ? "auto" : "100%", width: shape >= 16 / 9 ? "100%" : "auto" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- same frame, stretched */}
                    <img src={src} alt="" className="absolute inset-0 h-full w-full" />
                  </div>
                  {loading && <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-zinc-400" />}
                </div>
              </figure>
            </div>
          )}

          {src && (
            <div className="mt-5 space-y-4">
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Зөв хэлбэр</div>
                <div className="flex flex-wrap gap-2">
                  <Chip on={!changed} onClick={() => setAspect(null)}>
                    Эх хэвээр
                  </Chip>
                  {ASPECT_PRESETS.map((p) => (
                    <Chip key={p.label} on={changed && Math.abs(shape - p.value) < 0.005} onClick={() => setAspect(p.value)}>
                      {p.label}
                    </Chip>
                  ))}
                </div>
              </div>
              <label className="block">
                <div className="mb-1.5 flex justify-between text-xs text-zinc-400">
                  <span>Өндөр — нүүр, бие хэвийн харагдтал чирнэ</span>
                  <span className="font-mono text-zinc-300">{height}%</span>
                </div>
                <input type="range" min={HEIGHT_MIN} max={HEIGHT_MAX} step={1} value={height} disabled={!source} onChange={(e) => setHeight(Number(e.target.value))} className="w-full accent-violet-500" />
                <div className="flex justify-between text-[11px] text-zinc-600">
                  <span>← намхан, өргөн</span>
                  <span>өндөр, нарийн →</span>
                </div>
              </label>
              <label className="block">
                <div className="mb-1.5 flex justify-between text-xs text-zinc-400">
                  <span>Кадр (хүн харагдах хэсгийг сонгоорой)</span>
                  <span className="font-mono text-zinc-300">{Math.round(at * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={0.95}
                  step={0.01}
                  value={at}
                  onChange={(e) => setAt(Number(e.target.value))}
                  onPointerUp={() => showFrame(at)}
                  onKeyUp={() => showFrame(at)}
                  className="w-full accent-violet-500"
                />
              </label>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 transition hover:text-white">
            Болих
          </button>
          <button
            type="button"
            onClick={() => onApplyAll(changed ? aspect : null)}
            className={cx(
              "rounded-lg px-3 py-1.5 text-sm transition",
              onConvert ? "border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white" : "bg-violet-600 font-semibold text-white hover:bg-violet-500",
            )}
          >
            {onConvert ? "Цаашид нэмэх бүх файлд" : "Хэрэглэх"}
          </button>
          {onConvert && (
            <button
              type="button"
              disabled={!file}
              onClick={() => file && onConvert(file, changed ? aspect : null)}
              className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-40"
            >
              <Clapperboard className="h-4 w-4" /> {convertLabel ?? "Засаад хөрвүүлэх"}
            </button>
          )}
        </div>
      </div>

      {picking && (
        <FolderPicker
          title="Харьцааг нь шалгах кино"
          initial={file ? file.path.slice(0, Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\")) + 1) : initialDir}
          picked={file ? new Set([file.path]) : undefined}
          onClose={() => setPicking(false)}
          onPickFile={(f) => {
            if (f.path !== file?.path) setLoading(true);
            setFile(f);
            setSource(null);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx("rounded-lg border px-3 py-1.5 text-sm transition", on ? "border-violet-500 bg-violet-500/15 text-white" : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600")}
    >
      {children}
    </button>
  );
}
