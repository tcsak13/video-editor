"use client";

import type { LucideIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, useEffect } from "react";
import { cx } from "./store";

export type MenuItem = {
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Draw a divider above this item. */
  separator?: boolean;
};

/** Right-click menu at (x, y); flips/clamps so it never leaves the window. */
export default function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, ready: false });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width > window.innerWidth - 8 ? Math.max(8, x - width) : x;
    const top = y + height > window.innerHeight - 8 ? Math.max(8, y - height) : y;
    setPos({ left, top, ready: true });
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof PointerEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("wheel", close, { passive: true, capture: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[100] min-w-60 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-2xl shadow-black/70"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
    >
      {items.map((item) => (
        <div key={item.label}>
          {item.separator && <div className="my-1 h-px bg-zinc-800" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={cx(
              "flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm transition disabled:cursor-default disabled:opacity-35",
              item.danger ? "text-zinc-200 enabled:hover:bg-red-500/15 enabled:hover:text-red-300" : "text-zinc-200 enabled:hover:bg-zinc-800",
            )}
          >
            <item.icon className="h-4 w-4 shrink-0 text-zinc-400" />
            <span className="flex-1">{item.label}</span>
            {item.shortcut && <kbd className="font-sans text-xs tracking-wider text-zinc-500">{item.shortcut}</kbd>}
          </button>
        </div>
      ))}
    </div>
  );
}
