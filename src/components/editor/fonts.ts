"use client";

import { useEffect, useSyncExternalStore } from "react";
import { fontUrl, type FontEntry } from "@/lib/fonts";

// The catalog is fetched once; @font-face rules for every family are injected up front, and the
// browser only downloads a file when some text actually uses that family.
let catalog: FontEntry[] | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function injectFaces(fonts: FontEntry[]) {
  const css = fonts
    .flatMap((f) =>
      Object.entries(f.files).map(
        ([weight, file]) =>
          `@font-face{font-family:"GF ${f.family.replace(/"/g, "")}";font-weight:${weight};font-display:swap;src:url(${fontUrl(file)}) format("truetype")}`,
      ),
    )
    .join("\n");
  let el = document.getElementById("gf-faces");
  if (!el) {
    el = document.createElement("style");
    el.id = "gf-faces";
    document.head.appendChild(el);
  }
  el.textContent = css;
}

export function loadFonts(): Promise<void> {
  pending ??= fetch("/api/fonts")
    .then((r) => r.json())
    .then((d: { fonts?: FontEntry[] }) => d.fonts ?? [])
    .catch(() => [] as FontEntry[])
    .then((fonts) => {
      catalog = fonts;
      injectFaces(fonts);
      listeners.forEach((l) => l());
    });
  return pending;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Downloaded Google Fonts (null while loading, [] if `npm run fonts` hasn't been run). */
export function useFontCatalog(): FontEntry[] | null {
  useEffect(() => {
    void loadFonts();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => catalog,
    () => null,
  );
}
