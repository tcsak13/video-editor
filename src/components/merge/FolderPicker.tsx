"use client";

import { ArrowUp, Check, CheckCircle2, ChevronRight, FileVideo, Folder, FolderOpen, FolderPlus, HardDrive, Loader2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FsEntry, FsFile, FsListing } from "@/lib/merge";
import { cx } from "@/components/editor/store";

/**
 * Browses folders on this machine through /api/fs (a browser file dialog can't return a real path).
 * With `onPickFile` it lists the videos too: each click adds one and the picker stays open.
 */
export default function FolderPicker({
  title,
  initial,
  allowCreate,
  onPick,
  onPickFile,
  picked,
  onClose,
}: {
  title: string;
  initial: string;
  allowCreate?: boolean;
  onPick?: (path: string) => void;
  onPickFile?: (file: FsFile) => void;
  /** Files already added, shown ticked. */
  picked?: Set<string>;
  onClose: () => void;
}) {
  const fileMode = !!onPickFile;
  const [roots, setRoots] = useState<FsEntry[]>([]);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [typed, setTyped] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);

  const open = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/fs?path=${encodeURIComponent(dir)}${fileMode ? "&files=1" : ""}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Хавтсыг нээж чадсангүй");
      setListing(data as FsListing);
      setTyped((data as FsListing).path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fileMode]);

  useEffect(() => {
    let alive = true;
    fetch("/api/fs")
      .then((r) => r.json())
      .then((data: { roots: FsEntry[] }) => {
        if (!alive) return;
        setRoots(data.roots);
        const start = initial || data.roots[0]?.path;
        if (start) open(start);
      })
      .catch(() => setError("Дискнүүдийг уншиж чадсангүй"));
    return () => {
      alive = false;
    };
  }, [initial, open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const createFolder = async () => {
    if (!listing || !newName?.trim()) return;
    const res = await fetch("/api/fs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: listing.path, name: newName }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data?.error ?? "Хавтас үүсгэж чадсангүй");
    setNewName(null);
    open(data.path);
  };

  const crumbs = listing ? breadcrumbs(listing.path) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex h-[min(640px,90vh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3.5">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-48 shrink-0 overflow-y-auto border-r border-zinc-800 p-2 sm:block">
            {roots.map((r) => (
              <button
                key={r.path}
                type="button"
                onClick={() => open(r.path)}
                className={cx(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition",
                  listing?.path === r.path ? "bg-violet-500/15 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
                )}
              >
                {r.path.startsWith("/Volumes") || /^[A-Z]:\\$/.test(r.path) || r.path.startsWith("/media") || r.path.startsWith("/mnt") ? (
                  <HardDrive className="h-4 w-4 shrink-0 text-amber-400" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-zinc-500" />
                )}
                <span className="truncate">{r.name}</span>
              </button>
            ))}
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <form
              className="flex items-center gap-2 border-b border-zinc-800 p-2"
              onSubmit={(e) => {
                e.preventDefault();
                open(typed);
              }}
            >
              <button
                type="button"
                title="Дээш"
                disabled={!listing?.parent}
                onClick={() => listing?.parent && open(listing.parent)}
                className="rounded-lg border border-zinc-800 p-1.5 text-zinc-400 transition hover:border-zinc-600 hover:text-white disabled:opacity-30"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-200 outline-none focus:border-violet-500"
              />
            </form>
            <div className="flex flex-wrap items-center gap-0.5 px-3 pt-2 text-xs text-zinc-500">
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center">
                  {i > 0 && <ChevronRight className="h-3 w-3" />}
                  <button type="button" onClick={() => open(c.path)} className="rounded px-1 py-0.5 hover:bg-zinc-800 hover:text-zinc-200">
                    {c.name}
                  </button>
                </span>
              ))}
            </div>

            <div className="relative min-h-0 flex-1 overflow-y-auto p-2">
              {loading && <Loader2 className="absolute right-4 top-3 h-4 w-4 animate-spin text-zinc-500" />}
              {error && <p className="m-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
              {listing?.dirs.map((d) => (
                <button
                  key={d.path}
                  type="button"
                  onClick={() => open(d.path)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 transition hover:bg-zinc-900"
                >
                  <Folder className="h-4 w-4 shrink-0 text-violet-400" />
                  <span className="truncate">{d.name}</span>
                </button>
              ))}
              {listing?.files?.map((f) => {
                const added = picked?.has(f.path);
                return (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => onPickFile?.(f)}
                    className={cx(
                      "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition",
                      added ? "bg-emerald-500/10 text-emerald-200" : "text-zinc-200 hover:bg-zinc-900",
                    )}
                  >
                    <FileVideo className={cx("h-4 w-4 shrink-0", added ? "text-emerald-400" : "text-sky-400")} />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span className="shrink-0 font-mono text-xs text-zinc-500">{f.size >= 1e9 ? `${(f.size / 1e9).toFixed(2)} GB` : `${Math.round(f.size / 1e6)} MB`}</span>
                    {added ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <span className="flex shrink-0 items-center gap-1 rounded-md bg-violet-600 px-2 py-0.5 text-xs font-medium text-white opacity-0 transition group-hover:opacity-100">
                        <Plus className="h-3 w-3" /> Нэмэх
                      </span>
                    )}
                  </button>
                );
              })}
              {listing && !listing.dirs.length && !listing.files?.length && !error && (
                <p className="px-3 py-6 text-center text-xs text-zinc-600">{fileMode ? "Видео файл, дэд хавтас алга" : "Дэд хавтас алга"}</p>
              )}
              {newName !== null && (
                <form
                  className="mt-1 flex items-center gap-2 rounded-lg bg-zinc-900 px-2.5 py-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    createFolder();
                  }}
                >
                  <FolderPlus className="h-4 w-4 shrink-0 text-violet-400" />
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setNewName(null))}
                    placeholder="Шинэ хавтасны нэр"
                    className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-zinc-600"
                  />
                  <button type="submit" className="rounded-md bg-violet-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-violet-500">
                    Үүсгэх
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 px-5 py-3">
          <p className="min-w-0 flex-1 truncate text-xs text-zinc-500">
            {fileMode
              ? `Файл дээр дарахад шууд нэмэгдэж хөрвүүлж эхэлнэ${picked?.size ? ` · ${picked.size} файл нэмсэн` : ""}`
              : listing
                ? listing.videos
                  ? `Энэ хавтсанд ${listing.videos} видео файл`
                  : "Энэ хавтсанд шууд видео файл алга (дэд хавтсуудыг мөн уншина)"
                : ""}
          </p>
          {allowCreate && listing && newName === null && (
            <button
              type="button"
              onClick={() => setNewName("final")}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-white"
            >
              <FolderPlus className="h-4 w-4" /> Шинэ хавтас
            </button>
          )}
          {fileMode ? (
            <button type="button" onClick={onClose} className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-violet-500">
              <Check className="h-4 w-4" /> Болсон
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 transition hover:text-white">
                Болих
              </button>
              <button
                type="button"
                disabled={!listing}
                onClick={() => listing && onPick?.(listing.path)}
                className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:opacity-40"
              >
                <Check className="h-4 w-4" /> Энэ хавтсыг сонгох
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A labelled button showing the chosen folder; opens the picker. */
export function FolderField({ label, hint, value, disabled, onBrowse }: { label: string; hint: string; value: string; disabled: boolean; onBrowse: () => void }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <button
        type="button"
        disabled={disabled}
        onClick={onBrowse}
        className="flex w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-left transition hover:border-violet-500 disabled:opacity-50"
      >
        {value.startsWith("/Volumes/") || /^[A-Z]:\\/.test(value) ? <HardDrive className="h-5 w-5 shrink-0 text-amber-400" /> : <FolderOpen className="h-5 w-5 shrink-0 text-violet-400" />}
        <span className={cx("min-w-0 flex-1 truncate text-sm", value ? "font-mono text-zinc-100" : "text-zinc-500")}>{value || "Сонгоогүй"}</span>
        <span className="shrink-0 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300">Сонгох</span>
      </button>
      <p className="mt-1.5 text-xs text-zinc-600">{hint}</p>
    </div>
  );
}

function breadcrumbs(p: string): FsEntry[] {
  const win = /^[A-Za-z]:\\/.test(p);
  const sep = win ? "\\" : "/";
  const parts = p.split(sep).filter(Boolean);
  const out: FsEntry[] = win ? [] : [{ name: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    if (!win) acc = `${acc}/${part}`;
    else acc = !acc ? `${part}\\` : acc.endsWith("\\") ? acc + part : `${acc}\\${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}
