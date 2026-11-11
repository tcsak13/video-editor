"use client";

import {
  AlertTriangle,
  Crop as CropIcon,
  Expand,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  Gauge,
  Loader2,
  Move,
  Music,
  Plus,
  Replace,
  RotateCw,
  Shrink,
  SquareRoundCorner,
  StretchVertical,
  Trash2,
  Type,
  Unlink,
  Upload,
  Video,
  Volume2,
  VolumeX,
  Wand2,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { MEDIA_ACCEPT } from "@/lib/editor-options";
import { cssFontFamily } from "@/lib/fonts";
import {
  MAX_CROP,
  ASPECT_PRESETS,
  NO_CROP,
  aspectLabel,
  SPEED_OPTIONS,
  TEXT_STYLES,
  canvasSize,
  clipDuration,
  coverScale,
  sourceSize,
  type Clip,
  type ClipFrame,
  type MediaClip,
  type Project,
  type Rotation,
  type TextClip,
} from "@/lib/timeline";
import { thumbsUrl, type MediaItem } from "./media";
import { TEXT_PRESETS } from "./ops";
import { cx, formatBytes, timecode } from "./store";
import { MEDIA_DRAG_TYPE } from "./Timeline";
import FontPicker from "./FontPicker";
import { useFontCatalog } from "./fonts";

export type PanelTab = "media" | "text" | "clip";

type Props = {
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  project: Project;
  mediaList: MediaItem[];
  mediaMap: Map<string, MediaItem>;
  selectedClips: Clip[];
  patchClip: (id: string, patch: Partial<MediaClip> | Partial<TextClip>, mergeKey?: string) => void;
  onUploadFiles: (files: File[]) => void;
  onAddPath: (path: string) => Promise<void>;
  onAddMediaToTimeline: (mediaId: string) => void;
  onRemoveMedia: (mediaId: string) => void;
  onBuildProxy: (mediaId: string) => void;
  onAddText: (preset: keyof typeof TEXT_PRESETS) => void;
  onDetach: (clipId: string) => void;
  onDelete: (ids: string[]) => void;
  onToggleMute: (ids: string[]) => void;
  onStartCrop: (clipId: string) => void;
  /** Choose the file for a template slot (placeholder media). */
  onFillMedia: (mediaId: string) => void;
  /** Swap a clip's file, keeping its place, size, crop and effects. */
  onReplaceClip: (clipId: string) => void;
  /** Apply font/size/style to every text clip at once (one undo step). */
  onStyleAllText: (patch: Partial<TextClip>) => void;
};

export default function Inspector(props: Props) {
  const { tab, setTab, selectedClips } = props;
  const tabs: { id: PanelTab; label: string }[] = [
    { id: "media", label: "Медиа" },
    { id: "text", label: "Текст" },
    { id: "clip", label: "Засвар" },
  ];
  return (
    <div className="flex h-full flex-col">
      <div className="m-3 grid grid-cols-3 gap-1 rounded-xl border border-zinc-800 bg-zinc-950 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cx(
              "rounded-lg py-1.5 text-sm font-medium transition",
              tab === t.id ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200",
            )}
          >
            {t.label}
            {t.id === "clip" && selectedClips.length > 0 && <span className="ml-1 text-amber-400">•</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {tab === "media" && <MediaPanel {...props} />}
        {tab === "text" && <TextPanel onAddText={props.onAddText} />}
        {tab === "clip" && <ClipPanel {...props} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Media library
// ---------------------------------------------------------------------------

function MediaPanel({ project, mediaList, onUploadFiles, onAddPath, onAddMediaToTimeline, onRemoveMedia, onBuildProxy, onFillMedia }: Props) {
  const used = new Set(project.clips.flatMap((c) => (c.type === "text" ? [] : [c.mediaId])));
  const slots = mediaList.filter((m) => m.placeholder && used.has(m.id));
  const files = mediaList.filter((m) => !m.placeholder);
  const fileRef = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const submitPath = async () => {
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onAddPath(path);
      setPath("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) onUploadFiles([...e.dataTransfer.files]);
        }}
        className={cx(
          "flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-2 border-dashed px-3 py-5 text-center transition",
          dragging ? "border-violet-500 bg-violet-500/10" : "border-zinc-700 hover:border-zinc-500",
        )}
      >
        <Upload className="h-6 w-6 text-zinc-400" />
        <span className="text-sm font-medium text-zinc-200">Видео / аудио / лого нэмэх</span>
        <span className="text-[11px] text-zinc-500">Чирж оруулах эсвэл дарж сонгох · олныг зэрэг</span>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={MEDIA_ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) onUploadFiles([...e.target.files]);
            e.target.value = "";
          }}
        />
      </div>

      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submitPath();
        }}
      >
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Локал зам: D:\Movies\video.mkv"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
        />
        <button
          type="submit"
          disabled={busy || !path.trim()}
          title="2GB+ файлыг хуулахгүйгээр шууд нээнэ"
          className="flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 text-xs text-zinc-200 transition hover:bg-zinc-700 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
          Нээх
        </button>
      </form>
      {error && <p className="text-xs text-red-400">{error}</p>}

      {slots.length > 0 && (
        <div className="space-y-2 rounded-xl border border-violet-500/40 bg-violet-500/5 p-2">
          <p className="px-1 text-[11px] text-violet-200">Template-ийн бичлэгүүдийг сонгоно уу — текст, лого байрандаа үлдэнэ.</p>
          {slots.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onFillMedia(m.id)}
              className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-violet-400/60 p-2 text-left transition hover:bg-violet-500/15"
            >
              <span className="flex h-12 w-20 shrink-0 items-center justify-center rounded-md bg-violet-950/60 text-violet-300">
                <Replace className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-zinc-100">Бичлэг {i + 1} сонгох</span>
                <span className="block truncate text-[11px] text-zinc-500">
                  {m.info?.width}×{m.info?.height} хэмжээтэй байсан · {m.name}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {files.map((m) => (
          <MediaCard
            key={m.id}
            media={m}
            onAdd={() => onAddMediaToTimeline(m.id)}
            onRemove={() => onRemoveMedia(m.id)}
            onProxy={() => onBuildProxy(m.id)}
          />
        ))}
        {files.length === 0 && <p className="py-4 text-center text-xs text-zinc-600">Медиа алга байна</p>}
      </div>
    </div>
  );
}

function MediaCard({ media: m, onAdd, onRemove, onProxy }: { media: MediaItem; onAdd: () => void; onRemove: () => void; onProxy: () => void }) {
  const film = m.kind === "video" ? thumbsUrl(m, "film") : null;
  const picture = m.info?.isImage ? m.url : null;
  const frames = m.info?.duration ? Math.min(60, Math.max(8, Math.round(m.info.duration / 3))) : 1;
  const ready = !!m.source && !!m.info;
  const uploading = m.uploadProgress !== null && m.uploadProgress < 1;
  return (
    <div
      role="button"
      tabIndex={0}
      title={uploading ? "Байршуулж дуусмагц timeline руу нэмэгдэнэ" : "Дарж timeline руу нэмэх · чирж байрлуулах"}
      draggable={ready}
      onDragStart={(e) => {
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      // Clicking anywhere on the card adds it at the playhead (its own buttons handle themselves).
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button") || m.error) return;
        onAdd();
      }}
      onKeyDown={(e) => {
        // Enter only — Space stays the global play/pause shortcut even while the card has focus.
        if (e.key === "Enter" && e.target === e.currentTarget && !m.error) {
          e.preventDefault();
          e.stopPropagation();
          onAdd();
        }
      }}
      className={cx(
        "group flex cursor-pointer gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 outline-none transition",
        "hover:border-violet-500/70 hover:bg-violet-500/10 focus-visible:border-violet-500 active:scale-[0.99]",
        m.error && "cursor-default hover:border-zinc-800 hover:bg-zinc-900/60",
      )}
    >
      <div
        className="relative flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-800 bg-no-repeat"
        style={
          film
            ? { backgroundImage: `url(${film})`, backgroundSize: `${frames * 80}px 48px`, backgroundPosition: `-${Math.floor(frames / 3) * 80}px 0` }
            : picture
              ? { backgroundImage: `url(${picture})`, backgroundSize: "contain", backgroundPosition: "center" }
              : undefined
        }
      >
        {!film && !picture && (m.kind === "audio" ? <Music className="h-5 w-5 text-emerald-400" /> : <Video className="h-5 w-5 text-zinc-500" />)}
        {m.info?.duration != null && (
          <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 font-mono text-[9px] text-zinc-200">
            {timecode(m.info.duration).replace(/\.\d+$/, "")}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-zinc-100" title={m.name}>
          {m.name}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-zinc-500">
          {m.info?.isImage ? "Зураг · " : ""}
          {m.info?.width ? `${m.info.width}×${m.info.height} · ` : m.kind === "audio" ? "Аудио · " : ""}
          {formatBytes(m.size)}
        </div>
        {m.uploadProgress !== null && m.uploadProgress < 1 && <Bar label="Байршуулж байна" value={m.uploadProgress} />}
        {m.proxy.state === "building" && <Bar label="Урьдчилан харах хувилбар" value={m.proxy.progress / 100} />}
        {m.error && (
          <div className="mt-1 flex items-center gap-1 text-[11px] text-red-400">
            <AlertTriangle className="h-3 w-3" /> {m.error}
          </div>
        )}
      </div>
      <div className="flex flex-col items-center justify-between">
        <button
          type="button"
          onClick={onAdd}
          disabled={!ready}
          title="Playhead дээр timeline руу нэмэх"
          className="rounded-md bg-violet-600 p-1 text-white transition hover:bg-violet-500 disabled:opacity-30"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <div className="flex gap-0.5 opacity-0 transition group-hover:opacity-100">
          {ready && m.proxy.state !== "ready" && m.proxy.state !== "building" && (
            <button type="button" onClick={onProxy} title="Урьдчилан харах хувилбар үүсгэх (тоглохгүй бол)" className="rounded p-0.5 text-zinc-500 hover:text-zinc-200">
              <Wand2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button type="button" onClick={onRemove} title="Устгах" className="rounded p-0.5 text-zinc-500 hover:text-red-400">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div className="mt-1">
      <div className="flex justify-between text-[10px] text-zinc-500">
        <span>{label}</span>
        <span>{Math.round(value * 100)}%</span>
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full bg-violet-500 transition-all" style={{ width: `${value * 100}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text presets
// ---------------------------------------------------------------------------

function TextPanel({ onAddText }: { onAddText: Props["onAddText"] }) {
  const presets: { id: keyof typeof TEXT_PRESETS; label: string; className: string }[] = [
    { id: "title", label: "Гарчиг", className: "text-2xl font-bold [-webkit-text-stroke:1px_black]" },
    { id: "subtitle", label: "Хадмал текст", className: "bg-black/60 px-2 text-sm" },
    { id: "plain", label: "Энгийн текст", className: "text-base drop-shadow" },
  ];
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">Playhead байрлалд 3 секундын текст нэмнэ. Дараа нь timeline дээр уртасгаж болно.</p>
      {presets.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onAddText(p.id)}
          className="flex h-20 w-full items-center justify-center rounded-xl border border-zinc-800 bg-gradient-to-br from-zinc-800 to-zinc-900 text-white transition hover:border-violet-500"
        >
          <span className={p.className}>{p.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clip properties
// ---------------------------------------------------------------------------

function ClipPanel(props: Props) {
  const { selectedClips, mediaMap, onDelete, onToggleMute } = props;
  if (selectedClips.length === 0) {
    return <p className="py-8 text-center text-sm text-zinc-500">Timeline дээрх клипээ сонгоно уу</p>;
  }
  if (selectedClips.length > 1) {
    const ids = selectedClips.map((c) => c.id);
    return (
      <div className="space-y-3">
        <p className="text-sm text-zinc-300">{selectedClips.length} клип сонгосон</p>
        <div className="grid grid-cols-2 gap-2">
          <ActionButton icon={VolumeX} label="Дуу хаах/нээх" onClick={() => onToggleMute(ids)} />
          <ActionButton icon={Trash2} label="Устгах" danger onClick={() => onDelete(ids)} />
        </div>
      </div>
    );
  }
  const clip = selectedClips[0];
  if (clip.type === "text") return <TextClipPanel clip={clip} {...props} />;
  return <MediaClipPanel clip={clip} media={mediaMap.get(clip.mediaId)} {...props} />;
}

function MediaClipPanel({ clip, media, project, patchClip, onDetach, onDelete, onStartCrop, onReplaceClip }: Props & { clip: MediaClip; media: MediaItem | undefined }) {
  const [sub, setSub] = useState<"video" | "audio">(clip.type === "video" ? "video" : "audio");
  const still = !!media?.info?.isImage;
  const isVideo = clip.type === "video";
  const tab = isVideo && (still || sub === "video") ? "video" : "audio";
  const set = (patch: Partial<MediaClip>, key?: string) => patchClip(clip.id, patch, key ? `${key}:${clip.id}` : undefined);
  const { w: srcW, h: srcH } = sourceSize(media?.info, clip);
  const hasAudio = !!media?.info?.hasAudio;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="truncate text-base font-semibold text-white">{media?.name ?? "Клип"}</h2>
        <button type="button" onClick={() => onDelete([clip.id])} title="Устгах (Delete)" className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <p className="-mt-3 font-mono text-[11px] text-zinc-500">
        {timecode(clip.start)} → {timecode(clip.start + clipDuration(clip))} · эх {timecode(clip.in)}–{timecode(clip.out)}
      </p>

      <button
        type="button"
        onClick={() => onReplaceClip(clip.id)}
        className={cx(
          "flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm transition",
          media?.placeholder
            ? "bg-violet-600 font-semibold text-white hover:bg-violet-500"
            : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800",
        )}
      >
        <Replace className="h-4 w-4" />
        {media?.placeholder ? "Template-ийн бичлэгийг сонгох" : still ? "Зураг солих" : "Бичлэг солих"}
      </button>

      {isVideo && !still && (
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-zinc-800 bg-zinc-950 p-1">
          {(["video", "audio"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSub(s)}
              className={cx("rounded-lg py-1.5 text-sm transition", sub === s ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200")}
            >
              {s === "video" ? "Видео" : "Аудио"}
            </button>
          ))}
        </div>
      )}

      {tab === "video" && (
        <>
          <div className="grid grid-cols-5 gap-1.5">
            <IconTool icon={Shrink} label="Багтаах" onClick={() => set({ scale: 1, x: 0.5, y: 0.5 })} />
            <IconTool
              icon={Expand}
              label="Дүүргэх"
              onClick={() => set({ scale: coverScale(srcW, srcH, clip, project.aspect), x: 0.5, y: 0.5 })}
            />
            <IconTool icon={RotateCw} label="Эргүүлэх" onClick={() => set({ rotate: ((clip.rotate + 90) % 360) as Rotation })} />
            <IconTool icon={FlipHorizontal2} label="Хэвтээ" active={clip.flipH} onClick={() => set({ flipH: !clip.flipH })} />
            <IconTool icon={FlipVertical2} label="Босоо" active={clip.flipV} onClick={() => set({ flipV: !clip.flipV })} />
          </div>

          <Section icon={Move} title="Байрлал ба хэмжээ" onReset={() => set({ x: 0.5, y: 0.5, scale: 1 })}>
            <Slider label="Хэмжээ" value={clip.scale * 100} min={10} max={400} unit="%" onChange={(v) => set({ scale: v / 100 }, "scale")} />
            <Slider label="X" value={clip.x * 100} min={-50} max={150} unit="%" onChange={(v) => set({ x: v / 100 }, "x")} />
            <Slider label="Y" value={clip.y * 100} min={-50} max={150} unit="%" onChange={(v) => set({ y: v / 100 }, "y")} />
          </Section>

          <AspectSection clip={clip} media={media} set={set} />

          <Section icon={CropIcon} title="Тайрах (Crop)" onReset={() => set({ crop: NO_CROP })}>
            <button
              type="button"
              onClick={() => onStartCrop(clip.id)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-violet-500/50 bg-violet-500/10 py-2 text-sm text-violet-200 transition hover:bg-violet-500/20"
            >
              <CropIcon className="h-4 w-4" /> Дэлгэц дээр тайрах <kbd className="font-sans text-[11px] text-violet-300/70">C</kbd>
            </button>
            {(["l", "r", "t", "b"] as const).map((side) => (
              <Slider
                key={side}
                label={{ l: "Зүүн", r: "Баруун", t: "Дээд", b: "Доод" }[side]}
                value={clip.crop[side] * 100}
                min={0}
                max={90}
                unit="%"
                onChange={(v) => {
                  const other = { l: "r", r: "l", t: "b", b: "t" } as const;
                  const value = Math.min(v / 100, MAX_CROP - clip.crop[other[side]]);
                  set({ crop: { ...clip.crop, [side]: Math.max(0, value) } }, `crop-${side}`);
                }}
              />
            ))}
          </Section>

          {!still && (
            <Section icon={Gauge} title="Хурд">
              <SpeedChips clip={clip} set={set} />
            </Section>
          )}

          <Section title="Тунгалаг байдал (Opacity)">
            <Slider label="Opacity" value={clip.opacity * 100} min={0} max={100} unit="%" onChange={(v) => set({ opacity: v / 100 }, "opacity")} />
          </Section>

          <FrameSection clip={clip} set={set} />
        </>
      )}

      {tab === "audio" && (
        <>
          {!hasAudio && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">Энэ медиад дуу алга.</p>}
          {isVideo && clip.audioDetached && (
            <p className="rounded-lg bg-sky-500/10 px-3 py-2 text-xs text-sky-300">
              Дууг тусад нь салгасан — аудио track дээрх клипийг засна уу.
            </p>
          )}
          <Section icon={Volume2} title="Дуу">
            <Slider label="Түвшин" value={clip.volume * 100} min={0} max={200} unit="%" onChange={(v) => set({ volume: v / 100 }, "volume")} />
            <button
              type="button"
              onClick={() => set({ muted: !clip.muted })}
              className={cx(
                "flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
                clip.muted ? "border-red-500/50 bg-red-500/10 text-red-300" : "border-zinc-700 text-zinc-300 hover:border-zinc-500",
              )}
            >
              {clip.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              {clip.muted ? "Дуу хаалттай (M)" : "Дуу хаах (M)"}
            </button>
            {isVideo && (
              <button
                type="button"
                onClick={() => onDetach(clip.id)}
                disabled={!hasAudio || clip.audioDetached}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-sky-500 hover:text-white disabled:opacity-40"
              >
                <Unlink className="h-4 w-4" /> Аудиог салгах (D)
              </button>
            )}
          </Section>
          <Section title="Fade (бүдгэрэлт)">
            <Slider label="Эхэнд" value={clip.fadeIn} min={0} max={5} step={0.1} unit="с" onChange={(v) => set({ fadeIn: v }, "fadeIn")} />
            <Slider label="Төгсгөлд" value={clip.fadeOut} min={0} max={5} step={0.1} unit="с" onChange={(v) => set({ fadeOut: v }, "fadeOut")} />
          </Section>
          {!isVideo && (
            <Section icon={Gauge} title="Хурд">
              <SpeedChips clip={clip} set={set} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

const FRAME_PRESETS: { label: string; frame: ClipFrame | undefined }[] = [
  { label: "Байхгүй", frame: undefined },
  { label: "Цагаан", frame: { color: "#ffffff", opacity: 0.95, padding: 0.18, radius: 0.3 } },
  { label: "Хар", frame: { color: "#000000", opacity: 0.55, padding: 0.18, radius: 0.3 } },
  { label: "Булан", frame: { color: "#000000", opacity: 0, padding: 0, radius: 0.15 } },
];
const FRAME_COLORS = ["#ffffff", "#000000", "#18181b", "#f97316", "#7c3aed", "#facc15"];

/** Card behind the picture (a logo on a rounded panel) and rounded corners. */
function FrameSection({ clip, set }: { clip: MediaClip; set: (p: Partial<MediaClip>, key?: string) => void }) {
  const fr = clip.frame;
  const patch = (p: Partial<ClipFrame>, key?: string) => fr && set({ frame: { ...fr, ...p } }, key);
  const same = (a: ClipFrame | undefined, b: ClipFrame | undefined) => JSON.stringify(a) === JSON.stringify(b);
  return (
    <Section icon={SquareRoundCorner} title="Ар дэвсгэр ба булан" onReset={() => set({ frame: undefined })}>
      <div className="grid grid-cols-4 gap-1">
        {FRAME_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => set({ frame: p.frame })}
            className={cx(
              "rounded-lg border py-1.5 text-xs transition",
              same(fr, p.frame) ? "border-violet-500 bg-violet-500/20 text-white" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {fr && (
        <>
          <div className="flex items-center gap-1.5">
            {FRAME_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => patch({ color: c, opacity: fr.opacity || 0.8, padding: fr.opacity ? fr.padding : 0.18 })}
                className={cx("h-6 w-6 rounded-full border-2", fr.opacity > 0 && fr.color === c ? "border-violet-400" : "border-zinc-700")}
                style={{ background: c }}
                aria-label={c}
              />
            ))}
            <input type="color" value={fr.color} onChange={(e) => patch({ color: e.target.value }, "frame-color")} className="h-6 w-8 cursor-pointer rounded bg-transparent" />
          </div>
          <Slider label="Дэвсгэр" value={fr.opacity * 100} min={0} max={100} unit="%" onChange={(v) => patch({ opacity: v / 100 }, "frame-opacity")} />
          <Slider label="Зай" value={fr.padding * 100} min={0} max={60} unit="%" onChange={(v) => patch({ padding: v / 100 }, "frame-padding")} />
          <Slider label="Булан" value={fr.radius * 100} min={0} max={50} unit="%" onChange={(v) => patch({ radius: v / 100 }, "frame-radius")} />
        </>
      )}
    </Section>
  );
}

/** Fixes a film stretched to the wrong frame (people too wide or too thin) by showing its frame at another shape. */
function AspectSection({ clip, media, set }: { clip: MediaClip; media: MediaItem | undefined; set: (p: Partial<MediaClip>, key?: string) => void }) {
  const w = media?.info?.width;
  const h = media?.info?.height;
  if (!w || !h) return null;
  const native = w / h;
  const shape = clip.aspect ?? native;
  const height = Math.round((native / shape) * 100);
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  return (
    <Section icon={StretchVertical} title="Харьцаа засах" onReset={() => set({ aspect: undefined })}>
      <div className="grid grid-cols-3 gap-1">
        {[{ label: "Эх хэвээр", value: undefined as number | undefined }, ...ASPECT_PRESETS].map((p) => {
          const on = p.value === undefined ? clip.aspect === undefined : clip.aspect !== undefined && near(clip.aspect, p.value);
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => set({ aspect: p.value === undefined || near(p.value, native) ? undefined : p.value })}
              className={cx(
                "rounded-lg border py-1.5 text-xs transition",
                on ? "border-violet-500 bg-violet-500/20 text-white" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <Slider
        label="Өндөр — нүүр, бие хэвийн харагдтал"
        value={height}
        min={50}
        max={170}
        unit="%"
        onChange={(v) => set({ aspect: Math.abs(v - 100) < 0.5 ? undefined : native / (v / 100) }, "aspect")}
      />
      <p className="text-[11px] text-zinc-500">
        {clip.aspect ? (
          <>
            Эх {aspectLabel(native)} → <span className="text-violet-300">{aspectLabel(clip.aspect)}</span> болгож харуулна. Export-д ч мөн адил.
          </>
        ) : (
          "Сунасан бичлэгийг засна: хүмүүс бүдүүн, намхан харагдаж байвал ихэвчлэн 4:3 таарна."
        )}
      </p>
    </Section>
  );
}

function SpeedChips({ clip, set }: { clip: MediaClip; set: (p: Partial<MediaClip>) => void }) {
  return (
    <div className="grid grid-cols-5 gap-1">
      {SPEED_OPTIONS.map((s) => (
        <button
          key={s}
          type="button"
          // Keep the same source range; the clip gets shorter/longer on the timeline.
          onClick={() => set({ speed: s })}
          className={cx(
            "rounded-lg border py-1.5 text-xs transition",
            clip.speed === s ? "border-violet-500 bg-violet-500/20 text-white" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
          )}
        >
          {s}x
        </button>
      ))}
    </div>
  );
}

const TEXT_COLORS = ["#ffffff", "#facc15", "#f87171", "#34d399", "#60a5fa", "#000000"];

function TextClipPanel({ clip, project, patchClip, onDelete, onStyleAllText }: Props & { clip: TextClip }) {
  const set = (patch: Partial<TextClip>, key?: string) => patchClip(clip.id, patch, key ? `${key}:${clip.id}` : undefined);
  const fonts = useFontCatalog();
  const entry = fonts?.find((f) => f.family === clip.font);
  const canBold = !!entry?.files["700"];
  // Font size in pixels of a 1080p export (short side 1080), the size people usually think in.
  const refH = canvasSize(project.aspect, 1080).h;
  const px = Math.round(clip.size * refH);
  const setPx = (v: number) => set({ size: Math.min(0.5, Math.max(0.01, v / refH)) }, "size");
  const textCount = project.clips.filter((c) => c.type === "text").length;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold text-white">
          <Type className="h-4 w-4" /> Текст
        </h2>
        <button type="button" onClick={() => onDelete([clip.id])} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <textarea
        value={clip.text}
        onChange={(e) => set({ text: e.target.value }, "text")}
        rows={4}
        className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-violet-500"
        style={{ fontFamily: cssFontFamily(clip.font), fontWeight: clip.bold ? 700 : 400 }}
      />
      <Section title="Фонт">
        <div className="flex gap-1.5">
          <div className="min-w-0 flex-1">
            <FontPicker
              value={clip.font}
              sample={clip.text}
              onChange={(f) => set({ font: f?.family, bold: !!clip.bold && !!f?.files["700"] })}
            />
          </div>
          <button
            type="button"
            onClick={() => set({ bold: !clip.bold })}
            disabled={!canBold}
            title={canBold ? "Тод (Bold)" : "Энэ фонтод тод хувилбар алга"}
            className={cx(
              "w-10 shrink-0 rounded-lg border text-base font-bold transition disabled:opacity-30",
              clip.bold ? "border-violet-500 bg-violet-500/20 text-white" : "border-zinc-700 text-zinc-400 hover:border-zinc-500",
            )}
          >
            B
          </button>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-400">
            <span>Фонтын хэмжээ</span>
            <span className="flex items-center gap-1">
              <button type="button" onClick={() => setPx(px - 2)} className="h-5 w-5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">
                −
              </button>
              <input
                type="number"
                min={8}
                max={Math.round(refH / 2)}
                value={px}
                onChange={(e) => e.target.value && setPx(Number(e.target.value))}
                className="w-14 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-center font-mono text-xs text-zinc-100 outline-none focus:border-violet-500"
              />
              <button type="button" onClick={() => setPx(px + 2)} className="h-5 w-5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">
                +
              </button>
              <span className="text-zinc-500">px</span>
            </span>
          </div>
          <input
            type="range"
            min={12}
            max={Math.round(refH * 0.3)}
            value={px}
            onChange={(e) => setPx(Number(e.target.value))}
            className="w-full accent-violet-500"
          />
          <div className="mt-1 grid grid-cols-4 gap-1">
            {(
              [
                ["Жижиг", 0.035],
                ["Дунд", 0.055],
                ["Том", 0.08],
                ["Гарчиг", 0.12],
              ] as const
            ).map(([label, size]) => (
              <button
                key={label}
                type="button"
                onClick={() => set({ size })}
                className={cx(
                  "rounded-md border py-1 text-[11px] transition",
                  Math.abs(clip.size - size) < 0.002 ? "border-violet-500 bg-violet-500/20 text-white" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-zinc-600">1080p export дээрх хэмжээ; бусад нарийвчлалд харьцаагаараа өөрчлөгдөнө.</p>
        </div>
        {textCount > 1 && (
          <button
            type="button"
            onClick={() => onStyleAllText({ font: clip.font, bold: clip.bold, size: clip.size, color: clip.color })}
            className="w-full rounded-lg border border-zinc-800 py-1.5 text-xs text-zinc-400 transition hover:border-violet-500 hover:text-white"
          >
            Энэ фонт, хэмжээ, өнгийг бүх {textCount} текстэд хэрэглэх
          </button>
        )}
      </Section>
      <Section title="Загвар">
        <div className="grid grid-cols-3 gap-1">
          {TEXT_STYLES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => set({ style: s })}
              className={cx(
                "rounded-lg border py-1.5 text-xs transition",
                clip.style === s ? "border-violet-500 bg-violet-500/20 text-white" : "border-zinc-800 text-zinc-400 hover:border-zinc-600",
              )}
            >
              {{ box: "Дэвсгэртэй", outline: "Хүрээтэй", plain: "Сүүдэртэй" }[s]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {TEXT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => set({ color: c })}
              className={cx("h-6 w-6 rounded-full border-2", clip.color === c ? "border-violet-400" : "border-zinc-700")}
              style={{ background: c }}
              aria-label={c}
            />
          ))}
          <input type="color" value={clip.color} onChange={(e) => set({ color: e.target.value }, "color")} className="h-6 w-8 cursor-pointer rounded bg-transparent" />
        </div>
      </Section>
      <Section title="Байрлал">
        <div className="grid grid-cols-3 gap-1">
          {([["Дээд", 0.12], ["Төв", 0.5], ["Доод", 0.86]] as const).map(([label, y]) => (
            <button
              key={label}
              type="button"
              onClick={() => set({ x: 0.5, y })}
              className="rounded-lg border border-zinc-800 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-white"
            >
              {label}
            </button>
          ))}
        </div>
        <Slider label="X" value={clip.x * 100} min={0} max={100} unit="%" onChange={(v) => set({ x: v / 100 }, "x")} />
        <Slider label="Y" value={clip.y * 100} min={0} max={100} unit="%" onChange={(v) => set({ y: v / 100 }, "y")} />
      </Section>
      <Section title="Хугацаа">
        <Slider label="Үргэлжлэх" value={clip.duration} min={0.5} max={60} step={0.1} unit="с" onChange={(v) => set({ duration: v }, "duration")} />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

function Section({ icon: Icon, title, onReset, children }: { icon?: typeof Move; title: string; onReset?: () => void; children: ReactNode }) {
  return (
    <section className="space-y-2.5 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          {Icon && <Icon className="h-3.5 w-3.5" />} {title}
        </h3>
        {onReset && (
          <button type="button" onClick={onReset} className="text-[11px] text-zinc-500 hover:text-zinc-200">
            Анхны
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex justify-between text-[11px] text-zinc-400">
        <span>{label}</span>
        <span className="font-mono tabular-nums text-zinc-300">
          {step < 1 ? value.toFixed(1) : Math.round(value)}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-violet-500"
      />
    </label>
  );
}

function IconTool({ icon: Icon, label, active, onClick }: { icon: typeof Move; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cx(
        "flex flex-col items-center gap-1 rounded-xl border py-2 text-[10px] transition",
        active ? "border-violet-500 bg-violet-500/15 text-white" : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-white",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function ActionButton({ icon: Icon, label, danger, onClick }: { icon: typeof Move; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
        danger ? "border-red-500/40 text-red-300 hover:bg-red-500/10" : "border-zinc-700 text-zinc-300 hover:border-zinc-500",
      )}
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
}
