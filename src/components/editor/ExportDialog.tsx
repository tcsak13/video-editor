"use client";

import { AlertTriangle, CheckCircle2, Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CRF_VALUES, type Encoder, type ProcessEvent } from "@/lib/editor-options";
import {
  EXPORT_FORMATS,
  EXPORT_RESOLUTIONS,
  canvasSize,
  projectDuration,
  type ExportSettings,
  type Project,
  type RenderRequest,
} from "@/lib/timeline";
import { readNdjson, type MediaItem } from "./media";
import { cx, formatBytes, timecode } from "./store";

type DoneEvent = Extract<ProcessEvent, { type: "done" }>;

const SETTINGS_KEY = "lve-export-settings";
const DEFAULT_SETTINGS: ExportSettings = { resolution: "720", crf: 23, encoder: "auto", format: "mp4" };

function loadSettings(): ExportSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const ENCODER_INFO: Record<Encoder, { label: string; hint: string }> = {
  auto: { label: "Автомат", hint: "Mac → Apple GPU, бусад → CPU" },
  videotoolbox: { label: "Apple GPU", hint: "h264_videotoolbox — маш хурдан" },
  cpu: { label: "CPU", hint: "libx264 veryfast — хамгийн жижиг файл" },
  nvenc: { label: "NVIDIA GPU", hint: "h264_nvenc" },
};

const CRF_LABELS: Record<number, string> = {
  23: "Оновчтой (CRF 23)",
  20: "Өндөр чанар (CRF 20)",
  27: "Их шахалт (CRF 27)",
};

export function triggerDownload(jobId: string, name: string) {
  const a = document.createElement("a");
  a.href = `/api/download?job=${jobId}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

type Props = {
  open: boolean;
  onClose: () => void;
  project: Project;
  mediaList: MediaItem[];
  encoders: Record<Encoder, boolean> | null;
  isMac: boolean;
};

export default function ExportDialog({ open, onClose, project, mediaList, encoders, isMac }: Props) {
  const [settings, setSettings] = useState<ExportSettings>(loadSettings);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [percent, setPercent] = useState<number | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const [encoderUsed, setEncoderUsed] = useState<Encoder | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<DoneEvent | null>(null);
  const [error, setError] = useState<{ message: string; log?: string } | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings]);

  useEffect(() => {
    if (phase !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [phase]);

  if (!open) return null;

  const duration = projectDuration(project.clips);
  const size = canvasSize(project.aspect, Number(settings.resolution));
  const pending = mediaList.some((m) => !m.source && project.clips.some((c) => c.type !== "text" && c.mediaId === m.id));
  const set = <K extends keyof ExportSettings>(k: K, v: ExportSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  const start = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    setPercent(null);
    setSpeed(null);
    setNotice(null);
    setResult(null);
    setError(null);
    setStartedAt(Date.now());
    setNow(Date.now());

    const used = new Set(project.clips.flatMap((c) => (c.type === "text" ? [] : [c.mediaId])));
    const body: RenderRequest = {
      project,
      media: mediaList.filter((m) => used.has(m.id) && m.source).map((m) => ({ id: m.id, source: m.source! })),
      settings,
    };
    try {
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Серверийн алдаа (${res.status})`);
      let finished = false;
      await readNdjson<ProcessEvent>(res, (e) => {
        if (e.type === "start") setEncoderUsed(e.encoder);
        if (e.type === "progress") {
          setPercent(e.percent);
          setSpeed(e.speed);
        }
        if (e.type === "fallback") setNotice(`${ENCODER_INFO[e.from].label} ажиллахгүй байсан тул CPU руу шилжлээ.`);
        if (e.type === "done") {
          finished = true;
          setResult(e);
          setPhase("done");
          triggerDownload(e.jobId, e.outputName);
        }
        if (e.type === "error") {
          finished = true;
          setError({ message: e.message, log: e.log });
          setPhase("error");
        }
      });
      if (!finished) throw new Error("Сервертэй холболт тасарлаа.");
    } catch (err) {
      if (controller.signal.aborted) setPhase("idle");
      else {
        setError({ message: err instanceof Error ? err.message : String(err) });
        setPhase("error");
      }
    } finally {
      abortRef.current = null;
    }
  };

  const elapsed = phase === "running" ? (now - startedAt) / 1000 : 0;
  const eta = percent && percent > 1 ? (elapsed * (100 - percent)) / percent : null;
  const autoHint = isMac && encoders?.videotoolbox ? "Энэ Mac → Apple GPU (VideoToolbox)" : "Энэ компьютер → CPU";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onPointerDown={() => phase !== "running" && onClose()}>
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl" onPointerDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Экспорт</h2>
          <button type="button" onClick={onClose} disabled={phase === "running"} className="rounded-lg p-1 text-zinc-500 hover:text-white disabled:opacity-30">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <Row label="Нарийвчлал">
            {EXPORT_RESOLUTIONS.map((r) => (
              <Chip key={r} active={settings.resolution === r} onClick={() => set("resolution", r)}>
                {r}p{r === "720" && " ★"}
              </Chip>
            ))}
          </Row>
          <Row label="Чанар">
            {CRF_VALUES.map((c) => (
              <Chip key={c} active={settings.crf === c} onClick={() => set("crf", c)}>
                {CRF_LABELS[c]}
              </Chip>
            ))}
          </Row>
          <Row label="Хөдөлгүүр">
            {(["auto", "videotoolbox", "cpu", "nvenc"] as const).map((enc) => (
              <Chip
                key={enc}
                active={settings.encoder === enc}
                disabled={encoders ? !encoders[enc] : enc !== "auto" && enc !== "cpu"}
                title={enc === "auto" ? autoHint : ENCODER_INFO[enc].hint}
                onClick={() => set("encoder", enc)}
              >
                {ENCODER_INFO[enc].label}
              </Chip>
            ))}
          </Row>
          {settings.encoder === "auto" && <p className="-mt-2 text-xs text-zinc-500">{autoHint}</p>}
          <Row label="Формат">
            {EXPORT_FORMATS.map((f) => (
              <Chip key={f} active={settings.format === f} onClick={() => set("format", f)}>
                {f.toUpperCase()}
                {f === "mp3" && " (дуу)"}
              </Chip>
            ))}
          </Row>
          <p className="text-xs text-zinc-500">
            {settings.format === "mp3" ? "Зөвхөн дуу" : `${size.w}×${size.h} · ${project.aspect}`} · урт {timecode(duration)}
          </p>
        </div>

        {phase === "running" && (
          <div className="mt-5 space-y-2">
            <div className="h-2.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className={cx("h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width]", percent == null && "w-1/3 animate-pulse")}
                style={percent != null ? { width: `${percent}%` } : undefined}
              />
            </div>
            <div className="flex justify-between font-mono text-xs text-zinc-400">
              <span>{percent != null ? `${percent.toFixed(1)}%` : "Эхэлж байна…"}</span>
              <span>
                {timecode(elapsed).replace(/\.\d+$/, "")}
                {eta != null && ` · үлдсэн ${timecode(eta).replace(/\.\d+$/, "")}`}
                {speed ? ` · ${speed.toFixed(1)}x` : ""}
              </span>
            </div>
            {encoderUsed && <p className="text-xs text-zinc-500">Хөдөлгүүр: {ENCODER_INFO[encoderUsed].label}</p>}
          </div>
        )}
        {notice && <p className="mt-2 text-xs text-amber-300">{notice}</p>}

        {phase === "done" && result && (
          <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-semibold text-emerald-300">
                <CheckCircle2 className="h-5 w-5" /> Дууслаа! ({(result.elapsedMs / 1000).toFixed(1)} сек)
              </span>
              <button
                type="button"
                onClick={() => triggerDownload(result.jobId, result.outputName)}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-emerald-950 hover:bg-emerald-400"
              >
                <Download className="h-4 w-4" /> Татах
              </button>
            </div>
            <p className="mt-2 text-xs text-zinc-400">
              Эх файлууд {formatBytes(result.originalSize)} → <span className="font-semibold text-zinc-100">{formatBytes(result.newSize)}</span>
              {result.originalSize > 0 && (
                <span className="text-emerald-300"> ({Math.max(0, (1 - result.newSize / result.originalSize) * 100).toFixed(0)}% бага)</span>
              )}
            </p>
          </div>
        )}

        {phase === "error" && error && (
          <div className="mt-5 rounded-xl border border-red-500/40 bg-red-500/5 p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-red-300">
              <AlertTriangle className="h-4 w-4" /> {error.message}
            </p>
            {error.log && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-zinc-400">{error.log}</pre>}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {phase === "running" ? (
            <button type="button" onClick={() => abortRef.current?.abort()} className="rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-red-500/60 hover:text-red-300">
              Цуцлах
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              disabled={duration <= 0 || pending}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-2 text-sm font-bold text-white disabled:opacity-40"
            >
              {pending ? "Байршуулалт дуусахыг хүлээж байна…" : phase === "done" ? "Дахин экспортлох" : "Экспортлох"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "rounded-lg border px-3 py-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-30",
        active ? "border-violet-500 bg-violet-500/20 text-white" : "border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200",
      )}
    >
      {children}
    </button>
  );
}
