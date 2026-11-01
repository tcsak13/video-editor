"use client";

import { BookmarkPlus, Check, LayoutTemplate, Loader2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { aspectRatio, clipBoxSize, projectDuration, type Project } from "@/lib/timeline";
import { cssFontFamily } from "@/lib/fonts";
import type { Template } from "@/lib/template";
import { sourceUrl, type MediaItem } from "./media";
import { cx, timecode } from "./store";

/**
 * Save the current project as a reusable template (chosen videos become empty slots; logos, music
 * and text are kept), or start from a saved one.
 */
export default function TemplatesDialog({
  project,
  mediaMap,
  onUse,
  onClose,
}: {
  project: Project;
  mediaMap: Map<string, MediaItem>;
  onUse: (t: Template) => void;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Media used on the timeline; real videos default to "slot", pictures/audio are kept.
  const used = [...new Set(project.clips.flatMap((c) => (c.type === "text" ? [] : [c.mediaId])))]
    .map((id) => mediaMap.get(id))
    .filter((m): m is MediaItem => !!m?.info);
  const [slotIds, setSlotIds] = useState<Set<string>>(
    () => new Set(used.filter((m) => m.placeholder || (m.kind === "video" && !m.info?.isImage)).map((m) => m.id)),
  );
  const notReady = used.some((m) => !m.placeholder && !m.source);
  const missingSlot = used.some((m) => m.placeholder && !slotIds.has(m.id));

  useEffect(() => {
    let alive = true;
    fetch("/api/templates")
      .then((r) => r.json())
      .then((d) => alive && setTemplates(d.templates ?? []))
      .catch(() => alive && setLoadError("Template-уудыг уншиж чадсангүй."));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          project,
          media: used.map((m) => ({
            id: m.id,
            name: m.name,
            size: m.size,
            kind: m.kind,
            info: m.info,
            source: m.source,
            placeholder: slotIds.has(m.id),
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Template хадгалж чадсангүй.");
      setTemplates((list) => [data.template as Template, ...(list ?? [])]);
      setSavedId(data.template.id);
      setName("");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/templates?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    setTemplates((list) => (list ?? []).filter((t) => t.id !== id));
    setConfirmDelete(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onPointerDown={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <h2 className="flex items-center gap-2 text-lg font-bold text-white">
            <LayoutTemplate className="h-5 w-5 text-violet-400" /> Template-ууд
          </h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-zinc-500 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
          {/* Save current project */}
          <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <BookmarkPlus className="h-4 w-4 text-violet-400" /> Одоогийн төслийг template болгох
            </h3>
            {project.clips.length === 0 ? (
              <p className="text-xs text-zinc-500">Timeline хоосон байна — эхлээд текст, лого, бичлэгээ байрлуулна уу.</p>
            ) : (
              <>
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (name.trim() && !saving && !notReady && !missingSlot) void save();
                  }}
                >
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Нэр: жишээ нь Reels — лого + хадмал"
                    maxLength={80}
                    className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500"
                  />
                  <button
                    type="submit"
                    disabled={!name.trim() || saving || notReady || missingSlot}
                    className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-40"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookmarkPlus className="h-4 w-4" />} Хадгалах
                  </button>
                </form>

                {used.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-zinc-500">
                      Тэмдэглэсэн файл template-д <b className="text-violet-300">солигдох хоосон зай</b> болно. Бусад нь (лого, хөгжим)
                      template-тэй хамт хадгалагдана. Текст үргэлж хадгалагдана.
                    </p>
                    {used.map((m) => {
                      const on = slotIds.has(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          disabled={m.placeholder}
                          onClick={() =>
                            setSlotIds((s) => {
                              const n = new Set(s);
                              if (on) n.delete(m.id);
                              else n.add(m.id);
                              return n;
                            })
                          }
                          className={cx(
                            "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition",
                            on ? "border-violet-500/60 bg-violet-500/10" : "border-zinc-800 hover:bg-zinc-800/60",
                          )}
                        >
                          <span
                            className={cx(
                              "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                              on ? "border-violet-400 bg-violet-600" : "border-zinc-600",
                            )}
                          >
                            {on && <Check className="h-3 w-3 text-white" />}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-zinc-200">{m.name}</span>
                          <span className="shrink-0 text-zinc-500">
                            {m.info?.isImage ? "зураг" : m.kind === "audio" ? "аудио" : "видео"} · {on ? "солигдоно" : "хадгалагдана"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {notReady && <p className="text-xs text-amber-300">Байршуулалт дуусахыг хүлээнэ үү.</p>}
                {saveError && <p className="text-xs text-red-400">{saveError}</p>}
              </>
            )}
          </section>

          {/* Saved templates */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-100">Хадгалсан template-ууд</h3>
            {loadError && <p className="text-xs text-red-400">{loadError}</p>}
            {templates === null && !loadError && <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />}
            {templates?.length === 0 && <p className="text-xs text-zinc-500">Одоохондоо template алга.</p>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {templates?.map((t) => {
                const slots = t.media.filter((m) => m.placeholder).length;
                const texts = t.project.clips.filter((c) => c.type === "text").length;
                const logos = t.media.filter((m) => !m.placeholder && m.info.isImage).length;
                return (
                  <div
                    key={t.id}
                    className={cx(
                      "flex gap-3 rounded-xl border bg-zinc-900/50 p-3 transition",
                      savedId === t.id ? "border-violet-500" : "border-zinc-800",
                    )}
                  >
                    <TemplateThumb template={t} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="truncate text-sm font-medium text-zinc-100" title={t.name}>
                        {t.name}
                      </div>
                      <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
                        {t.project.aspect} · {timecode(projectDuration(t.project.clips)).replace(/\.\d+$/, "")}
                        <br />
                        {slots} бичлэг · {texts} текст{logos ? ` · ${logos} лого` : ""}
                      </div>
                      <div className="mt-auto flex items-center gap-1.5 pt-2">
                        <button
                          type="button"
                          onClick={() => onUse(t)}
                          className="flex-1 rounded-lg bg-violet-600 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-500"
                        >
                          Ашиглах
                        </button>
                        <button
                          type="button"
                          onClick={() => (confirmDelete === t.id ? void remove(t.id) : setConfirmDelete(t.id))}
                          title="Устгах"
                          className={cx(
                            "rounded-lg px-2 py-1.5 text-xs transition",
                            confirmDelete === t.id ? "bg-red-600 text-white" : "text-zinc-500 hover:bg-zinc-800 hover:text-red-400",
                          )}
                        >
                          {confirmDelete === t.id ? "Устгах уу?" : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** Tiny layout sketch: slots as dashed boxes, logos as images, text as text. */
function TemplateThumb({ template }: { template: Template }) {
  const { project } = template;
  const ar = aspectRatio(project.aspect);
  const h = 96;
  const w = Math.min(96, h * ar);
  const ch = w / ar;
  const media = new Map(template.media.map((m) => [m.id, m]));
  const order = new Map(project.tracks.map((t, i) => [t.id, i]));
  const visuals = project.clips
    .filter((c) => c.type !== "audio")
    .sort((a, b) => (order.get(b.trackId) ?? 0) - (order.get(a.trackId) ?? 0));
  const seen = new Set<string>();
  return (
    <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-zinc-950">
      <div className="relative overflow-hidden rounded-sm" style={{ width: w, height: ch, background: project.background }}>
        {visuals.map((c) => {
          if (c.type === "text") {
            const key = `t:${c.text}:${c.x}:${c.y}`;
            if (seen.has(key)) return null;
            seen.add(key);
            return (
              <div
                key={c.id}
                className="absolute max-w-full -translate-x-1/2 -translate-y-1/2 truncate whitespace-nowrap font-bold"
                style={{
                  left: c.x * w,
                  top: c.y * ch,
                  fontSize: Math.max(5, c.size * ch),
                  color: c.color,
                  lineHeight: 1.1,
                  fontFamily: cssFontFamily(c.font),
                }}
              >
                {c.text.split("\n")[0]}
              </div>
            );
          }
          const m = media.get(c.mediaId);
          if (!m || c.type !== "video" || seen.has(c.mediaId)) return null;
          seen.add(c.mediaId);
          const box = clipBoxSize(m.info.width ?? 16, m.info.height ?? 9, c, w, ch);
          const style = { left: c.x * w - box.w / 2, top: c.y * ch - box.h / 2, width: box.w, height: box.h, opacity: c.opacity };
          if (m.placeholder) return <div key={c.id} className="absolute border border-dashed border-violet-400/80 bg-violet-900/40" style={style} />;
          if (m.info.isImage && m.source) {
            return (
              <div
                key={c.id}
                className="absolute bg-contain bg-center bg-no-repeat"
                style={{ ...style, backgroundImage: `url(${sourceUrl(m.source)})` }}
              />
            );
          }
          return <div key={c.id} className="absolute bg-zinc-700" style={style} />;
        })}
      </div>
    </div>
  );
}
