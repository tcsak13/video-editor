// Google Fonts downloaded by `npm run fonts` (Mongolian Cyrillic only). Shared by UI and server; no Node imports.

export type FontEntry = {
  family: string;
  category: string; // "Sans Serif" | "Serif" | "Display" | "Handwriting" | "Monospace"
  files: { "400": string; "700"?: string };
};

export const FONT_FILE_RE = /^[a-z0-9-]+-(400|700)\.ttf$/;

export function fontUrl(file: string): string {
  return `/api/fonts?f=${encodeURIComponent(file)}`;
}

/** CSS font-family for a text clip; downloaded families get a prefix so a same-named system font can't win. */
export function cssFontFamily(font: string | undefined): string {
  return font ? `"GF ${font}", Arial, Helvetica, sans-serif` : "Arial, Helvetica, sans-serif";
}
