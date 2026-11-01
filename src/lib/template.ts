// Saved templates: a project layout (text, logos, music, crop, canvas) whose main video(s) are slots
// to be filled with a new file. Shared by the editor and /api/templates. No Node imports.
import type { MediaInfo, SourceRef } from "@/lib/editor-options";
import type { Project } from "@/lib/timeline";

export type TemplateMedia = {
  id: string;
  name: string;
  size: number;
  kind: "video" | "audio";
  info: MediaInfo;
  /** Copy kept with the template; null for a slot (placeholder) that is filled when the template is used. */
  source: SourceRef | null;
  placeholder: boolean;
};

export type Template = {
  id: string;
  name: string;
  createdAt: number;
  project: Project;
  media: TemplateMedia[];
};
