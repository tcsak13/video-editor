"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Crop,
  Download,
  FileVideo,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  Gauge,
  HardDrive,
  Loader2,
  Pause,
  Play,
  RotateCw,
  Scissors,
  Shrink,
  Type,
  Upload,
  Volume2,
  VolumeX,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_OPTIONS,
  FILE_ACCEPT,
  type Aspect,
  type Crf,
  type EditOptions,
  type Encoder,
  type OutputFormat,
  type ProcessEvent,
  type ProcessRequest,
  type Resolution,
  type Rotation,
  type SourceInfo,
  type SourceRef,
  type Speed,
  type TextPosition,
  type TextSize,
  type Volume,
} from "@/lib/editor-options";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const whole = Math.floor(s);
  const ms = Math.round((s - whole) * 1000);
  const base = [h, m, whole].map((n) => String(n).padStart(2, "0")).join(":");
  return ms ? `${base}.${String(ms).padStart(3, "0")}` : base;
}

/** Parses "HH:MM:SS(.ms)", "MM:SS" or plain seconds. Empty → null, invalid → NaN. */
function parseTime(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} сек`;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m} мин ${s} сек` : `${s} сек`;
}

function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

const ASPECT_RATIO_VALUES: Record<Exclude<Aspect, "original">, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
};
const TEXT_SIZE_DIVISOR: Record<TextSize, number> = { small: 32, medium: 20, large: 12 };

// ---------------------------------------------------------------------------
// Option catalogs (Mongolian labels)
// ---------------------------------------------------------------------------

type TabId = "trim" | "resize" | "crop" | "rotate" | "speed" | "audio" | "text" | "engine";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "trim", label: "Тайрах", icon: Scissors },
  { id: "resize", label: "Хэмжээ", icon: Shrink },
  { id: "crop", label: "Хэлбэр", icon: Crop },
  { id: "rotate", label: "Эргүүлэх", icon: RotateCw },
  { id: "speed", label: "Хурд", icon: Gauge },
  { id: "audio", label: "Дуу", icon: Volume2 },
  { id: "text", label: "Текст", icon: Type },
  { id: "engine", label: "Хөдөлгүүр", icon: Cpu },
];

const RESOLUTION_CHOICES: Choice<Resolution>[] = [
  { value: "720", label: "720p HD", hint: "Санал болгох — хэмжээ/чанарын хамгийн сайн харьцаа", badge: "★" },
  { value: "1080", label: "1080p Full HD", hint: "Өндөр нарийвчлал, том файл" },
  { value: "480", label: "480p SD", hint: "Хэт жижиг файл, утсанд хангалттай" },
  { value: "original", label: "Анхны хэмжээ", hint: "Нарийвчлалыг өөрчлөхгүй" },
];

const CRF_CHOICES: Choice<Crf>[] = [
  { value: 23, label: "Оновчтой (CRF 23)", hint: "~75% жижиг, нүдэнд ялгаагүй чанар", badge: "★" },
  { value: 20, label: "Өндөр чанар (CRF 20)", hint: "Илүү тод, файл томдуу" },
  { value: 27, label: "Хамгийн их шахалт (CRF 27)", hint: "Хамгийн жижиг файл" },
];

const ASPECT_CHOICES: Choice<Aspect>[] = [
  { value: "original", label: "Анхны", hint: "Хэлбэрийг өөрчлөхгүй" },
  { value: "16:9", label: "16:9", hint: "YouTube / Хэвтээ" },
  { value: "9:16", label: "9:16", hint: "Reels / TikTok / Shorts" },
  { value: "1:1", label: "1:1", hint: "Дөрвөлжин (Instagram)" },
];

const ROTATION_CHOICES: Choice<Rotation>[] = [
  { value: 0, label: "0°", hint: "Эргүүлэхгүй" },
  { value: 90, label: "90°", hint: "Цагийн зүүний дагуу" },
  { value: 180, label: "180°", hint: "Дээш доош нь" },
  { value: 270, label: "270°", hint: "Цагийн зүүний эсрэг 90°" },
];

const SPEED_CHOICES: Choice<Speed>[] = [
  { value: 0.5, label: "0.5x", hint: "Удаан" },
  { value: 1, label: "1x", hint: "Хэвийн" },
  { value: 1.25, label: "1.25x" },
  { value: 1.5, label: "1.5x" },
  { value: 2, label: "2.0x", hint: "Хурдан" },
];

const VOLUME_CHOICES: Choice<Volume>[] = [
  { value: 0.5, label: "50%", hint: "Намсгах" },
  { value: 1, label: "100%", hint: "Хэвийн" },
  { value: 1.5, label: "150%", hint: "Чангалах" },
  { value: 2, label: "200%", hint: "2 дахин чанга" },
];

const TEXT_POSITION_CHOICES: Choice<TextPosition>[] = [
  { value: "top-left", label: "Зүүн дээд" },
  { value: "center", label: "Төв" },
  { value: "bottom-right", label: "Баруун доод" },
];

const TEXT_SIZE_CHOICES: Choice<TextSize>[] = [
  { value: "small", label: "Жижиг" },
  { value: "medium", label: "Дунд" },
  { value: "large", label: "Том" },
];

const ENCODER_LABELS: Record<Encoder, { label: string; hint: string }> = {
  auto: { label: "Автомат", hint: "Mac дээр Apple GPU, бусад үед CPU" },
  cpu: { label: "CPU (Бүх төхөөрөмж)", hint: "libx264 -preset veryfast — хамгийн найдвартай" },
  nvenc: { label: "NVIDIA GPU", hint: "h264_nvenc — ~5 дахин хурдан" },
  videotoolbox: { label: "Apple Silicon GPU", hint: "h264_videotoolbox — Mac дээр маш хурдан" },
};

const FORMAT_CHOICES: Choice<OutputFormat>[] = [
  { value: "mp4", label: "MP4", hint: "Хаана ч тоглоно" },
  { value: "mkv", label: "MKV" },
  { value: "mov", label: "MOV", hint: "Apple / монтаж" },
  { value: "mp3", label: "MP3", hint: "Зөвхөн дуу" },
];

// ---------------------------------------------------------------------------
// Small UI building blocks
// ---------------------------------------------------------------------------

type Choice<T> = { value: T; label: string; hint?: string; badge?: string; disabled?: boolean };

function ChoiceGrid<T extends string | number>({
  choices,
  value,
  onChange,
  columns = 2,
}: {
  choices: Choice<T>[];
  value: T;
  onChange: (v: T) => void;
  columns?: 1 | 2 | 3 | 4 | 5;
}) {
  const cols = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-2 sm:grid-cols-4", 5: "grid-cols-3 sm:grid-cols-5" }[columns];
  return (
    <div className={cx("grid gap-2", cols)} role="radiogroup">
      {choices.map((c) => {
        const active = c.value === value;
        return (
          <button
            key={String(c.value)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={c.disabled}
            onClick={() => onChange(c.value)}
            className={cx(
              "relative rounded-xl border px-3 py-2.5 text-left transition",
              active
                ? "border-violet-500 bg-violet-500/15 text-white ring-1 ring-violet-500/50"
                : "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800/60",
              c.disabled && "cursor-not-allowed opacity-40 hover:border-zinc-800 hover:bg-zinc-900/60",
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              {c.label}
              {c.badge && <span className="text-xs text-amber-400">{c.badge}</span>}
            </span>
            {c.hint && <span className="mt-0.5 block text-xs leading-snug text-zinc-400">{c.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  icon: Icon,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cx(
        "flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-sm transition",
        checked ? "border-violet-500 bg-violet-500/15 text-white" : "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600",
      )}
    >
      <span className="flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4" />}
        {label}
      </span>
      <span className={cx("relative h-5 w-9 rounded-full transition", checked ? "bg-violet-500" : "bg-zinc-700")}>
        <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", checked ? "left-[18px]" : "left-0.5")} />
      </span>
    </button>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{children}</div>;
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-5", className)}>{children}</section>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Phase = "idle" | "processing" | "done" | "error";

type Progress = { percent: number | null; outTime: number; speed: number | null; fps: number | null };

type DoneEvent = Extract<ProcessEvent, { type: "done" }>;

export default function CompressPage() {
  // --- source ---
  const [sourceMode, setSourceMode] = useState<"file" | "path">("file");
  const [sourceRef, setSourceRef] = useState<SourceRef | null>(null);
  const [sourceInfo, setSourceInfo] = useState<SourceInfo | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [probing, setProbing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [saveNextToSource, setSaveNextToSource] = useState(true);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- options ---
  const [options, setOptions] = useState<EditOptions>(DEFAULT_OPTIONS);
  const [trimStartText, setTrimStartText] = useState("");
  const [trimEndText, setTrimEndText] = useState("");
  const [tab, setTab] = useState<TabId>("resize");
  const [encoders, setEncoders] = useState<Record<Encoder, boolean> | null>(null);
  const [isAppleSilicon, setIsAppleSilicon] = useState(false);

  // --- player ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 640, h: 360 });
  const [videoDims, setVideoDims] = useState<{ w: number; h: number } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const stopAtRef = useRef<number | null>(null);

  // --- job ---
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [expectedDuration, setExpectedDuration] = useState<number | null>(null);
  const [activeEncoder, setActiveEncoder] = useState<Encoder | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<DoneEvent | null>(null);
  const [jobError, setJobError] = useState<{ message: string; log?: string } | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const set = <K extends keyof EditOptions>(key: K, value: EditOptions[K]) => setOptions((o) => ({ ...o, [key]: value }));

  // Encoder capabilities of the bundled ffmpeg.
  useEffect(() => {
    fetch("/api/capabilities")
      .then((r) => r.json())
      .then((data: { encoders: Record<Encoder, boolean>; platform: string; arch: string }) => {
        setEncoders(data.encoders);
        setIsAppleSilicon(data.platform === "darwin" && data.arch === "arm64");
      })
      .catch(() => setEncoders({ auto: true, cpu: true, nvenc: false, videotoolbox: false }));
  }, []);

  // Keep the preview stage size for overlay math.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setStageSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Processing timer.
  useEffect(() => {
    if (phase !== "processing") return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [phase]);

  // Release blob URLs when the preview changes.
  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Mirror speed/mute onto the preview player.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = options.speed;
    v.muted = options.mute;
    v.volume = Math.min(1, options.volume);
  }, [options.speed, options.mute, options.volume, previewUrl]);

  const resetSource = () => {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setSourceRef(null);
    setSourceInfo(null);
    setPreviewUrl(null);
    setPendingFile(null);
    setUploadProgress(null);
    setSourceError(null);
    setVideoDims(null);
    setPreviewFailed(false);
    setPlaying(false);
    setCurrentTime(0);
    setPlayerDuration(0);
    setTrimStartText("");
    setTrimEndText("");
    setResult(null);
    setJobError(null);
    setPhase("idle");
  };

  // --- file upload (streams to server immediately while the user configures edits) ---
  const handleFile = (file: File) => {
    resetSource();
    setPendingFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setUploadProgress(0);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("PUT", `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhrRef.current !== xhr) return;
      xhrRef.current = null;
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 400) throw new Error(data.error);
        setSourceRef({ kind: "upload", id: data.id });
        setSourceInfo(data.info);
        setUploadProgress(1);
      } catch (err) {
        setSourceError(err instanceof Error && err.message ? err.message : "Байршуулалт амжилтгүй.");
        setUploadProgress(null);
      }
    };
    xhr.onerror = () => {
      if (xhrRef.current !== xhr) return;
      xhrRef.current = null;
      setSourceError("Сервертэй холбогдож чадсангүй.");
      setUploadProgress(null);
    };
    xhr.send(file);
  };

  // --- local path mode (no copy, no browser memory) ---
  const openPath = async () => {
    if (!pathInput.trim()) return;
    resetSource();
    setProbing(true);
    try {
      const res = await fetch("/api/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pathInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSourceRef({ kind: "path", path: data.path });
      setSourceInfo(data.info);
      setPathInput(data.path);
      setPreviewUrl(`/api/preview?path=${encodeURIComponent(data.path)}`);
    } catch (err) {
      setSourceError(err instanceof Error && err.message ? err.message : "Файлыг нээж чадсангүй.");
    } finally {
      setProbing(false);
    }
  };

  // --- trim ---
  const trimStart = parseTime(trimStartText);
  const trimEnd = parseTime(trimEndText);
  const trimInvalid =
    Number.isNaN(trimStart) || Number.isNaN(trimEnd) || (trimStart !== null && trimEnd !== null && trimEnd <= trimStart);
  const totalDuration = sourceInfo?.media.duration ?? (playerDuration || null);

  const seek = (t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = t;
    setCurrentTime(t);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || previewFailed) return;
    stopAtRef.current = null;
    if (v.paused) void v.play();
    else v.pause();
  };

  const playSelection = () => {
    const v = videoRef.current;
    if (!v || previewFailed) return;
    v.currentTime = trimStart && !Number.isNaN(trimStart) ? trimStart : 0;
    stopAtRef.current = trimEnd && !Number.isNaN(trimEnd) ? trimEnd : null;
    void v.play();
  };

  // --- process ---
  const busy = phase === "processing";
  const uploading = uploadProgress !== null && uploadProgress < 1 && !sourceRef;
  const canProcess = !!sourceRef && !busy && !trimInvalid;

  const startProcessing = useCallback(async () => {
    if (!sourceRef) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("processing");
    setProgress(null);
    setResult(null);
    setJobError(null);
    setNotice(null);
    setStartedAt(Date.now());
    setNow(Date.now());

    const payload: ProcessRequest = {
      source: sourceRef,
      options: { ...options, trimStart, trimEnd },
      saveNextToSource,
    };

    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Серверийн алдаа (${res.status})`);
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const event = JSON.parse(line) as ProcessEvent;
          switch (event.type) {
            case "start":
              setExpectedDuration(event.expectedDuration);
              setActiveEncoder(event.encoder);
              break;
            case "progress":
              setProgress(event);
              break;
            case "fallback":
              setNotice(`${ENCODER_LABELS[event.from].label} ажиллахгүй байсан тул CPU руу шилжлээ.`);
              setProgress(null);
              break;
            case "done":
              finished = true;
              setResult(event);
              setPhase("done");
              if (!event.outputPath) triggerDownload(event.jobId, event.outputName);
              break;
            case "error":
              finished = true;
              setJobError({ message: event.message, log: event.log });
              setPhase("error");
              break;
          }
        }
      }
      if (!finished) throw new Error("Сервертэй холболт тасарлаа.");
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase("idle");
        setNotice("Цуцлагдлаа.");
      } else {
        setJobError({ message: err instanceof Error ? err.message : String(err) });
        setPhase("error");
      }
    } finally {
      abortRef.current = null;
    }
  }, [sourceRef, options, trimStart, trimEnd, saveNextToSource]);

  const cancelProcessing = () => abortRef.current?.abort();

  // --- preview geometry (mirrors the server's crop → scale → rotate → flip order) ---
  const natural = videoDims ?? {
    w: sourceInfo?.media.width ?? 16,
    h: sourceInfo?.media.height ?? 9,
  };
  const quarterTurn = options.rotate === 90 || options.rotate === 270;
  const preview = useMemo(() => {
    const dispAspect = quarterTurn ? natural.h / natural.w : natural.w / natural.h;
    let dispW = stageSize.w;
    let dispH = dispW / dispAspect;
    if (dispH > stageSize.h) {
      dispH = stageSize.h;
      dispW = dispH * dispAspect;
    }
    let cropW = dispW;
    let cropH = dispH;
    if (options.aspect !== "original") {
      const r = ASPECT_RATIO_VALUES[options.aspect];
      cropW = Math.min(dispW, dispH * r);
      cropH = Math.min(dispH, dispW / r);
    }
    return {
      dispW,
      dispH,
      vidW: quarterTurn ? dispH : dispW,
      vidH: quarterTurn ? dispW : dispH,
      cropW,
      cropH,
    };
  }, [natural.w, natural.h, quarterTurn, stageSize, options.aspect]);

  const textFontPx = Math.min(preview.cropW, preview.cropH) / TEXT_SIZE_DIVISOR[options.textSize];
  const textMargin = Math.min(preview.cropW, preview.cropH) / 30;

  // --- summary chips ---
  const chips: string[] = [];
  if (trimStart !== null || trimEnd !== null) chips.push(`✂️ ${trimStartText || "0"} → ${trimEndText || "төгсгөл"}`);
  if (options.format !== "mp3") {
    chips.push(`📐 ${options.resolution === "original" ? "Анхны" : options.resolution + "p"} · CRF ${options.crf}`);
    if (options.aspect !== "original") chips.push(`🖼️ ${options.aspect}`);
    if (options.rotate) chips.push(`🔄 ${options.rotate}°`);
    if (options.hflip) chips.push("↔️ Хэвтээ толь");
    if (options.vflip) chips.push("↕️ Босоо толь");
    if (options.text.trim()) chips.push(`🔤 "${options.text.trim().slice(0, 18)}"`);
  }
  if (options.speed !== 1) chips.push(`⚡ ${options.speed}x`);
  if (options.mute) chips.push("🔇 Дуугүй");
  else if (options.volume !== 1) chips.push(`🔊 ${options.volume * 100}%`);
  chips.push(`🚀 ${ENCODER_LABELS[options.encoder].label}`);
  chips.push(`📦 ${options.format.toUpperCase()}`);

  const elapsed = startedAt ? now - startedAt : 0;
  const eta =
    progress?.speed && expectedDuration && progress.speed > 0
      ? Math.max(0, (expectedDuration - progress.outTime) / progress.speed)
      : null;

  const seekMax = totalDuration ?? 0;
  const pct = (t: number | null) => (seekMax && t !== null && !Number.isNaN(t) ? Math.min(100, (t / seekMax) * 100) : null);
  const selStartPct = pct(trimStart) ?? 0;
  const selEndPct = pct(trimEnd) ?? 100;

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:py-10">
      {/* Header */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 shadow-lg shadow-violet-900/40">
            <FileVideo className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white sm:text-2xl">Хурдан шахах / хөрвүүлэх</h1>
            <p className="text-sm text-zinc-400">Тайрах · Шахах · Хэлбэр · Эргүүлэх · Хурд · Дуу · Текст</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/" className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-violet-500 hover:text-white">
            ← Timeline засварлагч
          </Link>
          <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300">
            <HardDrive className="h-3.5 w-3.5" /> 100% офлайн
          </div>
        </div>
      </header>

      {/* Source */}
      <Card className="mb-6">
        <div className="mb-4 inline-flex rounded-xl border border-zinc-800 bg-zinc-950 p-1">
          {(
            [
              ["file", "Файл сонгох", Upload],
              ["path", "Локал зам (2GB+)", FolderOpen],
            ] as const
          ).map(([mode, label, Icon]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setSourceMode(mode)}
              className={cx(
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition",
                sourceMode === mode ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200",
              )}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        {sourceMode === "file" ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) handleFile(file);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={cx(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition",
              dragging ? "border-violet-500 bg-violet-500/10" : "border-zinc-700 hover:border-zinc-500 hover:bg-zinc-800/30",
            )}
          >
            <Upload className="h-8 w-8 text-zinc-400" />
            <p className="font-medium text-zinc-200">Видеогоо энд чирж оруулах эсвэл дарж сонгох</p>
            <p className="text-xs text-zinc-500">MP4, MKV, MOV, AVI, WEBM, FLV, WMV, MPEG, M4V, 3GP… бүх формат</p>
            <input
              ref={fileInputRef}
              type="file"
              accept={FILE_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
                e.target.value = "";
              }}
            />
          </div>
        ) : (
          <div>
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void openPath();
              }}
            >
              <input
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                placeholder="D:\Movies\raw_video.mkv  эсвэл  /Users/me/Movies/video.mov"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-2.5 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
              />
              <button
                type="submit"
                disabled={probing || !pathInput.trim()}
                className="flex items-center justify-center gap-2 rounded-xl bg-zinc-100 px-5 py-2.5 text-sm font-semibold text-zinc-900 transition hover:bg-white disabled:opacity-50"
              >
                {probing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
                Нээх
              </button>
            </form>
            <p className="mt-2 text-xs text-zinc-500">
              Файлыг хуулж байршуулахгүй — ffmpeg шууд дискнээс уншина. 2–10GB+ болон MKV/AVI зэрэг хөтөч тоглуулж чаддаггүй форматад тохиромжтой.
            </p>
          </div>
        )}

        {/* Source status */}
        {(pendingFile || sourceInfo || sourceError) && (
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-zinc-950/60 px-4 py-3 text-sm">
            <span className="flex min-w-0 items-center gap-2 font-medium text-zinc-100">
              <FileVideo className="h-4 w-4 shrink-0 text-violet-400" />
              <span className="truncate">{sourceInfo?.name ?? pendingFile?.name}</span>
            </span>
            {(sourceInfo || pendingFile) && (
              <span className="text-zinc-400">{formatBytes(sourceInfo?.size ?? pendingFile?.size ?? 0)}</span>
            )}
            {sourceInfo?.media.width && (
              <span className="text-zinc-400">
                {sourceInfo.media.width}×{sourceInfo.media.height}
              </span>
            )}
            {sourceInfo?.media.duration && <span className="text-zinc-400">{formatTime(Math.round(sourceInfo.media.duration))}</span>}
            {sourceInfo?.media.videoCodec && (
              <span className="text-zinc-500">
                {sourceInfo.media.videoCodec}
                {sourceInfo.media.audioCodec ? ` / ${sourceInfo.media.audioCodec}` : " / дуугүй"}
              </span>
            )}
            {uploading && (
              <span className="flex flex-1 items-center gap-3 text-zinc-300">
                <span className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-zinc-800">
                  <span className="block h-full bg-violet-500 transition-all" style={{ width: `${(uploadProgress ?? 0) * 100}%` }} />
                </span>
                Байршуулж байна {Math.round((uploadProgress ?? 0) * 100)}%
              </span>
            )}
            {sourceRef && (
              <span className="flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> Бэлэн
              </span>
            )}
            {sourceError && (
              <span className="flex items-center gap-1.5 text-red-400">
                <AlertTriangle className="h-4 w-4" /> {sourceError}
              </span>
            )}
            {(pendingFile || sourceInfo) && (
              <button type="button" onClick={resetSource} className="ml-auto text-zinc-500 hover:text-zinc-200" aria-label="Цэвэрлэх">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* Left: preview + progress/result */}
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="p-3 sm:p-3">
            <div ref={stageRef} className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
              {previewUrl && !previewFailed && (
                <video
                  ref={videoRef}
                  src={previewUrl}
                  playsInline
                  preload="metadata"
                  onClick={togglePlay}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth && v.videoHeight) setVideoDims({ w: v.videoWidth, h: v.videoHeight });
                    setPlayerDuration(v.duration);
                    v.playbackRate = options.speed;
                    v.muted = options.mute;
                  }}
                  onTimeUpdate={(e) => {
                    const t = e.currentTarget.currentTime;
                    setCurrentTime(t);
                    if (stopAtRef.current !== null && t >= stopAtRef.current) {
                      e.currentTarget.pause();
                      stopAtRef.current = null;
                    }
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onError={() => setPreviewFailed(true)}
                  className="absolute left-1/2 top-1/2 max-w-none cursor-pointer object-fill"
                  style={{
                    width: preview.vidW,
                    height: preview.vidH,
                    transform: `translate(-50%, -50%) scale(${options.hflip ? -1 : 1}, ${options.vflip ? -1 : 1}) rotate(${options.rotate}deg)`,
                  }}
                />
              )}

              {/* Overlays in output-frame coordinates */}
              {previewUrl && !previewFailed && options.format !== "mp3" && (
                <div
                  className="pointer-events-none absolute left-1/2 top-1/2 overflow-hidden"
                  style={{ width: preview.dispW, height: preview.dispH, transform: "translate(-50%, -50%)" }}
                >
                  <div
                    className={cx(
                      "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
                      options.aspect !== "original" && "border-2 border-dashed border-violet-400/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.6)]",
                    )}
                    style={{ width: preview.cropW, height: preview.cropH }}
                  >
                    {options.text.trim() && (
                      <span
                        className="absolute whitespace-nowrap font-[Arial,sans-serif] text-white"
                        style={{
                          fontSize: textFontPx,
                          lineHeight: 1,
                          textShadow: "0 0 3px rgba(0,0,0,.6), 2px 2px 2px rgba(0,0,0,.5)",
                          ...(options.textPosition === "top-left"
                            ? { left: textMargin, top: textMargin }
                            : options.textPosition === "center"
                              ? { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }
                              : { right: textMargin, bottom: textMargin }),
                        }}
                      >
                        {options.text.trim()}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {!previewUrl && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-600">
                  <FileVideo className="h-12 w-12" />
                  <span className="text-sm">Урьдчилан харах хэсэг</span>
                </div>
              )}
              {previewFailed && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
                  <AlertTriangle className="h-8 w-8 text-amber-400" />
                  <p className="text-sm text-zinc-300">Энэ форматыг хөтөч дээр урьдчилан харах боломжгүй.</p>
                  <p className="text-xs text-zinc-500">Засвар, хөрвүүлэлт хэвийн ажиллана — тайрах цагийг гараар оруулна уу.</p>
                </div>
              )}
            </div>

            {/* Custom controls (the video element itself may be rotated) */}
            <div className="mt-3 flex items-center gap-3 px-1">
              <button
                type="button"
                onClick={togglePlay}
                disabled={!previewUrl || previewFailed}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-white transition hover:bg-zinc-700 disabled:opacity-40"
                aria-label={playing ? "Зогсоох" : "Тоглуулах"}
              >
                {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
              </button>
              <div className="relative flex h-9 flex-1 items-center">
                <div className="absolute inset-x-0 h-1.5 rounded-full bg-zinc-800" />
                {(trimStart !== null || trimEnd !== null) && !trimInvalid && (
                  <div
                    className="absolute h-1.5 rounded-full bg-violet-500/60"
                    style={{ left: `${selStartPct}%`, width: `${Math.max(0, selEndPct - selStartPct)}%` }}
                  />
                )}
                <input
                  type="range"
                  min={0}
                  max={seekMax || 1}
                  step={0.01}
                  value={Math.min(currentTime, seekMax || 1)}
                  disabled={!previewUrl || previewFailed}
                  onChange={(e) => seek(Number(e.target.value))}
                  className="relative w-full cursor-pointer accent-violet-500 disabled:cursor-default"
                  aria-label="Байрлал"
                />
              </div>
              <span className="shrink-0 font-mono text-xs tabular-nums text-zinc-400">
                {formatTime(Math.floor(currentTime))} / {formatTime(Math.round(seekMax))}
              </span>
            </div>
          </Card>

          {/* Summary chips */}
          <div className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <span key={c} className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-300">
                {c}
              </span>
            ))}
          </div>

          {/* Progress */}
          {busy && (
            <Card>
              <div className="mb-3 flex items-center justify-between gap-4">
                <span className="flex items-center gap-2 font-semibold text-white">
                  <Loader2 className="h-4 w-4 animate-spin text-violet-400" /> Боловсруулж байна…
                </span>
                <button
                  type="button"
                  onClick={cancelProcessing}
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-red-500/60 hover:text-red-300"
                >
                  <X className="h-4 w-4" /> Цуцлах
                </button>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={cx(
                    "h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width] duration-300",
                    progress?.percent == null && "w-1/3 animate-pulse",
                  )}
                  style={progress?.percent != null ? { width: `${progress.percent}%` } : undefined}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Stat label="Явц" value={progress?.percent != null ? `${progress.percent.toFixed(1)}%` : "…"} />
                <Stat label="Хугацаа" value={formatTime(Math.floor(elapsed / 1000))} mono />
                <Stat label="Үлдсэн" value={eta !== null ? formatTime(Math.round(eta)) : "…"} mono />
                <Stat label="Хурд" value={progress?.speed ? `${progress.speed.toFixed(1)}x` : "…"} />
              </div>
              {activeEncoder && <p className="mt-3 text-xs text-zinc-500">Хөдөлгүүр: {ENCODER_LABELS[activeEncoder].label}</p>}
              {notice && <p className="mt-2 text-xs text-amber-300">{notice}</p>}
            </Card>
          )}

          {/* Result */}
          {phase === "done" && result && <ResultCard result={result} notice={notice} />}

          {phase === "error" && jobError && (
            <Card className="border-red-500/40 bg-red-500/5">
              <div className="flex items-center gap-2 font-semibold text-red-300">
                <AlertTriangle className="h-5 w-5" /> {jobError.message}
              </div>
              {jobError.log && (
                <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-black/50 p-3 font-mono text-xs text-zinc-400">
                  {jobError.log}
                </pre>
              )}
            </Card>
          )}

          {phase === "idle" && notice && <p className="text-sm text-zinc-400">{notice}</p>}
        </div>

        {/* Right: tools */}
        <div className="flex flex-col gap-6">
          <Card className="p-0 sm:p-0">
            <nav className="grid grid-cols-4 gap-1 border-b border-zinc-800 p-2">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cx(
                    "flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] font-medium transition",
                    tab === id ? "bg-violet-500/15 text-violet-200" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200",
                  )}
                >
                  <Icon className="h-5 w-5" />
                  {label}
                </button>
              ))}
            </nav>

            <div className="space-y-5 p-4 sm:p-5">
              {tab === "trim" && (
                <>
                  <h2 className="text-base font-semibold text-white">✂️ Тайрах</h2>
                  {(
                    [
                      ["Эхлэх цаг", trimStartText, setTrimStartText, trimStart],
                      ["Дуусах цаг", trimEndText, setTrimEndText, trimEnd],
                    ] as const
                  ).map(([label, text, setText, parsed]) => (
                    <div key={label}>
                      <Label>{label}</Label>
                      <div className="flex gap-2">
                        <input
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                          onBlur={() => parsed !== null && !Number.isNaN(parsed) && setText(formatTime(parsed))}
                          placeholder={label === "Эхлэх цаг" ? "00:00:00" : totalDuration ? formatTime(Math.round(totalDuration)) : "00:00:00"}
                          className={cx(
                            "min-w-0 flex-1 rounded-xl border bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500",
                            Number.isNaN(parsed) ? "border-red-500" : "border-zinc-700",
                          )}
                        />
                        <button
                          type="button"
                          disabled={!previewUrl || previewFailed}
                          onClick={() => setText(formatTime(Math.round(currentTime * 1000) / 1000))}
                          className="flex items-center gap-1.5 rounded-xl border border-zinc-700 px-3 text-xs text-zinc-300 transition hover:border-violet-500 hover:text-white disabled:opacity-40"
                        >
                          <Clock className="h-3.5 w-3.5" /> Одоогийн цаг
                        </button>
                      </div>
                    </div>
                  ))}
                  {trimInvalid && (
                    <p className="text-xs text-red-400">Цаг буруу байна. Формат: ЦЦ:ММ:СС — дуусах цаг эхлэхээс хойш байх ёстой.</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={playSelection}
                      disabled={!previewUrl || previewFailed || trimInvalid}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-zinc-800 px-3 py-2 text-sm text-zinc-200 transition hover:bg-zinc-700 disabled:opacity-40"
                    >
                      <Play className="h-4 w-4" /> Сонгосон хэсгийг тоглуулах
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTrimStartText("");
                        setTrimEndText("");
                      }}
                      className="rounded-xl border border-zinc-700 px-3 py-2 text-sm text-zinc-400 transition hover:text-white"
                    >
                      Цэвэрлэх
                    </button>
                  </div>
                </>
              )}

              {tab === "resize" && (
                <>
                  <h2 className="text-base font-semibold text-white">📐 Хэмжээ ба Шахалт</h2>
                  <div>
                    <Label>Нарийвчлал</Label>
                    <ChoiceGrid choices={RESOLUTION_CHOICES} value={options.resolution} onChange={(v) => set("resolution", v)} />
                  </div>
                  <div>
                    <Label>Чанар</Label>
                    <ChoiceGrid choices={CRF_CHOICES} value={options.crf} onChange={(v) => set("crf", v)} columns={1} />
                  </div>
                  <p className="text-xs leading-relaxed text-zinc-500">
                    2GB 1080p/4K бичлэгийг 720p + CRF 23-аар ихэвчлэн 70–85% багасгана. Богино тал нь сонгосон хэмжээнд тааруулагдах тул босоо видеонд ч зөв ажиллана; жижиг видеог томруулахгүй.
                  </p>
                </>
              )}

              {tab === "crop" && (
                <>
                  <h2 className="text-base font-semibold text-white">🖼️ Хэлбэр гаргах</h2>
                  <ChoiceGrid choices={ASPECT_CHOICES} value={options.aspect} onChange={(v) => set("aspect", v)} />
                  <p className="text-xs text-zinc-500">Төвөөс нь автоматаар тайрна. Тасархай хүрээ гаралтын хэсгийг харуулна.</p>
                </>
              )}

              {tab === "rotate" && (
                <>
                  <h2 className="text-base font-semibold text-white">🔄 Эргүүлэх</h2>
                  <ChoiceGrid choices={ROTATION_CHOICES} value={options.rotate} onChange={(v) => set("rotate", v)} />
                  <div className="grid gap-2">
                    <Toggle checked={options.hflip} onChange={(v) => set("hflip", v)} label="Хэвтээ толин тусгал (hflip)" icon={FlipHorizontal2} />
                    <Toggle checked={options.vflip} onChange={(v) => set("vflip", v)} label="Босоо толин тусгал (vflip)" icon={FlipVertical2} />
                  </div>
                </>
              )}

              {tab === "speed" && (
                <>
                  <h2 className="text-base font-semibold text-white">⚡ Хурд</h2>
                  <ChoiceGrid choices={SPEED_CHOICES} value={options.speed} onChange={(v) => set("speed", v)} columns={3} />
                  <p className="text-xs text-zinc-500">Видео (setpts) болон дууны (atempo) хурдыг хамт өөрчилнө — дууны өндөр хэвээр.</p>
                </>
              )}

              {tab === "audio" && (
                <>
                  <h2 className="text-base font-semibold text-white">🔊 Дуу</h2>
                  <Toggle checked={options.mute} onChange={(v) => set("mute", v)} label="Дууг бүрэн хаах" icon={VolumeX} />
                  <div className={cx(options.mute && "pointer-events-none opacity-40")}>
                    <Label>Дууны түвшин</Label>
                    <ChoiceGrid choices={VOLUME_CHOICES} value={options.volume} onChange={(v) => set("volume", v)} />
                  </div>
                  {sourceInfo && !sourceInfo.media.hasAudio && <p className="text-xs text-amber-300">Энэ видеонд дууны урсгал алга.</p>}
                </>
              )}

              {tab === "text" && (
                <>
                  <h2 className="text-base font-semibold text-white">🔤 Текст нэмэх</h2>
                  <div>
                    <Label>Текст / Усан тэмдэг</Label>
                    <input
                      value={options.text}
                      onChange={(e) => set("text", e.target.value)}
                      maxLength={200}
                      placeholder="Жишээ: © Миний суваг"
                      className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
                    />
                  </div>
                  <div>
                    <Label>Байрлал</Label>
                    <ChoiceGrid choices={TEXT_POSITION_CHOICES} value={options.textPosition} onChange={(v) => set("textPosition", v)} columns={3} />
                  </div>
                  <div>
                    <Label>Хэмжээ</Label>
                    <ChoiceGrid choices={TEXT_SIZE_CHOICES} value={options.textSize} onChange={(v) => set("textSize", v)} columns={3} />
                  </div>
                </>
              )}

              {tab === "engine" && (
                <>
                  <h2 className="text-base font-semibold text-white">🚀 Хөдөлгүүр</h2>
                  <ChoiceGrid
                    columns={2}
                    value={options.encoder}
                    onChange={(v) => set("encoder", v)}
                    choices={(["auto", "cpu", "nvenc", "videotoolbox"] as const).map((enc) => ({
                      value: enc,
                      label: ENCODER_LABELS[enc].label,
                      badge: enc === "auto" ? "★" : undefined,
                      hint:
                        enc === "auto" && isAppleSilicon && encoders?.videotoolbox
                          ? "Энэ Mac дээр → Apple Silicon GPU"
                          : encoders && !encoders[enc]
                            ? "Энэ ffmpeg-д байхгүй"
                            : ENCODER_LABELS[enc].hint,
                      disabled: encoders ? !encoders[enc] : enc !== "cpu" && enc !== "auto",
                    }))}
                  />
                  <p className="text-xs leading-relaxed text-zinc-500">
                    GPU хөдөлгүүр ажиллахгүй бол автоматаар CPU руу шилжинэ. GPU нь CPU-аас хурдан боловч ижил чанарт файл бага зэрэг томдуу гарна.
                  </p>
                </>
              )}
            </div>
          </Card>

          {/* Output + action */}
          <Card>
            <Label>Гаралтын формат</Label>
            <ChoiceGrid choices={FORMAT_CHOICES} value={options.format} onChange={(v) => set("format", v)} columns={4} />
            {sourceRef?.kind === "path" && (
              <div className="mt-3">
                <Toggle checked={saveNextToSource} onChange={setSaveNextToSource} label="Үр дүнг эх файлын хажууд хадгалах" icon={HardDrive} />
              </div>
            )}
            <button
              type="button"
              onClick={() => void startProcessing()}
              disabled={!canProcess}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-5 py-3.5 text-base font-bold text-white shadow-lg shadow-violet-900/30 transition hover:from-violet-500 hover:to-fuchsia-500 disabled:cursor-not-allowed disabled:from-zinc-700 disabled:to-zinc-700 disabled:shadow-none"
            >
              {busy ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" /> Боловсруулж байна…
                </>
              ) : uploading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" /> Байршуулж байна {Math.round((uploadProgress ?? 0) * 100)}%
                </>
              ) : (
                <>
                  <Zap className="h-5 w-5" /> Боловсруулах
                </>
              )}
            </button>
            {!sourceRef && !uploading && <p className="mt-2 text-center text-xs text-zinc-500">Эхлээд видео сонгоно уу.</p>}
          </Card>
        </div>
      </div>
    </main>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl bg-zinc-950/60 px-3 py-2">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={cx("text-base font-semibold text-zinc-100", mono && "font-mono tabular-nums")}>{value}</div>
    </div>
  );
}

function triggerDownload(jobId: string, name: string) {
  const a = document.createElement("a");
  a.href = `/api/download?job=${jobId}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function ResultCard({ result, notice }: { result: DoneEvent; notice: string | null }) {
  const saved = result.originalSize > 0 ? (1 - result.newSize / result.originalSize) * 100 : 0;
  return (
    <Card className="border-emerald-500/30 bg-emerald-500/5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-lg font-bold text-emerald-300">
          <CheckCircle2 className="h-5 w-5" /> Дууслаа!
        </span>
        <button
          type="button"
          onClick={() => triggerDownload(result.jobId, result.outputName)}
          className="flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400"
        >
          <Download className="h-4 w-4" /> Татах
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Анхны хэмжээ" value={formatBytes(result.originalSize)} />
        <Stat label="Шинэ хэмжээ" value={formatBytes(result.newSize)} />
        <div className="rounded-xl bg-zinc-950/60 px-3 py-2">
          <div className="text-xs text-zinc-500">{saved >= 0 ? "Хэмнэлт" : "Томорсон"}</div>
          <div className={cx("text-base font-bold", saved >= 0 ? "text-emerald-300" : "text-amber-300")}>
            {Math.abs(saved).toFixed(1)}%
          </div>
        </div>
        <Stat label="Зарцуулсан хугацаа" value={formatDuration(result.elapsedMs)} />
      </div>
      {result.originalSize > 0 && (
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-700" title="Шинэ хэмжээ / анхны хэмжээ">
          <div
            className="h-full rounded-full bg-emerald-400"
            style={{ width: `${Math.min(100, Math.max(1, (result.newSize / result.originalSize) * 100))}%` }}
          />
        </div>
      )}
      <p className="mt-3 break-all text-xs text-zinc-400">
        {result.outputPath ? (
          <>
            Хадгалсан: <span className="font-mono text-zinc-200">{result.outputPath}</span>
          </>
        ) : (
          <>
            Файл: <span className="font-mono text-zinc-200">{result.outputName}</span> — автоматаар татагдаж байна.
          </>
        )}
      </p>
      {notice && <p className="mt-1 text-xs text-amber-300">{notice}</p>}
    </Card>
  );
}
