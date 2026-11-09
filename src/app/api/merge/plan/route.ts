import fs from "node:fs/promises";
import { MERGE_QUALITIES, type MergeQuality } from "@/lib/merge";
import { planMerge } from "@/lib/server/merge";
import { jsonError, normalizeLocalPath, rejectNonLocal } from "@/lib/server/storage";

// POST /api/merge/plan { source, out, flat, quality } — what joining the parts under `source` would produce.
export async function POST(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { source?: unknown; out?: unknown; flat?: unknown; quality?: unknown } | null;
  if (typeof body?.source !== "string" || !body.source.trim()) return jsonError("Эх хавтас сонгоно уу.");
  if (typeof body.out !== "string" || !body.out.trim()) return jsonError("Гаралтын хавтас сонгоно уу.");
  const source = normalizeLocalPath(body.source);
  const out = normalizeLocalPath(body.out);
  const quality = MERGE_QUALITIES.includes(body.quality as MergeQuality) ? (body.quality as MergeQuality) : "copy";
  const st = await fs.stat(source).catch(() => null);
  if (!st?.isDirectory()) return jsonError(`Хавтас олдсонгүй: ${source}`, 404);

  // Absolute part paths stay on the server; the client only needs names and sizes.
  const { source: src, out: dst, groups, unmatched } = await planMerge(source, out, body.flat === true, quality);
  return Response.json({ source: src, out: dst, groups, unmatched });
}
