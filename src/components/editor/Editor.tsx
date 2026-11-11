"use client";

import {
  ClipboardPaste,
  CopyPlus,
  Crop as CropIcon,
  Expand,
  FlipHorizontal2,
  FlipVertical2,
  Fullscreen,
  RotateCw,
  Eye,
  EyeOff,
  Type,
  Volume2,
  ChevronLeft,
  ChevronRight,
  Copy,
  FilePlus2,
  BringToFront,
  Combine,
  Keyboard,
  LayoutTemplate,
  Magnet,
  Maximize2,
  Pause,
  Play,
  Redo2,
  Replace,
  Scissors,
  SendToBack,
  Shrink,
  SkipBack,
  SkipForward,
  Trash2,
  Undo2,
  Unlink,
  Upload,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MEDIA_ACCEPT, type Encoder } from "@/lib/editor-options";
import type { Template } from "@/lib/template";
import {
  CANVAS_ASPECTS,
  FPS,
  clipEnd,
  coverScale,
  sourceSize,
  nearestAspect,
  projectDuration,
  type CanvasAspect,
  type Clip,
  type MediaClip,
  type Project,
  type Rotation,
  type TextClip,
} from "@/lib/timeline";
import ExportDialog from "./ExportDialog";
import Inspector, { type PanelTab } from "./Inspector";
import { buildProxy, mediaDuration, mediaFromInfo, probePath, sourceUrl, uploadFile, type MediaItem } from "./media";
import {
  addMedia,
  addText,
  canJoin,
  deleteClips,
  detachAudio,
  duplicateClips,
  editPoints,
  emptyProject,
  fitCanvasToClip,
  isFree,
  joinClips,
  linkedClips,
  moveTrack,
  newMediaClip,
  pasteClips,
  closeGap,
  replaceClipMedia,
  splitClips,
  trackRank,
  trimToPlayhead,
  uid,
  updateClip,
  TEXT_PRESETS,
} from "./ops";
import Preview from "./Preview";
import { loadFonts } from "./fonts";
import { Clock, cx, timecode, useClockPlaying, useClockTime, useProjectHistory } from "./store";
import Timeline, { HEADER_W, MAX_PPS, MIN_PPS, clampPps, type TimelineMenuRequest } from "./Timeline";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import ReplaceDialog from "./ReplaceDialog";
import TemplatesDialog from "./TemplatesDialog";

const STORAGE_KEY = "lve-timeline-project-v1";
// Editor is client-only (ssr: false), so navigator is available at module load.
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

type Saved = { project: Project; media: Omit<MediaItem, "url" | "uploadProgress" | "needsProxy" | "error">[] };

function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function restoreMedia(saved: Saved | null): MediaItem[] {
  return (saved?.media ?? [])
    .filter((m) => m.info && (m.source || m.placeholder))
    .map((m) => ({
      ...m,
      url: m.source ? sourceUrl(m.source) : null,
      uploadProgress: null,
      needsProxy: false,
      error: null,
      proxy: m.proxy?.state === "ready" ? m.proxy : { state: "none", progress: 0 },
    }));
}

export default function Editor() {
  const [saved] = useState(loadSaved);
  const { project, commit, undo, redo, reset, canUndo, canRedo } = useProjectHistory(() => saved?.project ?? emptyProject());
  const [mediaList, setMediaList] = useState<MediaItem[]>(() => restoreMedia(saved));
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState<PanelTab>("media");
  const [pps, setPps] = useState(40);
  const [snapping, setSnapping] = useState(true);
  const [timelineH, setTimelineH] = useState(300);
  const [exportOpen, setExportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Clipboard and playhead are snapshotted when the menu opens (refs can't be read during render).
  const [menu, setMenu] = useState<(TimelineMenuRequest & { canPaste: boolean; playhead: number; preview?: boolean }) | null>(null);
  /** On-screen crop editor for one video clip (the playhead is snapshotted to pick the frame shown). */
  const [crop, setCrop] = useState<{ clipId: string; time: number } | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  /** Clips whose file is being replaced (picker open). */
  const [replacing, setReplacing] = useState<{ ids: string[]; audio: boolean; slot: boolean } | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTargets = useRef<string[]>([]);
  const [caps, setCaps] = useState<{ encoders: Record<Encoder, boolean>; isMac: boolean } | null>(null);
  const [clock] = useState(() => new Clock());
  const clipboard = useRef<Clip[]>([]);
  const uploads = useRef(new Map<string, () => void>());
  /** Media clicked while still uploading; placed on the timeline when the upload finishes. */
  const pendingAdds = useRef(new Set<string>());

  const mediaMap = useMemo(() => new Map(mediaList.map((m) => [m.id, m])), [mediaList]);
  const mediaRef = useRef(mediaMap);
  useEffect(() => {
    mediaRef.current = mediaMap;
  }, [mediaMap]);
  const duration = projectDuration(project.clips);
  const selectedClips = useMemo(() => project.clips.filter((c) => selected.includes(c.id)), [project.clips, selected]);

  useEffect(() => {
    clock.setDuration(duration);
  }, [clock, duration]);

  useEffect(() => {
    void loadFonts(); // @font-face rules for the downloaded Google Fonts used by text clips
  }, []);

  useEffect(() => {
    fetch("/api/capabilities")
      .then((r) => r.json())
      .then((d) => setCaps({ encoders: d.encoders, isMac: d.platform === "darwin" }))
      .catch(() => setCaps(null));
  }, []);

  // Autosave (media references + project). Blob URLs aren't saved; uploads are re-read from the server.
  useEffect(() => {
    const id = setTimeout(() => {
      const data: Saved = {
        project,
        media: mediaList
          .filter((m) => m.info && (m.source || m.placeholder))
          .map((m) => ({
            id: m.id,
            name: m.name,
            size: m.size,
            kind: m.kind,
            source: m.source,
            info: m.info,
            proxy: m.proxy,
            placeholder: m.placeholder,
          })),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch {}
    }, 400);
    return () => clearTimeout(id);
  }, [project, mediaList]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(id);
  }, [toast]);

  // Drop selection entries whose clips were removed (undo, delete, …).
  const liveSelected = selected.filter((id) => project.clips.some((c) => c.id === id));

  const patchMedia = (id: string, patch: Partial<MediaItem>) =>
    setMediaList((list) => list.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  // --- media import -------------------------------------------------------------
  const placeMedia = useCallback(
    (m: MediaItem, at: number, trackId?: string | null) => {
      if (!m.info) return;
      let newId = "";
      commit((p) => {
        let base = p;
        // First video sets the canvas shape (e.g. a phone video → 9:16).
        if (p.clips.length === 0 && m.kind === "video" && !m.info?.isImage && m.info?.width && m.info.height) {
          base = { ...p, aspect: nearestAspect(m.info.width, m.info.height) };
        }
        const track = trackId ? base.tracks.find((t) => t.id === trackId) : undefined;
        const len = mediaDuration(m);
        if (track && track.kind === m.kind && !track.locked && isFree(base, track.id, at, at + len)) {
          const clip = newMediaClip(m, track.id, at);
          newId = clip.id;
          return { ...base, clips: [...base.clips, clip] };
        }
        const r = addMedia(base, m, at);
        newId = r.clipId;
        return r.project;
      });
      setSelected(newId ? [newId] : []);
    },
    [commit],
  );

  const ensureProxy = useCallback(async (m: MediaItem) => {
    if (!m.source || m.proxy.state === "building" || m.proxy.state === "ready") return;
    patchMedia(m.id, { proxy: { state: "building", progress: 0 }, needsProxy: false });
    try {
      const url = await buildProxy(m.source, (pct) => patchMedia(m.id, { proxy: { state: "building", progress: pct } }));
      patchMedia(m.id, { proxy: { state: "ready", progress: 100, url } });
    } catch (err) {
      patchMedia(m.id, { proxy: { state: "failed", progress: 0 }, error: err instanceof Error ? err.message : "Proxy алдаа" });
    }
  }, []);

  const uploadFiles = useCallback(
    (files: File[], dropAt?: number, onReady?: (m: MediaItem) => void) => {
      setTab("media");
      // Files dropped together land at the same time; placeOnTrack stacks them on separate tracks.
      for (const file of files) {
        const id = uid("m");
        const item: MediaItem = {
          id,
          name: file.name,
          size: file.size,
          kind: file.type.startsWith("audio/") ? "audio" : "video",
          source: null,
          info: null,
          url: URL.createObjectURL(file),
          uploadProgress: 0,
          proxy: { state: "none", progress: 0 },
          needsProxy: false,
          error: null,
        };
        setMediaList((list) => [...list, item]);
        const { promise, abort } = uploadFile(file, (f) => patchMedia(id, { uploadProgress: f }));
        uploads.current.set(id, abort);
        const at = dropAt;
        promise
          .then(({ id: uploadId, info }) => {
            const ready = mediaFromInfo(id, { kind: "upload", id: uploadId }, info);
            let needsProxy = false;
            setMediaList((list) =>
              list.map((m) => {
                if (m.id !== id) return m;
                needsProxy = m.needsProxy;
                // Keep the blob URL for instant local playback.
                return { ...ready, url: m.url, uploadProgress: 1, needsProxy: false };
              }),
            );
            if (needsProxy) void ensureProxy({ ...ready });
            if (onReady) onReady(ready);
            else if (at !== undefined) placeMedia(ready, at);
            else if (pendingAdds.current.delete(id)) {
              placeMedia(ready, clock.time);
              setToast("Timeline руу нэмлээ");
            }
          })
          .catch((err: Error) => {
            pendingAdds.current.delete(id);
            patchMedia(id, { error: err.message, uploadProgress: null });
          })
          .finally(() => uploads.current.delete(id));
      }
    },
    [clock, ensureProxy, placeMedia],
  );

  const addPath = useCallback(async (raw: string) => {
    const { path, info } = await probePath(raw);
    setMediaList((list) => [...list, mediaFromInfo(uid("m"), { kind: "path", path }, info)]);
  }, []);

  const onMediaError = useCallback(
    (mediaId: string) => {
      const m = mediaMap.get(mediaId);
      if (!m || m.proxy.state !== "none") return;
      if (m.source) void ensureProxy(m);
      else patchMedia(mediaId, { needsProxy: true });
    },
    [mediaMap, ensureProxy],
  );

  const removeMedia = (id: string) => {
    uploads.current.get(id)?.();
    commit((p) => deleteClips(p, p.clips.filter((c) => c.type !== "text" && c.mediaId === id).map((c) => c.id)));
    setMediaList((list) => list.filter((m) => m.id !== id));
  };

  // --- replacing files / templates ---------------------------------------------------
  const replaceWith = useCallback(
    (ids: string[], m: MediaItem) => {
      if (!m.info) return;
      const length = (id: string) => {
        const x = mediaRef.current.get(id);
        return x?.info?.isImage ? Infinity : (x?.info?.duration ?? Infinity);
      };
      commit((p) => replaceClipMedia(p, ids, m, length));
      setReplacing(null);
      setToast(`"${m.name}" орлоо — текст, лого байрандаа`);
    },
    [commit],
  );

  /** Clips that change together: a template slot's every clip, or a clip and its detached audio. */
  const replaceGroup = useCallback(
    (clipId: string) => {
      const clip = project.clips.find((c) => c.id === clipId);
      if (!clip || clip.type === "text") return [];
      return mediaMap.get(clip.mediaId)?.placeholder
        ? project.clips.filter((c) => c.type !== "text" && c.mediaId === clip.mediaId).map((c) => c.id)
        : linkedClips(project, clipId);
    },
    [mediaMap, project],
  );

  const openReplace = useCallback(
    (clipId: string) => {
      const clip = project.clips.find((c) => c.id === clipId);
      if (!clip || clip.type === "text") return;
      clock.pause();
      const ids = replaceGroup(clipId);
      const audio = clip.type === "audio";
      const hasCandidates = mediaList.some(
        (m) => !m.placeholder && m.source && m.info && m.id !== clip.mediaId && (audio ? m.info.hasAudio : m.kind === "video"),
      );
      if (!hasCandidates) {
        // Nothing in the library to choose from: go straight to the file picker.
        replaceTargets.current = ids;
        replaceInput.current?.click();
        return;
      }
      setReplacing({ ids, audio, slot: !!mediaMap.get(clip.mediaId)?.placeholder });
    },
    [clock, mediaList, mediaMap, project.clips, replaceGroup],
  );

  const fillMedia = (mediaId: string) => {
    const clip = project.clips.find((c) => c.type !== "text" && c.mediaId === mediaId);
    if (clip) openReplace(clip.id);
  };

  const applyTemplate = (t: Template) => {
    if (project.clips.length && !confirm(`"${t.name}" template-ээр шинэ төсөл эхлүүлэх үү? (Одоогийнхыг ⌘Z-ээр буцааж болно)`)) return;
    const ids = new Map(t.media.map((m) => [m.id, uid("m")]));
    const items: MediaItem[] = t.media.map((m) => ({
      id: ids.get(m.id)!,
      name: m.name,
      size: m.size,
      kind: m.kind,
      source: m.source,
      info: m.info,
      url: m.source ? sourceUrl(m.source) : null,
      uploadProgress: null,
      proxy: { state: "none", progress: 0 },
      needsProxy: false,
      error: null,
      placeholder: m.placeholder,
    }));
    const next: Project = {
      ...t.project,
      clips: t.project.clips.map((c) => (c.type === "text" ? c : { ...c, mediaId: ids.get(c.mediaId) ?? c.mediaId })),
    };
    setMediaList((list) => [...list, ...items]);
    commit(() => next);
    setSelected([]);
    setTemplatesOpen(false);
    setTab("media");
    clock.seek(0);
    const slots = items.filter((m) => m.placeholder).length;
    setToast(slots ? `"${t.name}" ачааллаа — ${slots} бичлэгээ сонгоно уу` : `"${t.name}" ачааллаа`);
  };

  const unfilledSlots = project.clips.some((c) => c.type !== "text" && mediaMap.get(c.mediaId)?.placeholder);

  // --- clip edits ------------------------------------------------------------------
  /** Patch a clip; if it got longer (speed/duration), later clips on its track slide right. */
  const patchClip = useCallback(
    (id: string, patch: Partial<MediaClip> | Partial<TextClip>, mergeKey?: string) => {
      commit((p) => {
        const before = p.clips.find((c) => c.id === id);
        if (!before) return p;
        const next = updateClip<Clip>(p, id, patch);
        const after = next.clips.find((c) => c.id === id)!;
        const grow = clipEnd(after) - clipEnd(before);
        if (grow <= 1e-6) return next;
        return {
          ...next,
          clips: next.clips.map((c) =>
            c.id !== id && c.trackId === before.trackId && c.start >= clipEnd(before) - 1e-3 ? { ...c, start: c.start + grow } : c,
          ),
        };
      }, mergeKey);
    },
    [commit],
  );

  /**
   * What "join" works on: the selected clips (a single selected clip takes the neighbour it continues
   * into), or with nothing selected the pieces that meet at the playhead. Detached audio joins along.
   */
  const joinTargets = useCallback(
    (ids: string[], time: number) => {
      const unlocked = (c: Clip) => !project.tracks.find((tr) => tr.id === c.trackId)?.locked;
      const withTwins = (cs: Clip[]) => [...new Set(cs.filter(unlocked).flatMap((c) => [c.id, ...linkedClips(project, c.id)]))];
      const base = project.clips.filter((c) => ids.includes(c.id));
      if (base.length) {
        const own = withTwins(base);
        if (joinClips(project, own).joined.length) return own;
        // Nothing to join inside the selection (one clip, or a clip and its audio): each takes its neighbour.
        return withTwins(
          base.flatMap((c) => {
            const partner = project.clips.find((x) => canJoin(c, x)) ?? project.clips.find((x) => canJoin(x, c));
            return partner ? [c, partner] : [c];
          }),
        );
      }
      const tol = Math.max(0.05, 8 / pps);
      return withTwins(
        project.clips
          .filter((a) => Math.abs(clipEnd(a) - time) <= tol)
          .flatMap((a) => {
            const b = project.clips.find((x) => canJoin(a, x));
            return b ? [a, b] : [];
          }),
      );
    },
    [pps, project],
  );

  const actions = useMemo(() => {
    const t = () => clock.time;
    const sel = () => project.clips.filter((c) => liveSelected.includes(c.id));
    return {
      split() {
        const time = t();
        const spanning = (c: Clip) => c.start < time - 0.01 && clipEnd(c) > time + 0.01;
        const unlocked = (c: Clip) => !project.tracks.find((tr) => tr.id === c.trackId)?.locked;
        let ids = sel().filter(spanning).map((c) => c.id);
        if (!ids.length) ids = project.clips.filter((c) => spanning(c) && unlocked(c)).map((c) => c.id);
        if (!ids.length) return setToast("Playhead дээр хуваах клип алга");
        commit((p) => splitClips(p, ids, time).project);
      },
      join(ids = liveSelected) {
        const r = joinClips(project, joinTargets(ids, t()));
        if (!r.joined.length) {
          return setToast(ids.length ? "Нийлүүлэх хэсэг алга: нэг бичлэгийн зэрэгцээ, тасралтгүй хэсгүүд байх ёстой" : "Playhead дээр нийлүүлэх зүсэлт алга");
        }
        commit(r.project);
        setSelected(r.joined);
        setToast("Хэсгүүдийг нэг болголоо · ⌘Z буцаана");
      },
      remove(ripple: boolean) {
        if (!liveSelected.length) return;
        commit((p) => deleteClips(p, liveSelected, ripple));
        setSelected([]);
      },
      duplicate() {
        if (!liveSelected.length) return;
        let created: string[] = [];
        commit((p) => {
          const r = duplicateClips(p, liveSelected);
          created = r.created;
          return r.project;
        });
        setSelected(created);
      },
      copy() {
        clipboard.current = sel();
        if (clipboard.current.length) setToast(`${clipboard.current.length} клип хуулсан`);
      },
      paste(at = t()) {
        if (!clipboard.current.length) return;
        let created: string[] = [];
        commit((p) => {
          const r = pasteClips(p, clipboard.current, at);
          created = r.created;
          return r.project;
        });
        setSelected(created);
      },
      detach(ids = liveSelected) {
        const targets = project.clips.filter((c) => ids.includes(c.id) && c.type === "video");
        const usable = targets.filter((c) => c.type === "video" && !c.audioDetached && mediaMap.get(c.mediaId)?.info?.hasAudio);
        if (!usable.length) return setToast(targets.length ? "Энэ клипэд салгах дуу алга" : "Видео клип сонгоно уу");
        commit((p) => usable.reduce((acc, c) => detachAudio(acc, c.id).project, p));
        setToast("Аудиог тусад нь салгалаа");
      },
      toggleMute(ids = liveSelected) {
        const targets = project.clips.filter((c): c is MediaClip => ids.includes(c.id) && c.type !== "text");
        if (!targets.length) return;
        const mute = targets.some((c) => !c.muted);
        commit((p) => ({ ...p, clips: p.clips.map((c) => (c.type !== "text" && ids.includes(c.id) ? { ...c, muted: mute } : c)) }));
        setToast(mute ? "Дууг хаалаа" : "Дууг нээлээ");
      },
      toggleHidden(ids = liveSelected) {
        const targets = project.clips.filter((c) => ids.includes(c.id) && c.type !== "audio");
        if (!targets.length) return;
        const hide = targets.some((c) => !c.hidden);
        const targetIds = new Set(targets.map((c) => c.id));
        commit((p) => ({ ...p, clips: p.clips.map((c) => (targetIds.has(c.id) ? { ...c, hidden: hide } : c)) }));
        setToast(hide ? "Клипийг нуулаа" : "Клипийг харууллаа");
      },
      trim(side: "start" | "end") {
        if (!liveSelected.length) return;
        commit((p) => trimToPlayhead(p, liveSelected, t(), side));
      },
      addText(preset: keyof typeof TEXT_PRESETS, at = t()) {
        let id = "";
        commit((p) => {
          const r = addText(p, at, preset);
          id = r.clipId;
          return r.project;
        });
        setSelected([id]);
        setTab("clip");
      },
      jumpEdit(dir: 1 | -1) {
        const pts = editPoints(project);
        const time = t();
        const target = dir > 0 ? pts.find((p) => p > time + 0.01) : [...pts].reverse().find((p) => p < time - 0.01);
        clock.seek(target ?? (dir > 0 ? duration : 0));
      },
    };
  }, [clock, commit, duration, joinTargets, liveSelected, mediaMap, project]);

  const startCrop = useCallback(
    (clipId?: string) => {
      const id = clipId ?? (liveSelected.length === 1 ? liveSelected[0] : undefined);
      const clip = project.clips.find((c) => c.id === id);
      const m = clip?.type === "video" ? mediaMap.get(clip.mediaId) : undefined;
      if (!clip || !m?.info?.hasVideo || m.placeholder) {
        setToast("Тайрахын тулд нэг видео клип сонгоно уу");
        return;
      }
      clock.pause();
      setSelected([clip.id]);
      setTab("clip");
      setCrop({ clipId: clip.id, time: clock.time });
    },
    [clock, liveSelected, mediaMap, project.clips],
  );

  /** Canvas = the picture of the given / selected / on-screen video clip (like "Fit canvas to content"). */
  const fitCanvas = useCallback(
    (clipId?: string) => {
      const t = clock.time;
      const order = new Map(project.tracks.map((tr, i) => [tr.id, i]));
      const videos = project.clips.filter((c): c is MediaClip => c.type === "video" && !!mediaMap.get(c.mediaId)?.info?.width);
      const onScreen = videos
        .filter((c) => !c.hidden && c.start <= t && clipEnd(c) > t)
        .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0));
      const clip =
        videos.find((c) => c.id === clipId) ??
        videos.find((c) => liveSelected.length === 1 && c.id === liveSelected[0]) ??
        onScreen[0] ??
        videos[0];
      const info = clip ? mediaMap.get(clip.mediaId)?.info : undefined;
      if (!clip || !info) {
        setToast("Канвасыг тааруулах видео клип алга");
        return;
      }
      const next = fitCanvasToClip(project, clip.id, info);
      commit((p) => fitCanvasToClip(p, clip.id, info));
      const cropped = clip.crop.l || clip.crop.r || clip.crop.t || clip.crop.b;
      setToast(`Канвас ${next.aspect} боллоо` + (cropped ? "" : " · хар хүрээг хасах бол C дарж тайрна уу"));
    },
    [clock, commit, liveSelected, mediaMap, project],
  );

  const zoom = useCallback((factor: number) => setPps((p) => clampPps(p * factor)), []);
  const zoomFit = useCallback(() => {
    const w = (document.querySelector("[data-timeline]")?.clientWidth ?? 1000) - HEADER_W - 16;
    setPps(clampPps(w / Math.max(5, duration)));
  }, [duration]);

  // --- keyboard shortcuts (by physical key, so they work on the Mongolian layout too) ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=true]")) {
        if (e.key === "Escape") target.blur();
        return;
      }
      if (exportOpen || crop || templatesOpen || replacing) return; // dialogs/crop editor handle their own keys
      const mod = e.metaKey || e.ctrlKey;
      const frame = 1 / FPS;
      const handled = () => e.preventDefault();

      if (mod) {
        switch (e.code) {
          case "KeyZ":
            handled();
            if (e.shiftKey) redo();
            else undo();
            return;
          case "KeyY":
            handled();
            redo();
            return;
          case "KeyD":
            handled();
            actions.duplicate();
            return;
          case "KeyC":
            actions.copy();
            return;
          case "KeyX":
            actions.copy();
            actions.remove(false);
            return;
          case "KeyV":
            handled();
            actions.paste();
            return;
          case "KeyA":
            handled();
            setSelected(project.clips.map((c) => c.id));
            return;
          case "KeyB":
            handled();
            actions.split();
            return;
          case "KeyS":
            handled(); // autosaved already; don't open the browser's save dialog
            setToast("Төсөл автоматаар хадгалагддаг");
            return;
        }
        return;
      }

      switch (e.code) {
        case "Space":
        case "KeyK":
          handled();
          clock.toggle();
          break;
        case "KeyS":
          handled();
          if (e.shiftKey) actions.join();
          else actions.split();
          break;
        case "Delete":
        case "Backspace":
          handled();
          actions.remove(e.shiftKey);
          break;
        case "ArrowLeft":
          handled();
          clock.seek(clock.time - (e.shiftKey ? 1 : frame));
          break;
        case "ArrowRight":
          handled();
          clock.seek(Math.min(duration, clock.time + (e.shiftKey ? 1 : frame)));
          break;
        case "ArrowUp":
          handled();
          actions.jumpEdit(-1);
          break;
        case "ArrowDown":
          handled();
          actions.jumpEdit(1);
          break;
        case "Home":
          handled();
          clock.seek(0);
          break;
        case "End":
          handled();
          clock.seek(duration);
          break;
        case "KeyJ":
          clock.seek(clock.time - 5);
          break;
        case "KeyL":
          clock.seek(Math.min(duration, clock.time + 5));
          break;
        case "KeyH":
          actions.toggleHidden();
          break;
        case "KeyM":
          actions.toggleMute();
          break;
        case "KeyD":
          actions.detach();
          break;
        case "KeyQ":
        case "BracketLeft":
          actions.trim("start");
          break;
        case "KeyW":
        case "BracketRight":
          actions.trim("end");
          break;
        case "KeyT":
          actions.addText("plain");
          break;
        case "KeyC":
          startCrop();
          break;
        case "KeyF":
          fitCanvas();
          break;
        case "KeyN":
          setSnapping((s) => !s);
          setToast(snapping ? "Соронзон наалт унтарлаа" : "Соронзон наалт асаалаа");
          break;
        case "Equal":
        case "NumpadAdd":
          zoom(1.25);
          break;
        case "Minus":
        case "NumpadSubtract":
          zoom(0.8);
          break;
        case "Backslash":
          zoomFit();
          break;
        case "Escape":
          setSelected([]);
          setHelpOpen(false);
          break;
        case "Slash":
          if (e.shiftKey) setHelpOpen((o) => !o);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, clock, crop, duration, exportOpen, fitCanvas, project.clips, redo, replacing, snapping, startCrop, templatesOpen, undo, zoom, zoomFit]);

  const selectFromPreview = useCallback(
    (id: string | null) => {
      setSelected(id ? [id] : []);
      if (id) setTab("clip");
    },
    [],
  );

  const onSelectTimeline = useCallback((ids: string[]) => {
    setSelected(ids);
    if (ids.length) setTab("clip");
  }, []);

  // Timeline/controls resize handle.
  const startResize = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = timelineH;
    const move = (ev: PointerEvent) => setTimelineH(Math.min(window.innerHeight * 0.7, Math.max(140, h0 - (ev.clientY - y0))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const selectedVideo = selectedClips.find((c) => c.type === "video");

  // --- right-click menu ----------------------------------------------------------------
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeCrop = useCallback(() => setCrop(null), []);
  const closeTemplates = useCallback(() => setTemplatesOpen(false), []);
  const closeReplace = useCallback(() => setReplacing(null), []);
  /** Template slot clip under the drop point (any track when trackId is null). */
  const slotAt = (time: number, trackId: string | null) =>
    project.clips.find(
      (c) =>
        c.type === "video" &&
        (!trackId || c.trackId === trackId) &&
        c.start <= time &&
        clipEnd(c) > time &&
        !!mediaMap.get(c.mediaId)?.placeholder,
    );
  const menuItems = (req: NonNullable<typeof menu>): MenuItem[] => {
    const paste: MenuItem = {
      label: "Буулгах",
      icon: ClipboardPaste,
      shortcut: `${MOD}V`,
      disabled: !req.canPaste,
      onSelect: () => actions.paste(req.clipId ? req.playhead : req.time),
    };
    if (!req.clipId) {
      const gap = req.gap;
      return [
        paste,
        { label: "Энд текст нэмэх", icon: Type, shortcut: "T", onSelect: () => actions.addText("plain", req.time) },
        ...(gap
          ? [
              {
                label: `Хоосон зайг устгах (${(gap.end - gap.start).toFixed(1)}с)`,
                icon: Trash2,
                shortcut: "⌫",
                danger: true,
                separator: true,
                onSelect: () => commit((p) => closeGap(p, gap)),
              },
            ]
          : []),
      ];
    }
    const ids = liveSelected.includes(req.clipId) ? liveSelected : [req.clipId];
    const clicked = project.clips.find((c) => c.id === req.clipId);
    const targets = project.clips.filter((c) => ids.includes(c.id));
    const time = req.playhead;
    const canSplit = targets.some((c) => c.start < time - 0.01 && clipEnd(c) > time + 0.01);
    const joinable = joinClips(project, joinTargets(ids, time)).joined.length > 0;
    // Layer order is per track: bringing a clip forward moves its whole track.
    const layer = clicked && clicked.type !== "audio" ? trackRank(project, clicked.trackId) : null;
    const layerItems: MenuItem[] =
      clicked && layer && layer.count > 1
        ? [
            {
              label: "Хамгийн урд гаргах",
              icon: BringToFront,
              separator: true,
              disabled: layer.index === 0,
              onSelect: () => commit((p) => moveTrack(p, clicked.trackId, "top")),
            },
            {
              label: "Хамгийн ард оруулах",
              icon: SendToBack,
              disabled: layer.index === layer.count - 1,
              onSelect: () => commit((p) => moveTrack(p, clicked.trackId, "bottom")),
            },
          ]
        : [];
    const visual = targets.filter((c) => c.type !== "audio");
    const media = targets.filter((c): c is MediaClip => c.type !== "text");
    const detachable = media.some((c) => c.type === "video" && !c.audioDetached && mediaMap.get(c.mediaId)?.info?.hasAudio);
    const allHidden = visual.length > 0 && visual.every((c) => c.hidden);
    const allMuted = media.length > 0 && media.every((c) => c.muted);
    // Right-click on the preview adds the picture tools first.
    const pic = req.preview ? project.clips.find((c): c is MediaClip => c.id === req.clipId && c.type === "video") : undefined;
    const picInfo = pic ? mediaMap.get(pic.mediaId)?.info : undefined;
    const picItems: MenuItem[] = pic
      ? [
          { label: "Тайрах (Crop)", icon: CropIcon, shortcut: "C", disabled: !picInfo?.hasVideo, onSelect: () => startCrop(pic.id) },
          { label: "Багтаах", icon: Shrink, onSelect: () => patchClip(pic.id, { scale: 1, x: 0.5, y: 0.5 }) },
          {
            label: "Дүүргэх",
            icon: Expand,
            onSelect: () =>
              patchClip(pic.id, { scale: coverScale(sourceSize(picInfo, pic).w, sourceSize(picInfo, pic).h, pic, project.aspect), x: 0.5, y: 0.5 }),
          },
          { label: "Канвасыг контентод тааруулах", icon: Fullscreen, shortcut: "F", onSelect: () => fitCanvas(pic.id) },
          { label: "90° эргүүлэх", icon: RotateCw, onSelect: () => patchClip(pic.id, { rotate: ((pic.rotate + 90) % 360) as Rotation }) },
          { label: "Хэвтээ толин", icon: FlipHorizontal2, onSelect: () => patchClip(pic.id, { flipH: !pic.flipH }) },
          { label: "Босоо толин", icon: FlipVertical2, onSelect: () => patchClip(pic.id, { flipV: !pic.flipV }) },
        ]
      : [];
    return [
      ...picItems,
      { label: "Хуваах", icon: Scissors, shortcut: "S", disabled: !canSplit, separator: picItems.length > 0, onSelect: actions.split },
      { label: "Нийлүүлэх", icon: Combine, shortcut: "⇧S", disabled: !joinable, onSelect: () => actions.join(ids) },
      { label: "Хувилах", icon: CopyPlus, shortcut: `${MOD}D`, separator: true, onSelect: actions.duplicate },
      { label: "Хуулах", icon: Copy, shortcut: `${MOD}C`, onSelect: actions.copy },
      paste,
      {
        label: allHidden ? "Харуулах" : "Нуух",
        icon: allHidden ? Eye : EyeOff,
        shortcut: "H",
        separator: true,
        disabled: !visual.length,
        onSelect: () => actions.toggleHidden(ids),
      },
      {
        label: allMuted ? "Дуу нээх" : "Дуу хаах",
        icon: allMuted ? Volume2 : VolumeX,
        shortcut: "M",
        disabled: !media.length,
        onSelect: () => actions.toggleMute(ids),
      },
      { label: "Аудиог салгах", icon: Unlink, shortcut: "D", disabled: !detachable, onSelect: () => actions.detach(ids) },
      {
        label: mediaMap.get(clicked?.type === "text" ? "" : (clicked?.mediaId ?? ""))?.placeholder ? "Бичлэг сонгох…" : "Бичлэг солих…",
        icon: Replace,
        disabled: !clicked || clicked.type === "text",
        onSelect: () => openReplace(req.clipId!),
      },
      ...layerItems,
      { label: "Устгах", icon: Trash2, shortcut: "⌫", danger: true, separator: true, onSelect: () => actions.remove(false) },
    ];
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#0b0b0f] text-zinc-200">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 text-xs font-black text-white">▶</div>
          <span className="hidden text-sm font-semibold text-white sm:inline">Видео засварлагч</span>
        </div>
        <div className="mx-2 h-5 w-px bg-zinc-800" />
        <IconBtn title="Буцаах (⌘Z)" onClick={undo} disabled={!canUndo}>
          <Undo2 className="h-4 w-4" />
        </IconBtn>
        <IconBtn title="Дахих (⌘⇧Z)" onClick={redo} disabled={!canRedo}>
          <Redo2 className="h-4 w-4" />
        </IconBtn>
        <div className="mx-2 h-5 w-px bg-zinc-800" />
        <label className="flex items-center gap-1.5 text-xs text-zinc-400">
          Хэлбэр
          <select
            value={project.aspect}
            onChange={(e) => {
              if (e.target.value === "fit") fitCanvas();
              else commit((p) => ({ ...p, aspect: e.target.value as CanvasAspect }));
            }}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-200 outline-none"
          >
            {CANVAS_ASPECTS.map((a) => (
              <option key={a} value={a}>
                {a}
                {a === "9:16" ? " (Reels)" : a === "16:9" ? " (YouTube)" : a === "1:1" ? " (Дөрвөлжин)" : a === "4:5" ? " (Instagram)" : ""}
              </option>
            ))}
            {!(CANVAS_ASPECTS as readonly string[]).includes(project.aspect) && <option value={project.aspect}>{project.aspect} (Контент)</option>}
            <option value="fit" disabled={!project.clips.some((c) => c.type === "video")}>
              ⤢ Контентод тааруулах (F)
            </option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-400" title="Дэвсгэр өнгө">
          Дэвсгэр
          <input
            type="color"
            value={project.background}
            onChange={(e) => commit((p) => ({ ...p, background: e.target.value }), "background")}
            className="h-6 w-7 cursor-pointer rounded bg-transparent"
          />
        </label>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => {
            clock.pause();
            setTemplatesOpen(true);
          }}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 transition hover:border-violet-500 hover:bg-violet-500/10"
        >
          <LayoutTemplate className="h-3.5 w-3.5 text-violet-400" /> Template
        </button>
        <IconBtn title="Товчлолууд (?)" onClick={() => setHelpOpen(true)}>
          <Keyboard className="h-4 w-4" />
        </IconBtn>
        <IconBtn
          title="Шинэ төсөл"
          onClick={() => {
            if (project.clips.length && !confirm("Одоогийн төслийг хаах уу? (Медиа сан хадгалагдана)")) return;
            reset(emptyProject());
            setSelected([]);
            clock.seek(0);
          }}
        >
          <FilePlus2 className="h-4 w-4" />
        </IconBtn>
        <Link href="/compress" className="rounded-lg px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-white">
          Хурдан шахах
        </Link>
        <Link href="/merge" className="rounded-lg px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-white">
          Хэсэг нийлүүлэх
        </Link>
        <Link href="/convert" className="rounded-lg px-2 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-white">
          Олноор хөрвүүлэх
        </Link>
        <button
          type="button"
          onClick={() => {
            clock.pause();
            if (unfilledSlots) {
              setTab("media");
              setToast("Эхлээд template-ийн бичлэгээ сонгоно уу");
              return;
            }
            setExportOpen(true);
          }}
          disabled={!project.clips.length}
          className="flex items-center gap-1.5 rounded-lg bg-amber-400 px-4 py-1.5 text-sm font-bold text-zinc-950 transition hover:bg-amber-300 disabled:opacity-40"
        >
          <Upload className="h-4 w-4" /> Экспорт
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[330px] shrink-0 border-r border-zinc-800 bg-zinc-950/60">
          <Inspector
            tab={tab}
            setTab={setTab}
            project={project}
            mediaList={mediaList}
            mediaMap={mediaMap}
            selectedClips={selectedClips}
            patchClip={patchClip}
            onUploadFiles={(files) => uploadFiles(files)}
            onAddPath={addPath}
            onAddMediaToTimeline={(id) => {
              const m = mediaMap.get(id);
              if (!m) return;
              if (!m.source || !m.info) {
                pendingAdds.current.add(id);
                setToast("Байршуулж дуусмагц timeline руу нэмэгдэнэ");
                return;
              }
              placeMedia(m, clock.time);
              setToast("Timeline руу нэмлээ");
            }}
            onRemoveMedia={removeMedia}
            onBuildProxy={(id) => {
              const m = mediaMap.get(id);
              if (m) void ensureProxy(m);
            }}
            onAddText={actions.addText}
            onDetach={(id) => actions.detach([id])}
            onDelete={(ids) => {
              commit((p) => deleteClips(p, ids));
              setSelected([]);
            }}
            onToggleMute={(ids) => actions.toggleMute(ids)}
            onStartCrop={startCrop}
            onFillMedia={fillMedia}
            onReplaceClip={openReplace}
            onStyleAllText={(patch) => {
              commit((p) => ({ ...p, clips: p.clips.map((c) => (c.type === "text" ? { ...c, ...patch } : c)) }));
              setToast("Бүх текстэд хэрэглэлээ");
            }}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 bg-[#101015] p-4">
            <Preview
              project={project}
              media={mediaMap}
              clock={clock}
              selected={liveSelected}
              onSelect={selectFromPreview}
              onChangeClip={patchClip}
              onMediaError={onMediaError}
              onContextMenu={(x, y, clipId) => {
                clock.pause();
                if (!liveSelected.includes(clipId)) setSelected([clipId]);
                setTab("clip");
                setMenu({ x, y, clipId, gap: null, time: clock.time, preview: true, canPaste: clipboard.current.length > 0, playhead: clock.time });
              }}
              crop={crop}
              onCropApply={(id, c, fit) => {
                const clip = project.clips.find((x) => x.id === id);
                const info = clip?.type === "video" ? mediaMap.get(clip.mediaId)?.info : undefined;
                commit((p) => {
                  const next = updateClip<Clip>(p, id, { crop: c });
                  return fit && info ? fitCanvasToClip(next, id, info) : next;
                });
                setCrop(null);
                setToast(fit ? "Тайраад канвасыг тааруулав" : "Тайрлаа");
              }}
              onCropCancel={closeCrop}
              onFillPlaceholder={openReplace}
            />
          </div>

          {/* Transport / edit controls */}
          <div className="relative flex h-12 shrink-0 items-center gap-1 border-y border-zinc-800 bg-zinc-950 px-3">
            <div onPointerDown={startResize} className="absolute inset-x-0 -top-1 h-2 cursor-ns-resize" title="Чирж timeline-ийн өндрийг өөрчлөх" />
            <IconBtn title="Хуваах (S)" onClick={actions.split}>
              <Scissors className="h-4 w-4" />
            </IconBtn>
            <IconBtn title="Хуваасан хэсгүүдийг нийлүүлэх (⇧S)" onClick={() => actions.join()}>
              <Combine className="h-4 w-4" />
            </IconBtn>
            <IconBtn title="Хувилах (⌘D)" onClick={actions.duplicate} disabled={!liveSelected.length}>
              <Copy className="h-4 w-4" />
            </IconBtn>
            <IconBtn title="Устгах (Delete) · ⇧Delete: зайг хаах" onClick={() => actions.remove(false)} disabled={!liveSelected.length}>
              <Trash2 className="h-4 w-4" />
            </IconBtn>
            <div className="mx-1 h-5 w-px bg-zinc-800" />
            <IconBtn title="Аудиог салгах (D)" onClick={() => actions.detach()} disabled={!selectedVideo}>
              <Unlink className="h-4 w-4" />
            </IconBtn>
            <IconBtn title="Дуу хаах/нээх (M)" onClick={() => actions.toggleMute()} disabled={!liveSelected.length}>
              <VolumeX className="h-4 w-4" />
            </IconBtn>

            <Transport clock={clock} duration={duration} onJump={actions.jumpEdit} />

            <IconBtn title={`Соронзон наалт (N) — ${snapping ? "асаалттай" : "унтраалттай"}`} onClick={() => setSnapping((s) => !s)} active={snapping}>
              <Magnet className="h-4 w-4" />
            </IconBtn>
            <IconBtn title="Жижигрүүлэх (−)" onClick={() => zoom(0.8)}>
              <ZoomOut className="h-4 w-4" />
            </IconBtn>
            <input
              type="range"
              min={0}
              max={100}
              step={0.1}
              value={(Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 100}
              onChange={(e) => setPps(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, Number(e.target.value) / 100))}
              className="w-28 accent-zinc-300"
              aria-label="Timeline zoom"
            />
            <IconBtn title="Томруулах (+)" onClick={() => zoom(1.25)}>
              <ZoomIn className="h-4 w-4" />
            </IconBtn>
            <IconBtn title="Бүтэн харах (\)" onClick={zoomFit}>
              <Maximize2 className="h-4 w-4" />
            </IconBtn>
          </div>

          <div data-timeline className="shrink-0" style={{ height: timelineH }}>
            <Timeline
              project={project}
              media={mediaMap}
              clock={clock}
              selected={liveSelected}
              setSelected={onSelectTimeline}
              commit={commit}
              pps={pps}
              setPps={setPps}
              snapping={snapping}
              onDropMedia={(mediaId, trackId, time) => {
                const m = mediaMap.get(mediaId);
                if (!m) return;
                const slot = slotAt(time, trackId);
                if (slot && m.kind === "video" && m.info) replaceWith(replaceGroup(slot.id), m);
                else placeMedia(m, time, trackId);
              }}
              onDropFiles={(files, time) => {
                // A file dropped on a template slot fills it; anything else is added as usual.
                const slot = slotAt(time, null);
                if (!slot) return uploadFiles(files, time);
                const ids = replaceGroup(slot.id);
                uploadFiles(files.slice(0, 1), undefined, (ready) => replaceWith(ids, ready));
                if (files.length > 1) uploadFiles(files.slice(1), time);
              }}
              onContextMenu={(req) => {
                clock.pause();
                // Right-clicking outside the current selection selects just that clip, like a left click.
                if (req.clipId && !liveSelected.includes(req.clipId)) setSelected([req.clipId]);
                if (!req.clipId) setSelected([]);
                setMenu({ ...req, canPaste: clipboard.current.length > 0, playhead: clock.time });
              }}
            />
          </div>
        </main>
      </div>

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        project={project}
        mediaList={mediaList}
        encoders={caps?.encoders ?? null}
        isMac={caps?.isMac ?? false}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={closeMenu} />}
      {templatesOpen && <TemplatesDialog project={project} mediaMap={mediaMap} onUse={applyTemplate} onClose={closeTemplates} />}
      {replacing && (
        <ReplaceDialog
          title={replacing.slot ? "Template-ийн бичлэг сонгох" : "Бичлэг солих"}
          candidates={mediaList.filter(
            (m) =>
              !m.placeholder &&
              m.source &&
              m.info &&
              !replacing.ids.some((id) => project.clips.find((c) => c.id === id && c.type !== "text" && c.mediaId === m.id)) &&
              (replacing.audio ? m.info.hasAudio : m.kind === "video"),
          )}
          onPick={(m) => replaceWith(replacing.ids, m)}
          onPickFile={() => {
            replaceTargets.current = replacing.ids;
            setReplacing(null);
            replaceInput.current?.click();
          }}
          onClose={closeReplace}
        />
      )}
      <input
        ref={replaceInput}
        type="file"
        accept={MEDIA_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const ids = replaceTargets.current;
          setToast("Байршуулж дуусмагц солигдоно…");
          uploadFiles([file], undefined, (ready) => replaceWith(ids, ready));
        }}
      />
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-zinc-800 px-4 py-2 text-sm text-white shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

function Transport({ clock, duration, onJump }: { clock: Clock; duration: number; onJump: (dir: 1 | -1) => void }) {
  const t = useClockTime(clock);
  const playing = useClockPlaying(clock);
  return (
    <div className="mx-auto flex items-center gap-2">
      <span className="w-20 text-right font-mono text-sm tabular-nums text-zinc-300">{timecode(t)}</span>
      <IconBtn title="Өмнөх зүсэлт (↑)" onClick={() => onJump(-1)}>
        <SkipBack className="h-4 w-4" />
      </IconBtn>
      <IconBtn title="1 кадр буцах (←)" onClick={() => clock.seek(clock.time - 1 / FPS)}>
        <ChevronLeft className="h-4 w-4" />
      </IconBtn>
      <button
        type="button"
        title="Тоглуулах / Зогсоох (Space)"
        onClick={() => clock.toggle()}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-zinc-950 transition hover:scale-105"
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>
      <IconBtn title="1 кадр урагшлах (→)" onClick={() => clock.seek(Math.min(duration, clock.time + 1 / FPS))}>
        <ChevronRight className="h-4 w-4" />
      </IconBtn>
      <IconBtn title="Дараагийн зүсэлт (↓)" onClick={() => onJump(1)}>
        <SkipForward className="h-4 w-4" />
      </IconBtn>
      <span className="w-20 font-mono text-sm tabular-nums text-zinc-500">{timecode(duration)}</span>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  active,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "rounded-lg p-2 transition disabled:opacity-30 disabled:hover:bg-transparent",
        active ? "bg-violet-500/20 text-violet-200" : "text-zinc-400 hover:bg-zinc-800 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Space / K", "Тоглуулах / зогсоох"],
  ["S  (⌘B)", "Playhead дээр хуваах (сонгосон эсвэл бүх клип)"],
  ["⇧ S", "Хуваасан хэсгүүдийг буцааж нийлүүлэх (сонгосон эсвэл playhead дээрх)"],
  ["Delete / ⌫", "Сонгосныг устгах"],
  ["⇧ Delete", "Устгаад зайг хаах (ripple)"],
  ["Хоосон зай → 🗑 / Delete", "Хоосон зайг устгаж клипүүдийг урагшлуулах"],
  ["D", "Видеоны аудиог салгах"],
  ["M", "Дуу хаах / нээх"],
  ["H", "Клипийг нуух / харуулах"],
  ["Right-click", "Клип / preview дээр цэс (тайрах, хуваах, хувилах, нуух…)"],
  ["Q  /  [", "Эхлэлийг playhead хүртэл тайрах"],
  ["W  /  ]", "Төгсгөлийг playhead хүртэл тайрах"],
  ["⌘D", "Хувилах"],
  ["⌘C / ⌘X / ⌘V", "Хуулах / таслах / playhead дээр буулгах"],
  ["⌘A", "Бүгдийг сонгох"],
  ["⌘Z / ⌘⇧Z", "Буцаах / дахих"],
  ["← / →", "1 кадр (⇧: 1 секунд)"],
  ["J / L", "5 секунд буцах / урагшлах"],
  ["↑ / ↓", "Өмнөх / дараагийн зүсэлт рүү"],
  ["Home / End", "Эхлэл / төгсгөл"],
  ["T", "Текст нэмэх"],
  ["C", "Сонгосон видеог дэлгэц дээр тайрах (Enter: хэрэглэх, Esc: болих)"],
  ["F", "Канвасыг контентод тааруулах (видеоны яг өргөн/өндрөөр)"],
  ["N", "Соронзон наалт асаах/унтраах"],
  ["+ / − / \\", "Timeline томруулах / жижигрүүлэх / бүтэн"],
  ["Ctrl / ⌘ + scroll, pinch", "Timeline томруулах / жижигрүүлэх (хулганы байрлалд)"],
  ["⇧ + scroll", "Timeline-ийг хажуу тийш гүйлгэх"],
  ["Track нэр дээр ˄ / ˅", "Давхаргыг урагш / хойш (⇧: хамгийн урд / ард). Right-click → Хамгийн урд гаргах"],
  ["⇧ + click", "Олон клип сонгох"],
  ["Esc", "Сонголт цуцлах"],
];

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onPointerDown={onClose}>
      <div className="w-full max-w-xl rounded-2xl border border-zinc-800 bg-zinc-950 p-5" onPointerDown={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold text-white">
            <Keyboard className="h-5 w-5" /> Товчлолууд
          </h2>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">Монгол (кирилл) гарны байрлал дээр ч ажиллана. Windows дээр ⌘ = Ctrl.</p>
        <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-zinc-400">{v}</span>
              <kbd className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200">{k}</kbd>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
          <Shrink className="h-3.5 w-3.5" /> Preview дээр клипийг чирж байрлуулна, булангаас нь чирж томруулна.
        </div>
      </div>
    </div>
  );
}
