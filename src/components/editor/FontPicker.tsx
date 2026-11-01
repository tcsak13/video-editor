"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cssFontFamily, type FontEntry } from "@/lib/fonts";
import { useFontCatalog } from "./fonts";
import { cx } from "./store";

const CATEGORIES = [
  { id: "", label: "Бүгд" },
  { id: "Sans Serif", label: "Sans" },
  { id: "Serif", label: "Serif" },
  { id: "Display", label: "Display" },
  { id: "Handwriting", label: "Гар бичмэл" },
  { id: "Monospace", label: "Mono" },
] as const;

/**
 * Searchable list of the downloaded Google Fonts, each name drawn in its own font with a sample of
 * the clip's text. Rows off-screen aren't rendered (content-visibility), so only visible fonts load.
 */
export default function FontPicker({
  value,
  sample,
  onChange,
}: {
  value: string | undefined;
  sample: string;
  onChange: (font: FontEntry | null) => void;
}) {
  const fonts = useFontCatalog();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey, true);
    // Bring the current font into view.
    listRef.current?.querySelector("[data-current]")?.scrollIntoView({ block: "center" });
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (fonts ?? []).filter((f) => (!category || f.category === category) && (!q || f.family.toLowerCase().includes(q)));
  }, [fonts, query, category]);

  const preview = (sample.split("\n")[0].trim() || "Сайн байна уу").slice(0, 28);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          // Each opening starts with a fresh search.
          setQuery("");
          setCategory("");
          setOpen((o) => !o);
        }}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-left transition hover:border-zinc-500"
      >
        <span className="truncate text-base text-zinc-100" style={{ fontFamily: cssFontFamily(value) }}>
          {value ?? "Үндсэн (Arial)"}
        </span>
        <ChevronDown className={cx("h-4 w-4 shrink-0 text-zinc-500 transition", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/60">
          <div className="space-y-2 border-b border-zinc-800 p-2">
            <label className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 focus-within:border-violet-500">
              <Search className="h-3.5 w-3.5 text-zinc-500" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={fonts ? `${fonts.length} фонтоос хайх…` : "Ачаалж байна…"}
                className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
              />
            </label>
            <div className="flex flex-wrap gap-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategory(c.id)}
                  className={cx(
                    "rounded-md px-2 py-0.5 text-[11px] transition",
                    category === c.id ? "bg-violet-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200",
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
            {!query && !category && (
              <FontRow label="Үндсэн (Arial)" family={undefined} preview={preview} current={!value} onPick={() => pick(null)} />
            )}
            {shown.map((f) => (
              <FontRow
                key={f.family}
                label={f.family}
                family={f.family}
                preview={preview}
                bold={!!f.files["700"]}
                current={value === f.family}
                onPick={() => pick(f)}
              />
            ))}
            {fonts?.length === 0 && (
              <p className="px-3 py-4 text-xs leading-relaxed text-zinc-400">
                Google фонтууд татагдаагүй байна. Интернэттэй үед терминалд <code className="rounded bg-zinc-800 px-1 text-zinc-200">npm run fonts</code>{" "}
                ажиллуулна уу (нэг удаа, ~100MB). Дараа нь бүрэн offline ажиллана.
              </p>
            )}
            {fonts && fonts.length > 0 && shown.length === 0 && <p className="px-3 py-4 text-xs text-zinc-500">Олдсонгүй</p>}
          </div>
        </div>
      )}
    </div>
  );

  function pick(f: FontEntry | null) {
    onChange(f);
    setOpen(false);
  }
}

function FontRow({
  label,
  family,
  preview,
  bold,
  current,
  onPick,
}: {
  label: string;
  family: string | undefined;
  preview: string;
  bold?: boolean;
  current: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      data-current={current || undefined}
      onClick={onPick}
      className={cx("flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-zinc-800", current && "bg-violet-500/15")}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 46px" }}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          {label}
          {bold && <b className="text-zinc-600">B</b>}
        </span>
        <span className="block truncate text-[17px] leading-snug text-zinc-100" style={{ fontFamily: cssFontFamily(family) }}>
          {preview}
        </span>
      </span>
      {current && <Check className="h-4 w-4 shrink-0 text-violet-400" />}
    </button>
  );
}
