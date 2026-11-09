import { planConvert, readConvertOptions } from "@/lib/server/convert";
import { jsonError, rejectNonLocal } from "@/lib/server/storage";

// POST /api/convert/plan { sources, out, quality, copyFit } — every film under `sources` and what converting it would do.
export async function POST(request: Request) {
  const denied = rejectNonLocal(request);
  if (denied) return denied;

  const options = await readConvertOptions(await request.json().catch(() => null));
  if (typeof options === "string") return jsonError(options);

  // Absolute source paths stay on the server; the client only needs names and sizes.
  const { out, files } = await planConvert(options);
  return Response.json({ out, files });
}
