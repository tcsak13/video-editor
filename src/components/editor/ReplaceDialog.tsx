"use client";

import { Music, Replace, Upload, Video, X } from "lucide-react";
import { useEffect } from "react";
import { filmstripFrames, thumbsUrl, type MediaItem } from "./media";
import { formatBytes, timecode } from "./store";

/** Pick the file that replaces a clip's media: anything in the library, or a new file. */
export default function ReplaceDialog({
  title,
  candidates,
  onPick,
  onPickFile,
  onClose,
}: {
  title: string;
  candidates: MediaItem[];
  onPick: (m: MediaItem) => void;
  onPickFile: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onPointerDown={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-bold text-white">
            <Replace className="h-5 w-5 text-violet-400" /> {title}
          </h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-zinc-500 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          <button
            type="button"
            onClick={onPickFile}
            className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-700 py-4 text-sm text-zinc-200 transition hover:border-violet-500 hover:bg-violet-500/10"
          >
            <Upload className="h-4 w-4" /> Компьютерээс файл сонгох
          </button>
          {candidates.length > 0 && <p className="pt-2 text-[11px] text-zinc-500">Эсвэл медиа сангаас:</p>}
          {candidates.map((m) => {
            const film = thumbsUrl(m, "film");
            const picture = m.info?.isImage ? m.url : null;
            const n = filmstripFrames(m.info?.duration ?? 10);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onPick(m)}
                className="flex w-full items-center gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 text-left transition hover:border-violet-500/70 hover:bg-violet-500/10"
              >
                <span
                  className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-800 bg-no-repeat"
                  style={
                    film
                      ? { backgroundImage: `url(${film})`, backgroundSize: `${n * 64}px 40px`, backgroundPosition: `-${Math.floor(n / 3) * 64}px 0` }
                      : picture
                        ? { backgroundImage: `url(${picture})`, backgroundSize: "contain", backgroundPosition: "center" }
                        : undefined
                  }
                >
                  {!film && !picture && (m.kind === "audio" ? <Music className="h-4 w-4 text-emerald-400" /> : <Video className="h-4 w-4 text-zinc-500" />)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-zinc-100">{m.name}</span>
                  <span className="block text-[11px] text-zinc-500">
                    {m.info?.isImage ? "Зураг" : m.info?.duration != null ? timecode(m.info.duration).replace(/\.\d+$/, "") : ""}
                    {m.info?.width ? ` · ${m.info.width}×${m.info.height}` : ""} · {formatBytes(m.size)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
